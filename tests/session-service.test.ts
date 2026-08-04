import { afterEach, describe, expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Feature 2: Remote verb semantics", () => {
  test("2.1 lists remote sessions tagged by host", async () => {
    const fixture = await createFixture(
      `cat > "$HOME/request"
printf '%s\n' '{"ok":true,"result":{"sessions":[{"id":"same","status":"idle"},{"id":"two","status":"idle"}]}}'`,
    );

    const result = await runCli(
      ["@run", "await argc.call.list({ all: true, host: 'nas' })", "--json"],
      fixture.environment,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout).sessions).toEqual([
      { id: "same", status: "idle", host: "nas" },
      { id: "two", status: "idle", host: "nas" },
    ]);
  });

  test("2.2 fans out by (host, session_id) and tolerates one host failure", async () => {
    const fixture = await createFixture(
      `host="$3"
cat > "$HOME/request-$host"
if [ "$host" = "devbox" ]; then exit 255; fi
printf '%s\n' '{"ok":true,"result":{"sessions":[{"id":"same","status":"idle"}]}}'`,
      {
        hosts: { nas: {}, devbox: {} },
        claudeAgents: '[{"sessionId":"same","status":"idle","cwd":"/tmp"}]',
      },
    );

    const result = await runCli(
      ["@run", "await argc.call.list({ all: false, allHosts: true })", "--json"],
      fixture.environment,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sessions: [
        expect.objectContaining({ id: "same", host: "local" }),
        expect.objectContaining({ id: "same", host: "nas" }),
      ],
      errors: [expect.objectContaining({ host: "devbox", code: "host_unreachable" })],
    });
  });

  test("2.3 sends interrupt only to the owning remote host", async () => {
    const fixture = await createFixture(
      `cat > "$HOME/request"
printf '%s\n' '{"ok":true,"result":{"session_id":"S","status":"interrupted","pid":99}}'`,
    );

    const result = await runCli(
      ["@run", "await argc.call.interrupt({ id: 'S', host: 'nas' })", "--json"],
      fixture.environment,
    );

    expect(JSON.parse(result.stdout)).toMatchObject({ status: "interrupted", host: "nas" });
    expect(JSON.parse(await readFile(join(fixture.home, "request"), "utf8"))).toMatchObject({
      operation: "interrupt",
      input: { id: "S" },
    });
  });

  test("2.4 a dropped wait can replay from the same cursor without a gap", async () => {
    const fixture = await createFixture(
      `cat > "$HOME/request"
if [ ! -f "$HOME/wait-dropped" ]; then touch "$HOME/wait-dropped"; exit 255; fi
printf '%s\n' '{"ok":true,"result":{"session_id":"S","status":"idle","timed_out":false,"cursor":"next","messages":[{"id":"m1","role":"assistant","text":"done"}]}}'`,
    );
    const command =
      "await argc.call.wait({ id: 'S', host: 'nas', after: 'cursor', timeoutMs: 10 })";

    const dropped = await runCli(["@run", command, "--json"], fixture.environment);
    const replayed = await runCli(["@run", command, "--json"], fixture.environment);

    expect(dropped.stderr).toContain("code: host_unreachable");
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      cursor: "next",
      messages: [{ id: "m1", text: "done" }],
      host: "nas",
    });
  });

  test("2.5 preserves session_busy from the owning host", async () => {
    const fixture = await createFixture(
      `cat >/dev/null
printf '%s\n' '{"ok":false,"error":{"code":"session_busy","message":"busy","details":{"session_id":"S"}}}'`,
    );

    const result = await runCli(
      ["@run", "await argc.call.send({ id: 'S', prompt: 'P', host: 'nas' })", "--json"],
      fixture.environment,
    );

    expect(result.stderr).toContain("code: session_busy");
    expect(result.stdout).toBe("");
  });
});

type FixtureOptions = {
  hosts?: Record<string, Record<string, unknown>>;
  claudeAgents?: string;
};

async function createFixture(sshBody: string, options: FixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "claude-session-service-"));
  temporaryDirectories.push(home);
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeExecutable(join(bin, "ssh"), `#!/bin/sh\n${sshBody}\n`);
  await writeExecutable(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "agents" ]; then printf '%s\n' '${options.claudeAgents ?? "[]"}'; exit 0; fi
exit 64
`,
  );
  const configDirectory = join(home, ".config", "claude-session");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "hosts.json"),
    JSON.stringify({ version: 1, hosts: options.hosts ?? { nas: {} } }),
  );
  return {
    home,
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
