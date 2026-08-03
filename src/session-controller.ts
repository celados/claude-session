import { spawn as spawnDetached } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { SessionControllerError } from "./session-error.ts";
import {
  isProcessRunning,
  latestJobForSession,
  listJobs,
  prepareJobFiles,
  writeJob,
} from "./job-registry.ts";

type ActiveSession = {
  sessionId: string;
  name?: string;
  status?: string;
  cwd?: string;
  pid?: number;
  kind?: string;
  startedAt?: number;
};

type HistoricalSession = {
  sessionId: string;
  fullPath?: string;
  created?: string;
  modified?: string;
  summary?: string;
  messageCount?: number;
  gitBranch?: string;
  projectPath?: string;
};

type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
};

type SessionSummary = {
  id: string;
  name?: string;
  status: string;
  cwd?: string;
  pid?: number;
  kind?: string;
  started_at?: number;
  created_at?: string;
  updated_at?: string;
  summary?: string;
  message_count?: number;
  git_branch?: string;
};

type CreateSessionInput = {
  cwd: string;
  name?: string;
  prompt: string;
};

export async function listSessions(all: boolean): Promise<{ sessions: SessionSummary[] }> {
  const activeSessions = await readActiveSessions(all);
  const sessionsById = new Map<string, SessionSummary>();

  for (const session of activeSessions) {
    sessionsById.set(session.sessionId, presentActiveSession(session));
  }

  for (const job of latestJobsBySession(await listJobs())) {
    const existing = sessionsById.get(job.session_id);
    sessionsById.set(job.session_id, presentManagedSession(job, existing));
  }

  if (all) {
    for (const session of await readHistoricalSessions()) {
      const active = sessionsById.get(session.sessionId);
      sessionsById.set(session.sessionId, presentHistoricalSession(session, active));
    }
  }

  return {
    sessions: [...sessionsById.values()].sort(compareSessionsByRecency),
  };
}

export async function readSession(
  sessionId: string,
  after?: string,
): Promise<{ session_id: string; cursor: string; messages: ConversationMessage[] }> {
  const transcriptPath = await findTranscriptPath(sessionId);
  if (!transcriptPath) throw new Error(`Claude session not found: ${sessionId}`);

  const contents = await readFile(transcriptPath);
  const offset = after ? decodeCursor(after) : 0;
  if (offset > contents.byteLength) throw new Error("Cursor is beyond the current transcript.");
  const lastNewline = contents.lastIndexOf(0x0a);
  const completeLength = lastNewline < 0 ? 0 : lastNewline + 1;
  const unreadContents = contents
    .subarray(offset, Math.max(offset, completeLength))
    .toString("utf8");
  const messages = unreadContents
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseTranscriptLine)
    .filter((message): message is ConversationMessage => message !== undefined);

  return {
    session_id: sessionId,
    cursor: encodeCursor(Math.max(offset, completeLength)),
    messages,
  };
}

export async function createSession(input: CreateSessionInput): Promise<{
  session_id: string;
  run_id: string;
  status: "running";
  cwd: string;
  name?: string;
}> {
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const args = ["--session-id", sessionId];
  if (input.name) args.push("--name", input.name);
  args.push("--print", "--output-format", "json");
  await startManagedRun({
    args,
    cwd: input.cwd,
    kind: "create",
    name: input.name,
    prompt: input.prompt,
    runId,
    sessionId,
  });

  return withoutUndefined({
    session_id: sessionId,
    run_id: runId,
    status: "running" as const,
    cwd: input.cwd,
    name: input.name,
  });
}

export async function sendToSession(
  sessionId: string,
  prompt: string,
): Promise<{
  session_id: string;
  run_id: string;
  status: "running";
  cwd: string;
}> {
  const active = (await readActiveSessions(true)).find((session) => {
    return session.sessionId === sessionId;
  });
  const existingJob = await latestJobForSession(sessionId);
  if (
    (active?.status && isRunningStatus(active.status)) ||
    (existingJob && isProcessRunning(existingJob.pid))
  ) {
    throw new SessionControllerError("session_busy", "The Claude session is already running.", {
      session_id: sessionId,
    });
  }

  const historical = (await readHistoricalSessions()).find((session) => {
    return session.sessionId === sessionId;
  });
  const cwd = active?.cwd ?? historical?.projectPath ?? existingJob?.cwd;
  if (!cwd) throw new Error(`Claude session not found: ${sessionId}`);
  await releaseNativeBackgroundSession(active);

  const runId = crypto.randomUUID();
  await startManagedRun({
    args: ["--resume", sessionId, "--print", "--output-format", "json"],
    cwd,
    kind: "send",
    prompt,
    runId,
    sessionId,
  });

  return {
    session_id: sessionId,
    run_id: runId,
    status: "running",
    cwd,
  };
}

