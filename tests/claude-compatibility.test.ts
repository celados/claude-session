import { expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { projectDirectoryForCwd } from "../src/claude-state.ts";

const characterize = process.env.CLAUDE_SESSION_CHARACTERIZE === "1";

test.skipIf(!characterize)(
  "characterizes real Claude CLI same-id restore from a moved transcript",
  async () => {
    const sourceTranscript = requiredEnvironment("CLAUDE_SESSION_CHARACTERIZE_TRANSCRIPT");
    const cwd = requiredEnvironment("CLAUDE_SESSION_CHARACTERIZE_CWD");
    const sessionId = basename(sourceTranscript, ".jsonl");
    const configDirectory = await mkdtemp(join(tmpdir(), "claude-session-characterize-"));
    try {
      await seedLoginState(configDirectory);
      const projectDirectory = projectDirectoryForCwd(cwd, {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDirectory,
      });
      await mkdir(projectDirectory, { recursive: true });
      await writeFile(
        join(projectDirectory, `${sessionId}.jsonl`),
        await readFile(sourceTranscript),
      );

      const result = await runClaude(
        ["--resume", sessionId, "--print", "--output-format", "json"],
        "Reply with the single word RESTORED.",
        cwd,
        configDirectory,
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ session_id: sessionId });
    } finally {
      await rm(configDirectory, { force: true, recursive: true });
    }
  },
  120_000,
);

async function runClaude(
  args: string[],
  prompt: string,
  cwd: string,
  configDirectory: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn("claude", args, {
    cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDirectory },
  });
  child.stdin.end(prompt);
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

// An isolated CLAUDE_CONFIG_DIR has no login state, so the restore would fail
// with "Not logged in" before proving anything. Seed the user's config file
// and, when provided, a credentials file (macOS keychain users can pass
// CLAUDE_SESSION_CHARACTERIZE_CREDENTIALS pointing at the extracted secret:
// `security find-generic-password -s "Claude Code-credentials" -w`).
async function seedLoginState(configDirectory: string): Promise<void> {
  const home = process.env.HOME ?? "";
  try {
    await writeFile(
      join(configDirectory, ".claude.json"),
      await readFile(join(home, ".claude.json")),
      { mode: 0o600 },
    );
  } catch {
    // Without a user config the CLI reports the login failure itself.
  }
  const credentialsPath = process.env.CLAUDE_SESSION_CHARACTERIZE_CREDENTIALS;
  if (credentialsPath) {
    await writeFile(join(configDirectory, ".credentials.json"), await readFile(credentialsPath), {
      mode: 0o600,
    });
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when characterization is enabled.`);
  return value;
}
