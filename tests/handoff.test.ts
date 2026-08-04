import { afterEach, describe, expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBundleArchive } from "../src/session-bundle.ts";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Feature 5: Handoff", () => {
  test("5.1 hands a local session to a remote host while preserving the source", async () => {
    const fixture = await createFixture({ localSession: "idle" });

    const result = await runCli(
      [
        "@run",
        `await argc.call.handoff({ id: 'session-1', to: 'nas', cwd: '/data/proj' })`,
        "--json",
      ],
      fixture.environment,
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      session_id: "session-1",
      status: "imported",
      host: "nas",
    });
    expect(await readFile(fixture.transcriptPath, "utf8")).toContain("original");
  });

  test("5.2 relays a bundle remote to remote through the orchestrator", async () => {
    const fixture = await createFixture();

    const result = await runCli(
      [
        "@run",
        `await argc.call.handoff({ id: 'session-1', from: 'devbox', to: 'nas', cwd: '/data/proj' })`,
        "--json",
      ],
      fixture.environment,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ session_id: "session-1", host: "nas" });
    expect(
      (await readFile(join(fixture.home, "transport-log"), "utf8")).trim().split("\n"),
    ).toEqual(["devbox:export", "nas:import"]);
  });

  test("5.3 forwards focus to the source closing export", async () => {
    const fixture = await createFixture();

    await runCli(
      [
        "@run",
        `await argc.call.handoff({ id: 'session-1', from: 'devbox', to: 'nas', focus: 'continue the refactor' })`,
        "--json",
      ],
      fixture.environment,
    );

    const request = JSON.parse(await readFile(join(fixture.home, "request-devbox"), "utf8"));
    expect(request.input.handoff).toBe("continue the refactor");
  });

  test("5.4 retains a mode-0600 bundle under XDG state when import fails", async () => {
    const fixture = await createFixture({ importFails: true });

    const result = await runCli(
      ["@run", `await argc.call.handoff({ id: 'session-1', from: 'devbox', to: 'nas' })`, "--json"],
      fixture.environment,
    );

    expect(result.stderr).toContain("code: cwd_not_found");
    expect(result.stderr).toContain("retained_bundle_path:");
    const handoffDirectory = join(fixture.home, "state", "claude-session", "handoffs");
    const names = await readdir(handoffDirectory);
    expect(names).toHaveLength(1);
    expect((await stat(join(handoffDirectory, names[0]!))).mode & 0o777).toBe(0o600);
  });

  test("5.5 refuses a running local source before contacting the target", async () => {
    const fixture = await createFixture({ localSession: "running" });

    const result = await runCli(
      ["@run", `await argc.call.handoff({ id: 'session-1', to: 'nas' })`, "--json"],
      fixture.environment,
    );

    expect(result.stderr).toContain("code: session_busy");
    await expect(stat(join(fixture.home, "transport-log"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

type FixtureOptions = { importFails?: boolean; localSession?: "idle" | "running" };

async function createFixture(options: FixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "claude-session-handoff-"));
  temporaryDirectories.push(home);
  const bin = join(home, "bin");
  const cwd = join(home, "project");
  const projectDirectory = join(home, ".claude", "projects", "-fixture");
  const transcriptPath = join(projectDirectory, "session-1.jsonl");
  await mkdir(bin);
  await mkdir(cwd);
  const bundle = createBundleArchive(
    {
      version: 1,
      protocol_version: 1,
      session_id: "session-1",
      source_host: "devbox",
      cwd: "/source/proj",
      exported_at: 10,
      tool_version: "0.1.0",
      handoff: false,
    },
    new Map([["transcript.jsonl", Buffer.from("remote transcript")]]),
  );
  const exportedResponse = JSON.stringify({
    ok: true,
    result: { bundle_base64: Buffer.from(bundle).toString("base64") },
  });
  const importedResponse = options.importFails
    ? JSON.stringify({
        ok: false,
        error: { code: "cwd_not_found", message: "missing cwd", details: { cwd: "/bad" } },
      })
    : JSON.stringify({
        ok: true,
        result: {
          session_id: "session-1",
          status: "imported",
          cwd: "/data/proj",
          lineage: { source_host: "devbox", source_cwd: "/source/proj", exported_at: 10 },
        },
      });
  await writeExecutable(
    join(bin, "ssh"),
    `#!/bin/sh
host="$3"
request=$(cat)
printf '%s' "$request" > "$HOME/request-$host"
case "$request" in
  *'"operation":"export"'*) operation=export; response='${exportedResponse}' ;;
  *'"operation":"import"'*) operation=import; response='${importedResponse}' ;;
  *) exit 90 ;;
esac
printf '%s:%s\n' "$host" "$operation" >> "$HOME/transport-log"
printf '%s\n' "$response"
`,
  );
  if (options.localSession) {
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(transcriptPath, "original local transcript\n");
    await writeFile(
      join(projectDirectory, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        entries: [{ sessionId: "session-1", fullPath: transcriptPath, projectPath: cwd }],
      }),
    );
  }
  const agentResponse = options.localSession
    ? `[{"sessionId":"session-1","status":"${options.localSession}","cwd":"${cwd}"}]`
    : "[]";
  await writeExecutable(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "agents" ]; then printf '%s\n' '${agentResponse}'; exit 0; fi
exit 64
`,
  );
  const config = join(home, ".config", "claude-session");
  await mkdir(config, { recursive: true });
  await writeFile(
    join(config, "hosts.json"),
    JSON.stringify({ version: 1, hosts: { nas: {}, devbox: {} } }),
  );
  return {
    home,
    transcriptPath,
    environment: {
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, "state"),
    },
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
