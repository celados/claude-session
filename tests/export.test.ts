import { afterEach, describe, expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBundleArchive, parseBundleArchive } from "../src/session-bundle.ts";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Feature 3: Export", () => {
  test("3.1 exports an idle transcript unmodified with resume sidecars", async () => {
    const fixture = await createLocalSessionFixture();
    const out = join(fixture.home, "session.tgz");

    const result = await runCli(
      ["@run", `await argc.call["export-session"]({ id: 'session-1', out: '${out}' })`, "--json"],
      fixture.environment,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const parsed = parseBundleArchive(await readFile(out));
    expect(parsed.manifest).toMatchObject({ session_id: "session-1", cwd: fixture.cwd });
    expect(parsed.files.get("transcript.jsonl")?.toString()).toBe(fixture.transcript);
    expect(parsed.files.get("sidecars/tool-results/result.txt")?.toString()).toBe("result");
  });

  test("3.2 refuses a running session without creating a bundle", async () => {
    const fixture = await createLocalSessionFixture({ status: "running" });
    const out = join(fixture.home, "busy.tgz");

    const result = await runCli(
      ["@run", `await argc.call["export-session"]({ id: 'session-1', out: '${out}' })`, "--json"],
      fixture.environment,
    );

    expect(result.stderr).toContain("code: session_busy");
    await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("3.3 waits for the closing turn before packaging", async () => {
    const fixture = await createLocalSessionFixture({ closingTurn: true });
    const out = join(fixture.home, "handoff.tgz");

    const result = await runCli(
      [
        "@run",
        `await argc.call["export-session"]({ id: 'session-1', out: '${out}', handoff: 'migrating to the NAS', handoffTimeoutMs: 3000 })`,
        "--json",
      ],
      fixture.environment,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const parsed = parseBundleArchive(await readFile(out));
    expect(parsed.manifest.handoff).toBe(true);
    expect(parsed.files.get("transcript.jsonl")?.toString()).toContain("Closing summary");
    expect(await readFile(join(fixture.home, "closing-prompt"), "utf8")).toContain(
      "migrating to the NAS",
    );
  });

  test("3.4 writes a remotely assembled bundle to an orchestrator-local path", async () => {
    const fixture = await createRemoteFixture();
    const out = join(fixture.home, "remote.tgz");

    const result = await runCli(
      [
        "@run",
        `await argc.call["export-session"]({ id: 'session-1', host: 'nas', out: '${out}' })`,
        "--json",
      ],
      fixture.environment,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(parseBundleArchive(await readFile(out)).manifest.session_id).toBe("session-1");
    expect(JSON.parse(await readFile(join(fixture.home, "remote-request"), "utf8"))).toMatchObject({
      operation: "export",
      input: { id: "session-1", sourceHost: "nas" },
    });
  });

  test("a closing-turn timeout aborts export without producing a bundle", async () => {
    const fixture = await createLocalSessionFixture({ closingTurn: true, closingDelaySeconds: 1 });
    const out = join(fixture.home, "timed-out.tgz");

    const result = await runCli(
      [
        "@run",
        `await argc.call["export-session"]({ id: 'session-1', out: '${out}', handoff: 'focus', handoffTimeoutMs: 10 })`,
        "--json",
      ],
      fixture.environment,
    );

    expect(result.stderr).toContain("code: handoff_timeout");
    await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("3.5 reports an unknown session without creating output", async () => {
    const fixture = await createLocalSessionFixture();
    const out = join(fixture.home, "missing.tgz");

    const result = await runCli(
      ["@run", `await argc.call["export-session"]({ id: 'missing', out: '${out}' })`, "--json"],
      fixture.environment,
    );

    expect(result.stderr).toContain("Claude session not found: missing");
    await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

type LocalFixtureOptions = {
  status?: string;
  closingTurn?: boolean;
  closingDelaySeconds?: number;
};

async function createLocalSessionFixture(options: LocalFixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "claude-session-export-"));
  temporaryDirectories.push(home);
  const bin = join(home, "bin");
  const cwd = join(home, "project");
  const projectDirectory = join(home, ".claude", "projects", "-fixture");
  const transcriptPath = join(projectDirectory, "session-1.jsonl");
  await mkdir(bin);
  await mkdir(cwd);
  await mkdir(join(projectDirectory, "session-1", "tool-results"), { recursive: true });
  const transcript = `${JSON.stringify({
    type: "user",
    uuid: "u1",
    sessionId: "session-1",
    message: { role: "user", content: "Work" },
  })}\n`;
  await writeFile(transcriptPath, transcript);
  await writeFile(join(projectDirectory, "session-1", "tool-results", "result.txt"), "result");
  await writeFile(
    join(projectDirectory, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      entries: [{ sessionId: "session-1", fullPath: transcriptPath, projectPath: cwd }],
    }),
  );
  const agents = options.status
    ? `[{"sessionId":"session-1","status":"${options.status}","cwd":"${cwd}"}]`
    : "[]";
  const closingBody = options.closingTurn
    ? `cat > "$HOME/closing-prompt"
sleep ${options.closingDelaySeconds ?? 0}
printf '%s\n' '{"type":"assistant","uuid":"a2","sessionId":"session-1","message":{"role":"assistant","content":"Closing summary"}}' >> '${transcriptPath}'
printf '%s\n' '{"session_id":"session-1","result":"done"}'`
    : "exit 64";
  await writeExecutable(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "agents" ]; then printf '%s\n' '${agents}'; exit 0; fi
${closingBody}
`,
  );
  return {
    home,
    cwd,
    transcript,
    environment: {
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      XDG_STATE_HOME: join(home, "state"),
    },
  };
}

async function createRemoteFixture() {
  const home = await mkdtemp(join(tmpdir(), "claude-session-remote-export-"));
  temporaryDirectories.push(home);
  const bin = join(home, "bin");
  await mkdir(bin);
  const bundle = createBundleArchive(
    {
      version: 1,
      protocol_version: 1,
      session_id: "session-1",
      source_host: "nas",
      cwd: "/data/project",
      exported_at: 1,
      tool_version: "0.1.0",
      handoff: false,
    },
    new Map([["transcript.jsonl", Buffer.from("transcript")]]),
  );
  const response = JSON.stringify({
    ok: true,
    result: {
      bundle_base64: Buffer.from(bundle).toString("base64"),
      manifest: parseBundleArchive(bundle).manifest,
    },
  });
  await writeExecutable(
    join(bin, "ssh"),
    `#!/bin/sh
cat > "$HOME/remote-request"
printf '%s\n' '${response}'
`,
  );
  const config = join(home, ".config", "claude-session");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "hosts.json"), JSON.stringify({ version: 1, hosts: { nas: {} } }));
  return {
    home,
    environment: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
  };
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function runCli(
  args: string[],
  environment: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn("bun", ["src/main.ts", ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...environment },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  return { exitCode, stdout, stderr };
}
