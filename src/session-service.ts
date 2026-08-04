import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { listFanoutHosts, loadHostConfig, resolveHost, type HostTarget } from "./host-config.ts";
import {
  exportSessionBundle,
  importSessionBundle,
  writeExportBundle,
  type ImportSessionResult,
} from "./migration-controller.ts";
import {
  createSession,
  forkSession,
  interruptSession,
  listSessions,
  readSession,
  sendToSession,
  waitForSession,
} from "./session-controller.ts";
import { SessionControllerError } from "./session-error.ts";
import { handoffDirectory } from "./session-registry.ts";
import { callRemote } from "./ssh-transport.ts";
import { assertBundleSize, decodeBundle, encodeBundle } from "./transport-protocol.ts";

export type ListServiceInput = { all: boolean; host?: string; allHosts: boolean };
export type ExportServiceInput = {
  id: string;
  host?: string;
  out?: string;
  handoff?: string;
  handoffTimeoutMs: number;
};
export type ImportServiceInput = { bundle: string; host?: string; cwd?: string };
export type HandoffServiceInput = {
  id: string;
  from?: string;
  to: string;
  cwd?: string;
  focus?: string;
};

export async function listSessionService(
  input: ListServiceInput,
): Promise<Record<string, unknown>> {
  if (input.allHosts) {
    if (input.host !== undefined) throw new Error("host and allHosts cannot be used together.");
    return await listAllHosts(input.all);
  }
  if (isLocalHost(input.host)) {
    const result = await listSessions(input.all);
    return input.host === undefined ? result : tagList(result, "local");
  }
  const target = await configuredTarget(input.host);
  const result = await callRemote(target, "list", { all: input.all });
  return tagList(result, target.host);
}

export async function readSessionService(input: {
  id: string;
  after?: string;
  host?: string;
}): Promise<Record<string, unknown>> {
  return await routeOperation(input.host, "read", { id: input.id, after: input.after }, async () =>
    readSession(input.id, input.after),
  );
}

export async function createSessionService(input: {
  cwd: string;
  name?: string;
  prompt: string;
  host?: string;
}): Promise<Record<string, unknown>> {
  return await routeOperation(
    input.host,
    "create",
    { cwd: input.cwd, name: input.name, prompt: input.prompt },
    async () => createSession({ cwd: input.cwd, name: input.name, prompt: input.prompt }),
  );
}

export async function sendSessionService(input: {
  id: string;
  prompt: string;
  host?: string;
}): Promise<Record<string, unknown>> {
  return await routeOperation(
    input.host,
    "send",
    { id: input.id, prompt: input.prompt },
    async () => sendToSession(input.id, input.prompt),
  );
}

export async function forkSessionService(input: {
  id: string;
  prompt: string;
  host?: string;
}): Promise<Record<string, unknown>> {
  return await routeOperation(
    input.host,
    "fork",
    { id: input.id, prompt: input.prompt },
    async () => forkSession(input.id, input.prompt),
  );
}

export async function waitSessionService(input: {
  id: string;
  after?: string;
  timeoutMs: number;
  host?: string;
}): Promise<Record<string, unknown>> {
  return await routeOperation(
    input.host,
    "wait",
    { id: input.id, after: input.after, timeoutMs: input.timeoutMs },
    async () => waitForSession(input.id, input.after, input.timeoutMs),
  );
}

export async function interruptSessionService(input: {
  id: string;
  host?: string;
}): Promise<Record<string, unknown>> {
  return await routeOperation(input.host, "interrupt", { id: input.id }, async () =>
    interruptSession(input.id),
  );
}

export async function exportSessionService(
  input: ExportServiceInput,
): Promise<Record<string, unknown>> {
  if (isLocalHost(input.host)) {
    const exported = await writeExportBundle(
      {
        id: input.id,
        sourceHost: "local",
        handoff: input.handoff,
        handoffTimeoutMs: input.handoffTimeoutMs,
      },
      input.out,
    );
    return {
      session_id: input.id,
      status: "exported",
      path: exported.path,
      manifest: exported.manifest,
    };
  }
  const target = await configuredTarget(input.host);
  const result = await callRemote(target, "export", {
    id: input.id,
    sourceHost: target.host,
    handoff: input.handoff,
    handoffTimeoutMs: input.handoffTimeoutMs,
  });
  const encoded = requireString(result.bundle_base64, "bundle_base64");
  const bundle = decodeBundle(encoded);
  const path = resolve(input.out ?? `./${input.id}.claude-session.tgz`);
  await writeBundleFile(path, bundle);
  return {
    session_id: input.id,
    status: "exported",
    path,
    manifest: result.manifest,
    host: target.host,
  };
}

export async function importSessionService(
  input: ImportServiceInput,
): Promise<Record<string, unknown>> {
  const bundle = await readLocalBundle(input.bundle);
  if (isLocalHost(input.host)) return await importSessionBundle({ bundle, cwd: input.cwd });
  const target = await configuredTarget(input.host);
  const result = await callRemote(target, "import", {
    bundle_base64: encodeBundle(bundle),
    cwd: input.cwd,
  });
  return { ...result, host: target.host };
}

