import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";

const hostEntryValidator = v.object({
  bin: v.optional(v.string()),
  includeInAllHosts: v.optional(v.boolean(), true),
});

const hostConfigValidator = v.object({
  version: v.literal(1),
  hosts: v.record(v.string(), hostEntryValidator),
});

export type HostTarget = {
  host: string;
  bin: string;
};

export type HostConfig = v.InferOutput<typeof hostConfigValidator>;

export async function loadHostConfig(
  environment: Record<string, string | undefined> = process.env,
): Promise<HostConfig> {
  const configHome = environment.XDG_CONFIG_HOME ?? join(environment.HOME ?? homedir(), ".config");
  const path = join(configHome, "claude-session", "hosts.json");
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return { version: 1, hosts: {} };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid hosts configuration: ${messageOf(error)}`);
  }
  const config = v.parse(hostConfigValidator, parsed);
  for (const [host, entry] of Object.entries(config.hosts)) {
    assertSafeHost(host);
    if (entry.bin !== undefined) assertSafeBinaryPath(entry.bin);
  }
  return config;
}

export function resolveHost(config: HostConfig, host: string): HostTarget {
  assertSafeHost(host);
  const entry = config.hosts[host];
  return { host, bin: entry?.bin ?? "claude-session" };
}

export function listFanoutHosts(config: HostConfig): HostTarget[] {
  return Object.entries(config.hosts)
    .filter((entry) => entry[1].includeInAllHosts)
    .map((entry) => resolveHost(config, entry[0]))
    .sort((left, right) => left.host.localeCompare(right.host));
}

export function assertSafeHost(host: string): void {
  if (host === "local" || !/^[A-Za-z0-9][A-Za-z0-9_.:@\-[\]]*$/.test(host) || host.includes("..")) {
    throw new Error(`Invalid SSH host: ${host}`);
  }
}

function assertSafeBinaryPath(path: string): void {
  if (!path.startsWith("/") || !/^\/[A-Za-z0-9_./+-]+$/.test(path) || path.includes("..")) {
    throw new Error(`Invalid remote binary path: ${path}`);
  }
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
