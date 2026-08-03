import { mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type JobRecord = {
  version: 1;
  run_id: string;
  session_id: string;
  kind: "create" | "send" | "fork";
  source_session_id?: string;
  name?: string;
  pid: number;
  cwd: string;
  started_at: number;
  stdout_path: string;
  stderr_path: string;
};

export async function prepareJobFiles(
  runId: string,
  prompt: string,
): Promise<{
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
}> {
  const directory = await ensureJobsDirectory();
  const promptPath = join(directory, `${runId}.prompt`);
  const stdoutPath = join(directory, `${runId}.stdout`);
  const stderrPath = join(directory, `${runId}.stderr`);
  await writeFile(promptPath, prompt, { mode: 0o600 });
  await Promise.all([
    open(stdoutPath, "w", 0o600).then((handle) => handle.close()),
    open(stderrPath, "w", 0o600).then((handle) => handle.close()),
  ]);
  return { promptPath, stdoutPath, stderrPath };
}

export async function writeJob(job: JobRecord): Promise<void> {
  const directory = await ensureJobsDirectory();
  const path = join(directory, `${job.run_id}.json`);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function latestJobForSession(sessionId: string): Promise<JobRecord | undefined> {
  return (await listJobs())
    .filter((job) => job.session_id === sessionId)
    .sort((left, right) => right.started_at - left.started_at)[0];
}

export async function listJobs(): Promise<JobRecord[]> {
  const directory = jobsDirectory();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const jobs = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => parseJob(await readFile(join(directory, name), "utf8"))),
  );
  return jobs.filter((job): job is JobRecord => job !== undefined);
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") return false;
    if (isRecord(error) && error.code === "EPERM") return true;
    throw error;
  }
}

function jobsDirectory(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "claude-session", "jobs");
}

async function ensureJobsDirectory(): Promise<string> {
  const directory = jobsDirectory();
  await mkdir(directory, { mode: 0o700, recursive: true });
  return directory;
}

function parseJob(contents: string): JobRecord | undefined {
  const parsed: unknown = JSON.parse(contents);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.run_id !== "string" ||
    typeof parsed.session_id !== "string" ||
    (parsed.kind !== "create" && parsed.kind !== "send" && parsed.kind !== "fork") ||
    typeof parsed.pid !== "number" ||
    typeof parsed.cwd !== "string" ||
    typeof parsed.started_at !== "number" ||
    typeof parsed.stdout_path !== "string" ||
    typeof parsed.stderr_path !== "string"
  ) {
    return undefined;
  }
  if (parsed.source_session_id !== undefined && typeof parsed.source_session_id !== "string") {
    return undefined;
  }
  if (parsed.name !== undefined && typeof parsed.name !== "string") return undefined;
  return parsed as JobRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
