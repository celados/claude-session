import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";

const lineageValidator = v.object({
  source_host: v.string(),
  source_cwd: v.string(),
  exported_at: v.number(),
});

const sessionRegistryRecordValidator = v.object({
  version: v.literal(1),
  session_id: v.string(),
  cwd: v.string(),
  transcript_path: v.string(),
  imported_at: v.number(),
  lineage: lineageValidator,
  name: v.optional(v.string()),
});

export type SessionLineage = v.InferOutput<typeof lineageValidator>;
export type SessionRegistryRecord = v.InferOutput<typeof sessionRegistryRecordValidator>;

export async function writeSessionRecord(record: SessionRegistryRecord): Promise<void> {
  const directory = await ensureRegistryDirectory();
  const path = join(directory, `${record.session_id}.json`);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const validated = v.parse(sessionRegistryRecordValidator, record);
  await writeFile(temporaryPath, `${JSON.stringify(validated)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function getSessionRecord(
  sessionId: string,
): Promise<SessionRegistryRecord | undefined> {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  try {
    return parseRecord(await readFile(join(registryDirectory(), `${sessionId}.json`), "utf8"));
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

export async function listSessionRecords(): Promise<SessionRegistryRecord[]> {
  let names: string[];
  try {
    names = await readdir(registryDirectory());
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) => readFile(join(registryDirectory(), name), "utf8").then(parseRecord)),
  );
  return records.filter((record): record is SessionRegistryRecord => record !== undefined);
}

export function stateDirectory(
  environment: Record<string, string | undefined> = process.env,
): string {
  const stateHome =
    environment.XDG_STATE_HOME ?? join(environment.HOME ?? homedir(), ".local", "state");
  return join(stateHome, "claude-session");
}

export function handoffDirectory(
  environment: Record<string, string | undefined> = process.env,
): string {
  return join(stateDirectory(environment), "handoffs");
}

function registryDirectory(): string {
  return join(stateDirectory(), "sessions");
}

async function ensureRegistryDirectory(): Promise<string> {
  const directory = registryDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function parseRecord(contents: string): SessionRegistryRecord | undefined {
  try {
    return v.parse(sessionRegistryRecordValidator, JSON.parse(contents));
  } catch {
    return undefined;
  }
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
