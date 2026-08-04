import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type HistoricalSession = {
  sessionId: string;
  fullPath?: string;
  created?: string;
  modified?: string;
  summary?: string;
  messageCount?: number;
  gitBranch?: string;
  projectPath?: string;
};

export type SessionArtifact = {
  archivePath: string;
  sourcePath: string;
};

export function claudeConfigDirectory(
  environment: Record<string, string | undefined> = process.env,
): string {
  return environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME ?? homedir(), ".claude");
}

export function claudeProjectsDirectory(
  environment: Record<string, string | undefined> = process.env,
): string {
  return join(claudeConfigDirectory(environment), "projects");
}

export function encodeClaudeProjectPath(cwd: string): string {
  const absoluteCwd = isAbsolute(cwd) ? cwd : resolve(cwd);
  return absoluteCwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function projectDirectoryForCwd(
  cwd: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  return join(claudeProjectsDirectory(environment), encodeClaudeProjectPath(cwd));
}

export function transcriptPathForSession(
  cwd: string,
  sessionId: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  assertSafeSessionId(sessionId);
  return join(projectDirectoryForCwd(cwd, environment), `${sessionId}.jsonl`);
}

export async function readHistoricalSessions(
  environment: Record<string, string | undefined> = process.env,
): Promise<HistoricalSession[]> {
  const projectsDirectory = claudeProjectsDirectory(environment);
  let projectDirectories;
  try {
    projectDirectories = await readdir(projectsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const sessions: HistoricalSession[] = [];
  for (const directory of projectDirectories) {
    if (!directory.isDirectory()) continue;
    const indexPath = join(projectsDirectory, directory.name, "sessions-index.json");
    try {
      const parsed: unknown = JSON.parse(await readFile(indexPath, "utf8"));
      if (!isSessionIndex(parsed)) continue;
      sessions.push(...parsed.entries.filter(isHistoricalSession));
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  return sessions;
}

export async function findClaudeTranscriptPath(
  sessionId: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (!isSafeSessionId(sessionId)) return undefined;
  const historical = (await readHistoricalSessions(environment)).find((session) => {
    return session.sessionId === sessionId && typeof session.fullPath === "string";
  });
  if (historical?.fullPath && (await pathExists(historical.fullPath))) return historical.fullPath;

  const projectsDirectory = claudeProjectsDirectory(environment);
  let projectDirectories;
  try {
    projectDirectories = await readdir(projectsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  for (const directory of projectDirectories) {
    if (!directory.isDirectory()) continue;
    const candidate = join(projectsDirectory, directory.name, `${sessionId}.jsonl`);
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

export async function collectSessionArtifacts(transcriptPath: string): Promise<SessionArtifact[]> {
  const sessionId = transcriptPath.slice(transcriptPath.lastIndexOf("/") + 1, -".jsonl".length);
  const projectDirectory = transcriptPath.slice(0, transcriptPath.lastIndexOf("/"));
  const artifacts: SessionArtifact[] = [
    { archivePath: "transcript.jsonl", sourcePath: transcriptPath },
  ];
  for (const sidecarName of ["tool-results", "subagents"]) {
    const sidecarRoot = join(projectDirectory, sessionId, sidecarName);
    artifacts.push(...(await collectRegularFiles(sidecarRoot, `sidecars/${sidecarName}`)));
  }
  return artifacts;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

export function assertSafeSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
}

async function collectRegularFiles(root: string, archiveRoot: string): Promise<SessionArtifact[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  const artifacts: SessionArtifact[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = join(root, entry.name);
    const archivePath = `${archiveRoot}/${entry.name}`;
    if (entry.isSymbolicLink())
      throw new Error(`Session sidecar cannot be a symlink: ${sourcePath}`);
    if (entry.isDirectory()) {
      artifacts.push(...(await collectRegularFiles(sourcePath, archivePath)));
    } else if (entry.isFile()) {
      artifacts.push({ archivePath, sourcePath });
    }
  }
  return artifacts;
}

function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(sessionId);
}

function isHistoricalSession(value: unknown): value is HistoricalSession {
  return isRecord(value) && typeof value.sessionId === "string";
}

function isSessionIndex(value: unknown): value is { entries: unknown[] } {
  return isRecord(value) && Array.isArray(value.entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
