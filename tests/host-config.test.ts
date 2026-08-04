import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listFanoutHosts, loadHostConfig, resolveHost } from "../src/host-config.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Feature 1: Host addressing", () => {
  test("1.4 uses the configured remote binary path", async () => {
    const home = await createFixture({
      nas: { bin: "/home/user/.bun/bin/claude-session" },
    });

    const config = await loadHostConfig({ HOME: home });

    expect(resolveHost(config, "nas")).toEqual({
      host: "nas",
      bin: "/home/user/.bun/bin/claude-session",
    });
  });

  test("declared hosts fan out unless explicitly excluded", async () => {
    const home = await createFixture({
      nas: {},
      devbox: { includeInAllHosts: false },
    });

    const config = await loadHostConfig({ HOME: home });

    expect(listFanoutHosts(config)).toEqual([{ host: "nas", bin: "claude-session" }]);
  });

  test.each(["-ProxyCommand=bad", "bad host", "local", "host;touch-bad"])(
    "rejects unsafe or reserved host %s",
    async (host) => {
      const home = await createFixture({});
      const config = await loadHostConfig({ HOME: home });

      expect(() => resolveHost(config, host)).toThrow("Invalid SSH host");
    },
  );

  test("rejects a configured binary path that could be interpreted by a remote shell", async () => {
    const home = await createFixture({ nas: { bin: "/tmp/cli;touch /tmp/bad" } });

    await expect(loadHostConfig({ HOME: home })).rejects.toThrow("Invalid remote binary path");
  });
});

type HostFixture = Record<string, { bin?: string; includeInAllHosts?: boolean }>;

async function createFixture(hosts: HostFixture): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "claude-session-host-config-"));
  temporaryDirectories.push(home);
  const directory = join(home, ".config", "claude-session");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "hosts.json"), JSON.stringify({ version: 1, hosts }));
  return home;
}