export async function forkSession(
  sourceSessionId: string,
  prompt: string,
): Promise<{
  source_session_id: string;
  session_id: string;
  run_id: string;
  status: "running";
  cwd: string;
}> {
  const active = (await readActiveSessions(true)).find((session) => {
    return session.sessionId === sourceSessionId;
  });
  if (active?.status && isRunningStatus(active.status)) {
    throw new SessionControllerError("session_busy", "The Claude session is already running.", {
      session_id: sourceSessionId,
    });
  }
  const historical = (await readHistoricalSessions()).find((session) => {
    return session.sessionId === sourceSessionId;
  });
  const existingJob = await latestJobForSession(sourceSessionId);
  const cwd = active?.cwd ?? historical?.projectPath ?? existingJob?.cwd;
  if (!cwd) throw new Error(`Claude session not found: ${sourceSessionId}`);
  await releaseNativeBackgroundSession(active);

  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await startManagedRun({
    args: [
      "--resume",
      sourceSessionId,
      "--fork-session",
      "--session-id",
      sessionId,
      "--print",
      "--output-format",
      "json",
    ],
    cwd,
    kind: "fork",
    prompt,
    runId,
    sessionId,
    sourceSessionId,
  });

  return {
    source_session_id: sourceSessionId,
    session_id: sessionId,
    run_id: runId,
    status: "running",
    cwd,
  };
}

export async function waitForSession(
  sessionId: string,
  after: string | undefined,
  timeoutMs: number,
): Promise<{
  session_id: string;
  status: string;
  timed_out: boolean;
  cursor: string;
  messages: ConversationMessage[];
}> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const active = (await readActiveSessions(true)).find((session) => {
      return session.sessionId === sessionId;
    });
    const latestJob = await latestJobForSession(sessionId);
    const jobRunning = latestJob ? isProcessRunning(latestJob.pid) : false;
    const transcriptPath = await findTranscriptPath(sessionId);
    const remainingMs = deadline - Date.now();
    if (latestJob && !jobRunning && (await managedJobFailed(latestJob))) {
      throw new SessionControllerError(
        "claude_run_failed",
        "The managed Claude run failed. Inspect its stderr log for details.",
        {
          session_id: sessionId,
          run_id: latestJob.run_id,
          stderr_path: latestJob.stderr_path,
        },
      );
    }
    if (!active && !transcriptPath && !jobRunning) {
      if (remainingMs <= 0) {
        if (latestJob) {
          return { ...emptyTranscript(sessionId), status: "idle", timed_out: true };
        }
        throw new Error(`Claude session not found: ${sessionId}`);
      }
      await Bun.sleep(Math.min(50, remainingMs));
      continue;
    }

    const status = jobRunning ? "running" : (active?.status ?? "idle");
    if (!isRunningStatus(status)) {
      if (!transcriptPath) {
        if (remainingMs <= 0) throw new Error(`Claude session not found: ${sessionId}`);
        await Bun.sleep(Math.min(50, remainingMs));
        continue;
      }
      const transcript = await readSession(sessionId, after);
      return { ...transcript, status, timed_out: false };
    }

    if (remainingMs <= 0) {
      const transcript = transcriptPath
        ? await readSession(sessionId, after)
        : emptyTranscript(sessionId);
      return { ...transcript, status, timed_out: true };
    }
    await Bun.sleep(Math.min(50, remainingMs));
  }
}

function emptyTranscript(sessionId: string): {
  session_id: string;
  cursor: string;
  messages: ConversationMessage[];
} {
  return { session_id: sessionId, cursor: encodeCursor(0), messages: [] };
}

export async function interruptSession(sessionId: string): Promise<{
  session_id: string;
  status: "interrupted";
  pid: number;
}> {
  const managedJob = await latestJobForSession(sessionId);
  if (managedJob && isProcessRunning(managedJob.pid)) {
    process.kill(-managedJob.pid, "SIGINT");
    return {
      session_id: sessionId,
      status: "interrupted",
      pid: managedJob.pid,
    };
  }

  const active = (await readActiveSessions(true)).find((session) => {
    return session.sessionId === sessionId;
  });
  if (!active?.pid || !isRunningStatus(active.status ?? "unknown")) {
    throw new Error(`Claude session is not running: ${sessionId}`);
  }

  process.kill(active.pid, "SIGINT");
  return {
    session_id: sessionId,
    status: "interrupted",
    pid: active.pid,
  };
}

async function readActiveSessions(all: boolean): Promise<ActiveSession[]> {
  const args = ["claude", "agents", "--json"];
  if (all) args.push("--all");
  const processHandle = Bun.spawn(args, { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`claude agents failed (${exitCode}): ${stderr.trim()}`);
  }

  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("claude agents returned a non-array response.");
  return parsed.filter(isActiveSession);
}

async function releaseNativeBackgroundSession(session: ActiveSession | undefined): Promise<void> {
  if (session?.kind !== "background") return;
  const processHandle = Bun.spawn(["claude", "stop", session.sessionId.slice(0, 8)], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`claude stop failed (${exitCode}): ${stderr.trim()}`);
  }
}