export async function handoffSessionService(
  input: HandoffServiceInput,
): Promise<Record<string, unknown>> {
  const sourceHost = input.from ?? "local";
  const exported = await exportForTransfer(sourceHost, input.id, input.focus);
  try {
    const imported = await importForTransfer(input.to, exported, input.cwd);
    return { ...imported, host: normalizedHost(input.to) };
  } catch (error) {
    const retainedPath = await retainFailedHandoff(input.id, exported);
    if (error instanceof SessionControllerError) {
      throw new SessionControllerError(error.code, error.message, {
        ...error.details,
        retained_bundle_path: retainedPath,
      });
    }
    throw error;
  }
}

async function listAllHosts(all: boolean): Promise<Record<string, unknown>> {
  const config = await loadHostConfig();
  const local = tagList(await listSessions(all), "local");
  const sessions = [...asSessions(local.sessions)];
  const errors: Array<Record<string, unknown>> = [];
  await Promise.all(
    listFanoutHosts(config).map(async (target) => {
      try {
        const result = tagList(await callRemote(target, "list", { all }), target.host);
        sessions.push(...asSessions(result.sessions));
      } catch (error) {
        errors.push(errorSummary(target.host, error));
      }
    }),
  );
  const unique = new Map<string, Record<string, unknown>>();
  for (const session of sessions) {
    unique.set(`${String(session.host)}\0${String(session.id)}`, session);
  }
  return {
    sessions: [...unique.values()].sort(compareHostSessions),
    errors: errors.sort((left, right) => String(left.host).localeCompare(String(right.host))),
  };
}

async function routeOperation(
  host: string | undefined,
  operation: "read" | "create" | "send" | "fork" | "wait" | "interrupt",
  input: Record<string, unknown>,
  local: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  if (isLocalHost(host)) {
    const result = await local();
    return host === undefined ? result : { ...result, host: "local" };
  }
  const target = await configuredTarget(host);
  return { ...(await callRemote(target, operation, removeUndefined(input))), host: target.host };
}

async function exportForTransfer(host: string, id: string, focus?: string): Promise<Uint8Array> {
  if (isLocalHost(host)) {
    return (await exportSessionBundle({ id, sourceHost: "local", handoff: focus })).bundle;
  }
  const target = await configuredTarget(host);
  const result = await callRemote(target, "export", {
    id,
    sourceHost: target.host,
    handoff: focus,
    handoffTimeoutMs: 600_000,
  });
  return decodeBundle(requireString(result.bundle_base64, "bundle_base64"));
}

async function importForTransfer(
  host: string,
  bundle: Uint8Array,
  cwd?: string,
): Promise<ImportSessionResult | Record<string, unknown>> {
  if (isLocalHost(host)) return await importSessionBundle({ bundle, cwd });
  const target = await configuredTarget(host);
  return await callRemote(target, "import", { bundle_base64: encodeBundle(bundle), cwd });
}

async function configuredTarget(host: string | undefined): Promise<HostTarget> {
  if (!host) throw new Error("A remote host is required.");
  return resolveHost(await loadHostConfig(), host);
}

function isLocalHost(host: string | undefined): boolean {
  return host === undefined || host === "local";
}

function normalizedHost(host: string): string {
  return isLocalHost(host) ? "local" : host;
}

function tagList(result: Record<string, unknown>, host: string): Record<string, unknown> {
  return {
    ...result,
    sessions: asSessions(result.sessions).map((session) => ({ ...session, host })),
  };
}

function asSessions(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error("The session list response is invalid.");
  return value.filter(isRecord);
}

async function readLocalBundle(path: string): Promise<Uint8Array> {
  const contents = await readFile(resolve(path));
  assertBundleSize(contents.byteLength);
  return contents;
}

async function writeBundleFile(path: string, bundle: Uint8Array): Promise<void> {
  assertBundleSize(bundle.byteLength);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, bundle, { mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function retainFailedHandoff(id: string, bundle: Uint8Array): Promise<string> {
  const directory = handoffDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}-${Date.now()}.claude-session.tgz`);
  await writeFile(path, bundle, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function errorSummary(host: string, error: unknown): Record<string, unknown> {
  if (error instanceof SessionControllerError) {
    return { host, code: error.code, message: error.message };
  }
  return {
    host,
    code: "claude_session_error",
    message: error instanceof Error ? error.message : "Remote session listing failed.",
  };
}

function compareHostSessions(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftTime = sessionTime(left);
  const rightTime = sessionTime(right);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return `${String(left.host)}/${String(left.id)}`.localeCompare(
    `${String(right.host)}/${String(right.id)}`,
  );
}

function sessionTime(session: Record<string, unknown>): number {
  if (typeof session.updated_at === "string") return Date.parse(session.updated_at) || 0;
  return typeof session.started_at === "number" ? session.started_at : 0;
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`The remote response is missing ${name}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
