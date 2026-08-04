import { afterEach, describe, expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { transcriptPathForSession } from "../src/claude-state.ts";
import { importSessionBundle } from "../src/migration-controller.ts";
import { createBundleArchive, type BundleManifestInput } from "../src/session-bundle.ts";
import { getSessionRecord } from "../src/session-registry.ts";

const temporaryDirectories: string[] = [];
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const originalEnvironment = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};

afterEach(async () => {
  restoreEnvironment();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Feature 4: Import", () => {
  test("4.1 preserves the session id, installs sidecars, and records lineage", async () => {
    const fixture = await createFixture();
    const bundle = fixture.bundle();

    const result = await importSessionBundle({ bundle });

    expect(result).toEqual({
      session_id: "session-1",
      status: "imported",
      cwd: fixture.cwd,
      lineage: { source_host: "devbox", source_cwd: fixture.cwd, exported_at: 42 },
    });
    const transcriptPath = transcriptPathForSession(fixture.cwd, "session-1");
    expect(await readFile(transcriptPath, "utf8")).toBe(fixture.transcript.toString());
    expect(
      await readFile(
        join(transcriptPath.slice(0, -".jsonl".length), "tool-results", "r.txt"),
        "utf8",
      ),
    ).toBe("result");
    expect(await getSessionRecord("session-1")).toMatchObject({
      session_id: "session-1",
      cwd: fixture.cwd,
      transcript_path: transcriptPath,
    });
  });

  test("4.3 remaps cwd in the registry without rewriting the transcript", async () => {
    const fixture = await createFixture({ recordedCwd: "/missing/source" });
    const targetCwd = join(fixture.home, "target");
    await mkdir(targetCwd);

    await importSessionBundle({ bundle: fixture.bundle(), cwd: targetCwd });

    expect(await readFile(transcriptPathForSession(targetCwd, "session-1"), "utf8")).toBe(
      fixture.transcript.toString(),
    );
    expect(await getSessionRecord("session-1")).toMatchObject({ cwd: targetCwd });
  });

  test("4.2 an imported session resumes through the session registry", async () => {
    const fixture = await createFixture();
    await importSessionBundle({ bundle: fixture.bundle() });
    const bin = join(fixture.home, "bin");
    await mkdir(bin);
    await writeExecutable(
      join(bin, "claude"),
      `#!/bin/sh
if [ "$1" = "agents" ]; then printf '%s\n' '[]'; exit 0; fi
[ "$1" = "--resume" ] || exit 70
[ "$2" = "session-1" ] || exit 71
cat > "$HOME/resume-prompt"
printf '%s\n' '{"session_id":"session-1","result":"continued"}'
`,
    );

    const result = await runCli(
      ["@run", `await argc.call.send({ id: 'session-1', prompt: 'continue' })`, "--json"],
      {
        HOME: fixture.home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: join(fixture.home, ".config"),
        XDG_STATE_HOME: join(fixture.home, "state"),
        CLAUDE_CONFIG_DIR: fixture.claudeConfig,
      },
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      session_id: "session-1",
      status: "running",
      cwd: fixture.cwd,
    });
    await waitForFile(join(fixture.home, "resume-prompt"));
    expect(await readFile(join(fixture.home, "resume-prompt"), "utf8")).toBe("continue");
  });

  test("4.7 refuses to overwrite an existing session", async () => {
    const fixture = await createFixture();
    await importSessionBundle({ bundle: fixture.bundle() });

    await expect(importSessionBundle({ bundle: fixture.bundle() })).rejects.toMatchObject({
      code: "import_conflict",
      details: { session_id: "session-1" },
    });
  });

  test("4.4 reports a missing recorded cwd without writing Claude state", async () => {
    const fixture = await createFixture({ recordedCwd: "/definitely/missing/claude-session" });

    await expect(importSessionBundle({ bundle: fixture.bundle() })).rejects.toMatchObject({
      code: "cwd_not_found",
    });
    await expect(stat(join(fixture.claudeConfig, "projects"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("honors CLAUDE_CONFIG_DIR for imported state", async () => {
    const fixture = await createFixture();

    await importSessionBundle({ bundle: fixture.bundle() });

    expect(transcriptPathForSession(fixture.cwd, "session-1")).toContain(fixture.claudeConfig);
  });

  test("4.6 streams a local bundle to a remote host while preserving its id", async () => {
    const fixture = await createFixture();
    const bin = join(fixture.home, "bin");
    const bundlePath = join(fixture.home, "bundle.tgz");
    await mkdir(bin);
    await writeFile(bundlePath, fixture.bundle());
    await writeExecutable(
      join(bin, "ssh"),
      `#!/bin/sh
cat > "$HOME/import-request"
printf '%s\n' '{"ok":true,"result":{"session_id":"session-1","status":"imported","cwd":"/data/proj","lineage":{"source_host":"devbox","source_cwd":"/source","exported_at":42}}}'
`,
    );
    const config = join(fixture.home, ".config", "claude-session");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "hosts.json"), JSON.stringify({ version: 1, hosts: { nas: {} } }));

    const result = await runCli(
      [
        "@run",
        `await argc.call["import-session"]({ bundle: '${bundlePath}', host: 'nas', cwd: '/data/proj' })`,
        "--json",
      ],
      {
        HOME: fixture.home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: join(fixture.home, ".config"),
      },
    );

    expect(JSON.parse(result.stdout)).toMatchObject({ session_id: "session-1", host: "nas" });
    const request = JSON.parse(await readFile(join(fixture.home, "import-request"), "utf8"));
    expect(request).toMatchObject({ operation: "import", input: { cwd: "/data/proj" } });
    expect(Buffer.from(request.input.bundle_base64, "base64")).toEqual(
      Buffer.from(await readFile(bundlePath)),
    );
  });
});

type FixtureOptions = { recordedCwd?: string };

async function createFixture(options: FixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "claude-session-import-"));
  temporaryDirectories.push(home);
  const cwd = join(home, "project");
  const claudeConfig = join(home, "custom-claude");
  await mkdir(cwd);
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.XDG_STATE_HOME = join(home, "state");
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const transcript = Buffer.from('{"sessionId":"session-1","cwd":"/source"}\n');
  const manifest: BundleManifestInput = {
    version: 1,
    protocol_version: 1,
    session_id: "session-1",
    source_host: "devbox",
    cwd: options.recordedCwd ?? cwd,
    exported_at: 42,
    tool_version: "0.1.0",
    handoff: false,
  };
  return {
    home,
    cwd,
    claudeConfig,
    transcript,
    bundle: () =>
      createBundleArchive(
        manifest,
        new Map([
          ["transcript.jsonl", transcript],
          ["sidecars/tool-results/r.txt", Buffer.from("result")],
        ]),
      ),
  };
}

function restoreEnvironment(): void {
  setEnvironment("HOME", originalEnvironment.HOME);
  setEnvironment("XDG_CONFIG_HOME", originalEnvironment.XDG_CONFIG_HOME);
  setEnvironment("XDG_STATE_HOME", originalEnvironment.XDG_STATE_HOME);
  setEnvironment("CLAUDE_CONFIG_DIR", originalEnvironment.CLAUDE_CONFIG_DIR);
}

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (true) {
    try {
      if ((await readFile(path)).byteLength > 0) return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
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