async function readHistoricalSessions(): Promise<HistoricalSession[]> {
  const projectsDirectory = join(homedir(), ".claude", "projects");
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

async function findTranscriptPath(sessionId: string): Promise<string | undefined> {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) return undefined;
  const historical = (await readHistoricalSessions()).find((session) => {
    return session.sessionId === sessionId && typeof session.fullPath === "string";
  });
  if (historical?.fullPath) return historical.fullPath;

  const projectsDirectory = join(homedir(), ".claude", "projects");
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
    try {
      await readFile(candidate, { encoding: null, flag: "r" });
      return candidate;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  return undefined;
}

function presentActiveSession(session: ActiveSession): SessionSummary {
  return withoutUndefined({
    id: session.sessionId,
    name: session.name,
    status: session.status ?? "unknown",
    cwd: session.cwd,
    pid: session.pid,
    kind: session.kind,
    started_at: session.startedAt,
  });
}

function presentManagedSession(
  job: NonNullable<Awaited<ReturnType<typeof latestJobForSession>>>,
  existing: SessionSummary | undefined,
): SessionSummary {
  const running = isProcessRunning(job.pid);
  return withoutUndefined({
    ...existing,
    id: job.session_id,
    name: job.name ?? existing?.name,
    status: running ? "running" : (existing?.status ?? "idle"),
    cwd: job.cwd,
    pid: running ? job.pid : existing?.pid,
    kind: "managed",
    started_at: job.started_at,
  });
}

function latestJobsBySession(
  jobs: Awaited<ReturnType<typeof listJobs>>,
): Awaited<ReturnType<typeof listJobs>> {
  const latest = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    const existing = latest.get(job.session_id);
    if (!existing || job.started_at > existing.started_at) latest.set(job.session_id, job);
  }
  return [...latest.values()];
}

function presentHistoricalSession(
  session: HistoricalSession,
  active: SessionSummary | undefined,
): SessionSummary {
  return withoutUndefined({
    ...active,
    id: session.sessionId,
    status: active?.status ?? "idle",
    cwd: active?.cwd ?? session.projectPath,
    created_at: session.created,
    updated_at: session.modified,
    summary: session.summary,
    message_count: session.messageCount,
    git_branch: session.gitBranch,
  });
}

function compareSessionsByRecency(left: SessionSummary, right: SessionSummary): number {
  return recencyOf(right) - recencyOf(left);
}

function isRunningStatus(status: string): boolean {
  return status === "running" || status === "active" || status === "working" || status === "busy";
}

function parseTranscriptLine(line: string): ConversationMessage | undefined {
  const entry: unknown = JSON.parse(line);
  if (!isRecord(entry)) return undefined;
  if (entry.type !== "user" && entry.type !== "assistant") return undefined;
  if (typeof entry.uuid !== "string" || !isRecord(entry.message)) return undefined;

  const text = textFromContent(entry.message.content);
  if (!text) return undefined;
  return withoutUndefined({
    id: entry.uuid,
    role: entry.type as "user" | "assistant",
    text,
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
  });
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n")
    .trim();
  return text || undefined;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ version: 1, offset })).toString("base64url");
}

type ManagedRunInput = {
  args: string[];
  cwd: string;
  kind: "create" | "send" | "fork";
  name?: string;
  prompt: string;
  runId: string;
  sessionId: string;
  sourceSessionId?: string;
};

async function startManagedRun(input: ManagedRunInput): Promise<void> {
  const files = await prepareJobFiles(input.runId, input.prompt);
  const promptFd = openSync(files.promptPath, "r");
  const stdoutFd = openSync(files.stdoutPath, "w");
  const stderrFd = openSync(files.stderrPath, "w");
  const child = spawnDetached("claude", input.args, {
    cwd: input.cwd,
    detached: true,
    env: process.env,
    stdio: [promptFd, stdoutFd, stderrFd],
  });
  closeSync(promptFd);
  closeSync(stdoutFd);
  closeSync(stderrFd);
  await unlink(files.promptPath);
  if (!child.pid) throw new Error("Claude managed run did not start a process.");
  child.unref();
  await writeJob(
    withoutUndefined({
      version: 1 as const,
      run_id: input.runId,
      session_id: input.sessionId,
      kind: input.kind,
      source_session_id: input.sourceSessionId,
      name: input.name,
      pid: child.pid,
      cwd: input.cwd,
      started_at: Date.now(),
      stdout_path: files.stdoutPath,
      stderr_path: files.stderrPath,
    }),
  );
}

async function managedJobFailed(
  job: Awaited<ReturnType<typeof latestJobForSession>>,
): Promise<boolean> {
  if (!job) return false;
  let stdout: string;
  try {
    stdout = await readFile(job.stdout_path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return true;
    throw error;
  }
  try {
    const result: unknown = JSON.parse(stdout);
    return !isRecord(result) || result.session_id !== job.session_id || result.is_error === true;
  } catch {
    return true;
  }
}

function decodeCursor(cursor: string): number {
  const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.offset !== "number" ||
    !Number.isSafeInteger(parsed.offset) ||
    parsed.offset < 0
  ) {
    throw new Error("Invalid transcript cursor.");
  }
  return parsed.offset;
}

function recencyOf(session: SessionSummary): number {
  if (session.updated_at) return Date.parse(session.updated_at);
  return session.started_at ?? 0;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
}

function isActiveSession(value: unknown): value is ActiveSession {
  return isRecord(value) && typeof value.sessionId === "string";
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
