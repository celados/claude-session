import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import packageJson from "../package.json" with { type: "json" };
import {
  collectSessionArtifacts,
  findClaudeTranscriptPath,
  pathExists,
  projectDirectoryForCwd,
  transcriptPathForSession,
} from "./claude-state.ts";
import {
  createBundleArchive,
  parseBundleArchive,
  type BundleManifest,
  type BundleManifestInput,
} from "./session-bundle.ts";
import { SessionControllerError } from "./session-error.ts";
import {
  assertSessionIdle,
  readSession,
  sendToSession,
  sessionCwd,
  sessionTranscriptPath,
  waitForSession,
} from "./session-controller.ts";
import { getSessionRecord, writeSessionRecord, type SessionLineage } from "./session-registry.ts";

export type ExportSessionInput = {
  id: string;
  sourceHost: string;
  handoff?: string;
  handoffTimeoutMs?: number;
};

export type ImportSessionInput = {
  bundle: Uint8Array;
  cwd?: string;
};

export type ImportSessionResult = {
  session_id: string;
  status: "imported";
  cwd: string;
  lineage: SessionLineage;
};

export async function exportSessionBundle(input: ExportSessionInput): Promise<{
  bundle: Uint8Array;
  manifest: BundleManifest;
}> {
  await assertSessionIdle(input.id);
  if (input.handoff !== undefined) await runClosingTurn(input);
  await assertSessionIdle(input.id);
  const [cwd, transcriptPath] = await Promise.all([
    sessionCwd(input.id),
    sessionTranscriptPath(input.id),
  ]);
  if (!cwd || !transcriptPath) throw new Error(`Claude session not found: ${input.id}`);
  const artifacts = await collectSessionArtifacts(transcriptPath);
  const files = new Map<string, Buffer>();
  for (const artifact of artifacts) {
    files.set(artifact.archivePath, await readFile(artifact.sourcePath));
  }
  const manifestInput: BundleManifestInput = {
    version: 1,
    protocol_version: 1,
    session_id: input.id,
    source_host: input.sourceHost,
    cwd,
    exported_at: Date.now(),
    tool_version: packageJson.version,
    handoff: input.handoff !== undefined,
  };
  const bundle = createBundleArchive(manifestInput, files);
  return { bundle, manifest: parseBundleArchive(bundle).manifest };
}

export async function writeExportBundle(
  input: ExportSessionInput,
  out?: string,
): Promise<{ path: string; manifest: BundleManifest }> {
  const exported = await exportSessionBundle(input);
  const path = resolve(out ?? `./${input.id}.claude-session.tgz`);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, exported.bundle, { mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
  return { path, manifest: exported.manifest };
}

export async function importSessionBundle(input: ImportSessionInput): Promise<ImportSessionResult> {
  const parsed = parseBundleArchive(input.bundle);
  const targetCwd = resolve(input.cwd ?? parsed.manifest.cwd);
  await assertExistingDirectory(targetCwd, parsed.manifest.cwd, input.cwd !== undefined);
  const sessionId = parsed.manifest.session_id;
  const transcriptPath = transcriptPathForSession(targetCwd, sessionId);
  const existing = await Promise.all([
    getSessionRecord(sessionId),
    findClaudeTranscriptPath(sessionId),
    pathExists(transcriptPath),
  ]);
  if (existing[0] || existing[1] || existing[2]) {
    throw new SessionControllerError(
      "import_conflict",
      "A session with this id already exists on the target host.",
      { session_id: sessionId },
    );
  }

  const projectDirectory = projectDirectoryForCwd(targetCwd);
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(projectDirectory, ".claude-session-import-"));
  const stagedTranscript = join(staging, `${sessionId}.jsonl`);
  const stagedSidecars = join(staging, sessionId);
  const targetSidecars = join(projectDirectory, sessionId);
  let sidecarsInstalled = false;
  let transcriptInstalled = false;
  try {
    await stageBundleFiles(parsed.files, stagedTranscript, stagedSidecars);
    const hasSidecars = await pathExists(stagedSidecars);
    if (hasSidecars) {
      await rename(stagedSidecars, targetSidecars);
      sidecarsInstalled = true;
    }
    await rename(stagedTranscript, transcriptPath);
    transcriptInstalled = true;
    const lineage: SessionLineage = {
      source_host: parsed.manifest.source_host,
      source_cwd: parsed.manifest.cwd,
      exported_at: parsed.manifest.exported_at,
    };
    await writeSessionRecord({
      version: 1,
      session_id: sessionId,
      cwd: targetCwd,
      transcript_path: transcriptPath,
      imported_at: Date.now(),
      lineage,
      name: parsed.manifest.name,
    });
    return { session_id: sessionId, status: "imported", cwd: targetCwd, lineage };
  } catch (error) {
    if (transcriptInstalled) await rm(transcriptPath, { force: true });
    if (sidecarsInstalled) await rm(targetSidecars, { force: true, recursive: true });
    throw error;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

async function runClosingTurn(input: ExportSessionInput): Promise<void> {
  const before = await readSession(input.id);
  const prompt = [
    "Prepare a closing handoff summary for this session.",
    "Summarize the current state, open questions, and concrete next steps.",
    `Focus: ${input.handoff ?? "General handoff"}`,
  ].join("\n");
  await sendToSession(input.id, prompt);
  const timeoutMs = input.handoffTimeoutMs ?? 600_000;
  const waited = await waitForSession(input.id, before.cursor, timeoutMs);
  if (waited.timed_out) {
    throw new SessionControllerError(
      "handoff_timeout",
      "The closing handoff turn did not finish before the timeout.",
      { session_id: input.id, timeout_ms: timeoutMs },
    );
  }
}

async function assertExistingDirectory(
  targetCwd: string,
  recordedCwd: string,
  remapped: boolean,
): Promise<void> {
  try {
    const details = await stat(targetCwd);
    if (details.isDirectory()) return;
  } catch {
    // Converted to the stable domain error below.
  }
  throw new SessionControllerError(
    "cwd_not_found",
    remapped
      ? "The requested target cwd does not exist."
      : "The recorded cwd does not exist; pass --cwd to remap it.",
    { cwd: targetCwd, recorded_cwd: recordedCwd },
  );
}

async function stageBundleFiles(
  files: Map<string, Buffer>,
  stagedTranscript: string,
  stagedSidecars: string,
): Promise<void> {
  for (const [archivePath, contents] of files) {
    let path: string;
    if (archivePath === "transcript.jsonl") {
      path = stagedTranscript;
    } else if (archivePath.startsWith("sidecars/")) {
      path = join(stagedSidecars, archivePath.slice("sidecars/".length));
    } else {
      throw new SessionControllerError("bundle_invalid", "The bundle contains an unknown file.", {
        path: archivePath,
      });
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { mode: 0o600 });
  }
}
