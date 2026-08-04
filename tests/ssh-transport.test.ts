import { afterEach, describe, expect, test } from "vite-plus/test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { callRemote } from "../src/ssh-transport.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Feature 1: SSH exec transport", () => {
  test("1.2 and 1.3 perform one call with the prompt only in stdin", async () => {
    const fixture = await createFixture(
      `printf '%s\n' '{"ok":true,"result":{"session_id":"S","status":"running"}}'`,
    );
    const prompt = "quote '\"\n$(touch bad); & |";

    const result = await callRemote(
      { host: "nas", bin: "/opt/claude-session" },
      "send",
      { id: "S", prompt },
      fixture.environment,
    );

    expect(result).toEqual({ session_id: "S", status: "running" });
    const argv = await readFile(join(fixture.home, "ssh-argv"), "utf8");
    expect(argv.trim().split("\n")).toEqual([
      "-o",
      "BatchMode=yes",
      "nas",
      "/opt/claude-session",
      "@transport",
    ]);
    expect(argv).not.toContain(prompt);
    expect(JSON.parse(await readFile(join(fixture.home, "ssh-stdin"), "utf8"))).toEqual({
      protocol_version: 1,
      operation: "send",
      input: { id: "S", prompt },
    });
  });

  test("1.5 maps an SSH connection failure without a local fallback", async () => {
    const fixture = await createFixture("exit 255");

    await expect(
      callRemote({ host: "nowhere", bin: "claude-session" }, "list", {}, fixture.environment),
    ).rejects.toMatchObject({ code: "host_unreachable", details: { host: "nowhere" } });
  });

  test("1.6 maps exit 127 to remote_cli_missing", async () => {
    const fixture = await createFixture("exit 127");

    await expect(
      callRemote({ host: "nas", bin: "/missing/cli" }, "list", {}, fixture.environment),
    ).rejects.toMatchObject({
      code: "remote_cli_missing",
      details: { host: "nas", path: "/missing/cli" },
    });
  });

  test("1.7 preserves a remote version_mismatch domain error", async () => {
    const fixture = await createFixture(
      `printf '%s\n' '{"ok":false,"error":{"code":"version_mismatch","message":"bad protocol","details":{"local_protocol_version":1,"remote_protocol_version":2}}}'`,
    );

    await expect(
      callRemote({ host: "nas", bin: "claude-session" }, "send", {}, fixture.environment),
    ).rejects.toMatchObject({ code: "version_mismatch", message: "bad protocol" });
  });
});

async function createFixture(responseScript: string) {
  const home = await mkdtemp(join(tmpdir(), "claude-session-ssh-"));
  temporaryDirectories.push(home);
  const bin = join(home, "bin");
  await mkdir(bin);
  const ssh = join(bin, "ssh");
  await writeFile(
    ssh,
    `#!/bin/sh
printf '%s\n' "$@" > "$HOME/ssh-argv"
cat > "$HOME/ssh-stdin"
${responseScript}
`,
  );
  await chmod(ssh, 0o755);
  return {
    home,
    environment: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}
