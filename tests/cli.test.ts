import { afterEach, describe, expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const temporaryDirectories: string[] = [];
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("claude-session CLI", () => {
  test("lists active and historical Claude sessions as one deduplicated JSON collection", async () => {
    const home = await createTemporaryHome();
    const fakeBin = join(home, "bin");
    const projectPath = join(home, "work", "example");
    const encodedProject = "-tmp-example";
    const indexDirectory = join(home, ".claude", "projects", encodedProject);

    await mkdir(fakeBin, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await mkdir(indexDirectory, { recursive: true });
    await writeExecutable(
      join(fakeBin, "claude"),
      `#!/bin/sh
if [ "$1" = "agents" ] && [ "$2" = "--json" ] && [ "$3" = "--all" ]; then
  printf '%s\\n' '[{"sessionId":"active-1","name":"worker-a","status":"idle","cwd":"${projectPath}","pid":42,"kind":"background","startedAt":1785000000000}]'
  exit 0
fi
printf '%s\\n' "unexpected claude invocation: $*" >&2
exit 64
`,
    );
    await writeFile(
      join(indexDirectory, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        originalPath: projectPath,
        entries: [
          {
            sessionId: "active-1",
            fullPath: join(indexDirectory, "active-1.jsonl"),
            firstPrompt: "Investigate the active issue",
            summary: "Active investigation",
            messageCount: 4,
            created: "2026-08-01T10:00:00.000Z",
            modified: "2026-08-01T10:05:00.000Z",
            gitBranch: "main",
            projectPath,
            isSidechain: false,
          },
          {
            sessionId: "history-1",
            fullPath: join(indexDirectory, "history-1.jsonl"),
            firstPrompt: "Review the historical issue",
            summary: "Historical review",
            messageCount: 7,
            created: "2026-07-31T09:00:00.000Z",
            modified: "2026-07-31T09:20:00.000Z",
            gitBranch: "feature/review",
            projectPath,
            isSidechain: false,
          },
        ],
      }),
    );

    const result = await runCli(["@run", "await argc.call.list({ all: true })", "--json"], {
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      sessions: [
        {
          id: "active-1",
          name: "worker-a",
          status: "idle",
          cwd: projectPath,
          pid: 42,
          kind: "background",
          started_at: 1785000000000,
          created_at: "2026-08-01T10:00:00.000Z",
          updated_at: "2026-08-01T10:05:00.000Z",
          summary: "Active investigation",
          message_count: 4,
          git_branch: "main",
        },
        {
          id: "history-1",
          status: "idle",
          cwd: projectPath,
          created_at: "2026-07-31T09:00:00.000Z",
          updated_at: "2026-07-31T09:20:00.000Z",
          summary: "Historical review",
          message_count: 7,
          git_branch: "feature/review",
        },
      ],
    });
  });

  test("reads normalized conversation text from a Claude transcript and returns a cursor", async () => {
    const home = await createTemporaryHome();
    const fakeBin = join(home, "bin");
    const projectPath = join(home, "work", "example");
    const indexDirectory = join(home, ".claude", "projects", "-tmp-example");
    const transcriptPath = join(indexDirectory, "history-1.jsonl");

    await mkdir(fakeBin, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await mkdir(indexDirectory, { recursive: true });
    await writeExecutable(join(fakeBin, "claude"), "#!/bin/sh\nexit 64\n");
    await writeFile(
      join(indexDirectory, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        originalPath: projectPath,
        entries: [
          {
            sessionId: "history-1",
            fullPath: transcriptPath,
            created: "2026-07-31T09:00:00.000Z",
            modified: "2026-07-31T09:20:00.000Z",
            messageCount: 2,
            projectPath,
            isSidechain: false,
          },
        ],
      }),
    );
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "file-history-snapshot",
          messageId: "snapshot-1",
          snapshot: {},
        }),
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          parentUuid: null,
          sessionId: "history-1",
          timestamp: "2026-07-31T09:00:00.000Z",
          message: { role: "user", content: "Investigate the failing build." },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          parentUuid: "user-1",
          sessionId: "history-1",
          timestamp: "2026-07-31T09:01:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "The build fails because the config is missing." },
              { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "x" } },
            ],
          },
        }),
      ].join("\n") + "\n",
    );

    const result = await runCli(["@run", "await argc.call.read({ id: 'history-1' })", "--json"], {
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      session_id: "history-1",
      cursor: expect.any(String),
      messages: [
        {
          id: "user-1",
          role: "user",
          text: "Investigate the failing build.",
          timestamp: "2026-07-31T09:00:00.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: "The build fails because the config is missing.",
          timestamp: "2026-07-31T09:01:00.000Z",
        },
      ],
    });
  });

  test("reads only messages appended after a previous cursor", async () => {
    const home = await createTemporaryHome();
    const projectPath = join(home, "work", "example");
    const indexDirectory = join(home, ".claude", "projects", "-tmp-example");
    const transcriptPath = join(indexDirectory, "session-1.jsonl");
    await mkdir(indexDirectory, { recursive: true });
    await writeFile(
      join(indexDirectory, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        originalPath: projectPath,
        entries: [
          {
            sessionId: "session-1",
            fullPath: transcriptPath,
            projectPath,
            isSidechain: false,
          },
        ],
      }),
    );
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "user",
        uuid: "user-1",
        sessionId: "session-1",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { role: "user", content: "First turn" },
      })}\n`,
    );

    const first = await runCli(["@run", "await argc.call.read({ id: 'session-1' })", "--json"], {
      HOME: home,
    });
    expect(first).toMatchObject({ exitCode: 0, stderr: "" });
    const firstResult = JSON.parse(first.stdout) as { cursor: string };

    await appendFile(
      transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        uuid: "assistant-2",
        parentUuid: "user-1",
        sessionId: "session-1",
        timestamp: "2026-08-01T10:01:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Second turn" }] },
      })}\n`,
    );

    const second = await runCli(
      [
        "@run",
        `await argc.call.read({ id: 'session-1', after: '${firstResult.cursor}' })`,
        "--json",
      ],
      { HOME: home },
    );

    expect(second).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(second.stdout)).toEqual({
      session_id: "session-1",
      cursor: expect.not.stringMatching(firstResult.cursor),
      messages: [
        {
          id: "assistant-2",
          role: "assistant",
          text: "Second turn",
          timestamp: "2026-08-01T10:01:00.000Z",
        },
      ],
    });
  });

  test("does not advance the cursor past an incomplete transcript line", async () => {
    const home = await createTemporaryHome();
    const projectPath = join(home, "work", "example");
    const indexDirectory = join(home, ".claude", "projects", "-tmp-example");
    const transcriptPath = join(indexDirectory, "session-1.jsonl");
    await mkdir(indexDirectory, { recursive: true });
    await writeFile(
      join(indexDirectory, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        originalPath: projectPath,
        entries: [{ sessionId: "session-1", fullPath: transcriptPath, projectPath }],
      }),
    );
    const completeLine = `${JSON.stringify({
      type: "user",
      uuid: "user-complete",
      sessionId: "session-1",
      message: { role: "user", content: "Complete line" },
    })}\n`;
    const assistantLine = JSON.stringify({
      type: "assistant",
      uuid: "assistant-eventually-complete",
      sessionId: "session-1",
      message: { role: "assistant", content: "Eventually complete" },
    });
    const splitAt = Math.floor(assistantLine.length / 2);
    await writeFile(transcriptPath, completeLine + assistantLine.slice(0, splitAt));

    const first = await runCli(["@run", "await argc.call.read({ id: 'session-1' })", "--json"], {
      HOME: home,
    });
    expect(first).toMatchObject({ exitCode: 0, stderr: "" });
    const firstResult = JSON.parse(first.stdout) as {
      cursor: string;
      messages: Array<{ id: string }>;
    };
    expect(firstResult.messages).toEqual([expect.objectContaining({ id: "user-complete" })]);

    await appendFile(transcriptPath, `${assistantLine.slice(splitAt)}\n`);
    const second = await runCli(
      [
        "@run",
        `await argc.call.read({ id: 'session-1', after: '${firstResult.cursor}' })`,
        "--json",
      ],
      { HOME: home },
    );
    expect(second).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(second.stdout).messages).toEqual([
      expect.objectContaining({
        id: "assistant-eventually-complete",
        text: "Eventually complete",
      }),
    ]);
  });

  test("creates a managed headless Claude session with a preallocated id", async () => {
    const home = await createTemporaryHome();
    const fakeBin = join(home, "bin");
    const projectPath = join(home, "work", "example");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeExecutable(
      join(fakeBin, "claude"),
      `#!/bin/sh
if [ "$1" = "agents" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
[ "$1" = "--session-id" ] || exit 65
session_id="$2"
[ "$3" = "--name" ] || exit 66
[ "$4" = "build-investigation" ] || exit 67
[ "$5" = "--print" ] || exit 68
[ "$6" = "--output-format" ] || exit 69
[ "$7" = "json" ] || exit 70
IFS= read -r prompt
[ "$prompt" = "Investigate the failing build." ] || exit 71
printf '%s' "$session_id" > "$HOME/create-session-id"
printf '{"session_id":"%s","result":"Created"}\\n' "$session_id"
`,
    );

    const result = await runCli(
      [
        "@run",
        `await argc.call.create({ cwd: '${projectPath}', name: 'build-investigation', prompt: 'Investigate the failing build.' })`,
        "--json",
      ],
      {
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      session_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      run_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      status: "running",
      cwd: projectPath,
      name: "build-investigation",
    });
    await waitForFile(join(home, "create-session-id"));
    expect(await readFile(join(home, "create-session-id"), "utf8")).toBe(
      (JSON.parse(result.stdout) as { session_id: string }).session_id,
    );

    const listed = await runCli(["@run", "await argc.call.list({ all: true })", "--json"], {
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });
    expect(listed).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(listed.stdout)).toEqual({
      sessions: [
        expect.objectContaining({
          id: (JSON.parse(result.stdout) as { session_id: string }).session_id,
          name: "build-investigation",
          status: "idle",
          cwd: projectPath,
          kind: "managed",
        }),
      ],
    });
  });

  test("sends a new background turn to an idle session without changing its session id", async () => {
    const home = await createTemporaryHome();
    const fakeBin = join(home, "bin");
    const projectPath = join(home, "work", "example");
    const indexDirectory = join(home, ".claude", "projects", "-tmp-example");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await mkdir(indexDirectory, { recursive: true });
    const transcriptPath = join(indexDirectory, "session-1.jsonl");
    await writeFile(
      join(indexDirectory, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        originalPath: projectPath,
        entries: [
          {
            sessionId: "session-1",
            fullPath: transcriptPath,
            projectPath,
            isSidechain: false,
          },
        ],
      }),
    );
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "user",
        uuid: "user-before-send",
        sessionId: "session-1",
        message: { role: "user", content: "Initial turn" },
      })}\n`,
    );
    await writeExecutable(
      join(fakeBin, "claude"),
      `#!/bin/sh
if [ "$1" = "agents" ]; then
  if [ -f "$HOME/native-stopped" ]; then
    printf '%s\\n' '[]'
  else
    printf '%s\\n' '[{"sessionId":"session-1","status":"idle","cwd":"${projectPath}","kind":"background"}]'
  fi
  exit 0
fi
if [ "$1" = "stop" ] && [ "$2" = "session-" ]; then
  touch "$HOME/native-stopped"
  exit 0
fi
[ "$1" = "--resume" ] || exit 70
[ "$2" = "session-1" ] || exit 71
shift 2
[ "$1" = "--print" ] || exit 72
[ "$2" = "--output-format" ] || exit 73
[ "$3" = "json" ] || exit 74
IFS= read -r prompt
[ "$prompt" = "Continue with the failed tests." ] || exit 76
sleep 1
printf '%s\\n' '${JSON.stringify({
        type: "assistant",
        uuid: "assistant-after-send",
        sessionId: "session-1",
        message: { role: "assistant", content: "The failed tests now pass." },
      })}' >> '${transcriptPath}'
printf '%s\\n' '{"session_id":"session-1","result":"The failed tests now pass."}'
`,
    );

    const before = await runCli(["@run", "await argc.call.read({ id: 'session-1' })", "--json"], {
      HOME: home,
    });
    const beforeCursor = (JSON.parse(before.stdout) as { cursor: string }).cursor;

    const result = await runCli(
      [
        "@run",
        "await argc.call.send({ id: 'session-1', prompt: 'Continue with the failed tests.' })",
        "--json",
      ],
      {
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      session_id: "session-1",
      run_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      status: "running",
      cwd: projectPath,
    });
    await waitForFile(join(home, "native-stopped"));

    const waited = await runCli(
      [
        "@run",
        `await argc.call.wait({ id: 'session-1', after: '${beforeCursor}', timeoutMs: 3000 })`,
        "--json",
      ],
      {
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    );
    expect(waited).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(waited.stdout)).toMatchObject({
      session_id: "session-1",
      status: "idle",
      timed_out: false,
      messages: [
        {
          id: "assistant-after-send",
          role: "assistant",
          text: "The failed tests now pass.",
        },
      ],
    });
  });

  test("refuses to send a concurrent turn to a running session", async () => {
    const home = await createTemporaryHome();
    const fakeBin = join(home, "bin");
    const projectPath = join(home, "work", "example");
    await mkdir(fakeBin, { recursive: true });
    await writeExecutable(
      join(fakeBin, "claude"),
      `#!/bin/sh
if [ "$1" = "agents" ]; then
  printf '%s\\n' '[{"sessionId":"session-1","status":"running","cwd":"${projectPath}"}]'
  exit 0
fi
exit 90
`,
    );

    const result = await runCli(
      [
        "@run",
        "await argc.call.send({ id: 'session-1', prompt: 'Do not run concurrently.' })",
        "--json",
      ],
      {
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: DOMAIN_ERROR");
    expect(result.stderr).toContain("code: session_busy");
    expect(result.stderr).toContain("session_id: session-1");
    expect(result.stderr).not.toContain("RUNTIME_ERROR");
  });

  test("forks completed context into a managed headless Claude session", async () => {
    const home = await createTemporaryHome();
    const fakeBin = join(home, "bin");
    const projectPath = join(home, "work", "example");
    const indexDirectory = join(home, ".claude", "projects", "-tmp-example");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await mkdir(indexDirectory, { recursive: true });
    await writeFile(
      join(indexDirectory, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        originalPath: projectPath,
        entries: [
          {
            sessionId: "source-1",
            fullPath: join(indexDirectory, "source-1.jsonl"),
            projectPath,
            isSidechain: false,
          },
        ],
      }),
    );
    await writeExecutable(
      join(fakeBin, "claude"),
      `#!/bin/sh
if [ "$1" = "agents" ]; then
  printf '%s\\n' '[{"sessionId":"source-1","status":"idle","cwd":"${projectPath}"}]'
  exit 0
fi
[ "$1" = "--resume" ] || exit 80
[ "$2" = "source-1" ] || exit 81
[ "$3" = "--fork-session" ] || exit 82
[ "$4" = "--session-id" ] || exit 83
session_id="$5"
[ "$6" = "--print" ] || exit 84
[ "$7" = "--output-format" ] || exit 85
[ "$8" = "json" ] || exit 86
IFS= read -r prompt
[ "$prompt" = "Implement the alternative approach." ] || exit 87
printf '%s' "$session_id" > "$HOME/fork-session-id"
printf '{"session_id":"%s","result":"Forked"}\\n' "$session_id"
`,
    );

    const result = await runCli(
      [
        "@run",
        "await argc.call.fork({ id: 'source-1', prompt: 'Implement the alternative approach.' })",
        "--json",
      ],
      {
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      source_session_id: "source-1",
      session_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      run_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      status: "running",
      cwd: projectPath,
    });
    await waitForFile(join(home, "fork-session-id"));
    expect(await readFile(join(home, "fork-session-id"), "utf8")).toBe(
      (JSON.parse(result.stdout) as { session_id: string }).session_id,
    );
  });

  test("waits for a running session to become idle and returns its final text", async () => {
    const home = await createTemporaryHome();
    const fakeBin = join(home, "bin");
    const projectPath = join(home, "work", "example");
    const indexDirectory = join(home, ".claude", "projects", "-tmp-example");
    const transcriptPath = join(indexDirectory, "session-1.jsonl");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await mkdir(indexDirectory, { recursive: true });
    await writeFile(
      join(indexDirectory, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        originalPath: projectPath,
        entries: [
          {
            sessionId: "session-1",
            fullPath: transcriptPath,
            projectPath,
            isSidechain: false,
          },
        ],
      }),
    );
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        uuid: "assistant-final",
        sessionId: "session-1",
        timestamp: "2026-08-01T10:05:00.000Z",
        message: { role: "assistant", content: "The implementation is complete." },
      })}\n`,
    );
    await writeExecutable(
      join(fakeBin, "claude"),
      `#!/bin/sh
[ "$1" = "agents" ] || exit 91
counter_file="$HOME/agents-counter"
count=0
[ -f "$counter_file" ] && count=$(cat "$counter_file")
count=$((count + 1))
printf '%s' "$count" > "$counter_file"
if [ "$count" -eq 1 ]; then
  printf '%s\\n' '[{"sessionId":"session-1","status":"running","cwd":"${projectPath}"}]'
else
  printf '%s\\n' '[{"sessionId":"session-1","status":"idle","cwd":"${projectPath}"}]'
fi
`,
    );

    const result = await runCli(
      ["@run", "await argc.call.wait({ id: 'session-1', timeoutMs: 1000 })", "--json"],
      {
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      session_id: "session-1",
      status: "idle",
      timed_out: false,
      cursor: expect.any(String),
      messages: [
        {
          id: "assistant-final",
          role: "assistant",
          text: "The implementation is complete.",
          timestamp: "2026-08-01T10:05:00.000Z",
        },
      ],
    });
  });

  test("reports a managed Claude run failure instead of treating it as idle", async () => {
    const home = await createTemporaryHome();
    const fakeBin = join(home, "bin");
    const projectPath = join(home, "work", "example");
    const indexDirectory = join(home, ".claude", "projects", "-tmp-example");
    const transcriptPath = join(indexDirectory, "session-1.jsonl");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await mkdir(indexDirectory, { recursive: true });
    await writeFile(
      join(indexDirectory, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        originalPath: projectPath,
        entries: [
          {
            sessionId: "session-1",
            fullPath: transcriptPath,
            projectPath,
            isSidechain: false,
          },
        ],
      }),
    );
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        uuid: "assistant-before-failure",
        sessionId: "session-1",
        message: { role: "assistant", content: "Existing answer." },
      })}\n`,
    );
    await writeExecutable(
      join(fakeBin, "claude"),
      `#!/bin/sh
if [ "$1" = "agents" ]; then
  printf '%s\\n' '[{"sessionId":"session-1","status":"idle","cwd":"${projectPath}"}]'
  exit 0
fi
IFS= read -r prompt
sleep 0.1
printf '%s\\n' 'simulated Claude failure' >&2
exit 42
`,
    );

    const sent = await runCli(
      ["@run", "await argc.call.send({ id: 'session-1', prompt: 'Fail this run.' })", "--json"],
      { HOME: home, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    );
    expect(sent).toMatchObject({ exitCode: 0, stderr: "" });

    const waited = await runCli(
      ["@run", "await argc.call.wait({ id: 'session-1', timeoutMs: 1000 })", "--json"],
      { HOME: home, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    );

    expect(waited.exitCode).toBe(1);
    expect(waited.stdout).toBe("");
    expect(waited.stderr).toContain("error: DOMAIN_ERROR");
    expect(waited.stderr).toContain("code: claude_run_failed");
    expect(waited.stderr).toContain("session_id: session-1");
    expect(waited.stderr).toContain("stderr_path:");
    expect(waited.stderr).not.toContain("simulated Claude failure");
  });

  test("waits through the native background registration race", async () => {
    const home = await createTemporaryHome();
    const fakeBin = join(home, "bin");
    const projectPath = join(home, "work", "example");
    const indexDirectory = join(home, ".claude", "projects", "-tmp-example");
    const transcriptPath = join(indexDirectory, "new-session.jsonl");
    await mkdir(fakeBin, { recursive: true });
    await writeExecutable(
      join(fakeBin, "claude"),
      `#!/bin/sh
printf '%s\\n' '[{"sessionId":"new-session","status":"idle","cwd":"${projectPath}"}]'
`,
    );

    const registration = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void (async () => {
          try {
            await mkdir(indexDirectory, { recursive: true });
            await writeFile(
              transcriptPath,
              `${JSON.stringify({
                type: "assistant",
                uuid: "assistant-new",
                sessionId: "new-session",
                message: { role: "assistant", content: "Registered after startup." },
              })}\n`,
            );
            resolve();
          } catch (error) {
            reject(error);
          }
        })();
      }, 1000);
    });

    const result = await runCli(
      ["@run", "await argc.call.wait({ id: 'new-session', timeoutMs: 3000 })", "--json"],
      {
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    );
    await registration;

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      session_id: "new-session",
      status: "idle",
      timed_out: false,
      messages: [{ id: "assistant-new", role: "assistant", text: "Registered after startup." }],
    });
  });

  test("interrupts the process currently owned by a running Claude session", async () => {
    const home = await createTemporaryHome();
    const fakeBin = join(home, "bin");
    await mkdir(fakeBin, { recursive: true });
    const worker = spawn(process.execPath, [
      "-e",
      "process.on('SIGINT', () => process.exit(130)); console.log('ready'); setInterval(() => {}, 1000);",
    ]);
    if (!worker.pid) throw new Error("Expected the worker process to have a pid.");
    await new Promise<void>((resolve) => {
      worker.stdout.once("data", () => resolve());
    });
    await writeExecutable(
      join(fakeBin, "claude"),
      `#!/bin/sh
if [ "$1" = "agents" ]; then
  printf '%s\\n' '[{"sessionId":"session-1","status":"running","cwd":"/tmp","pid":${worker.pid}}]'
  exit 0
fi
exit 92
`,
    );

    try {
      const result = await runCli(
        ["@run", "await argc.call.interrupt({ id: 'session-1' })", "--json"],
        {
          HOME: home,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      );

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        session_id: "session-1",
        status: "interrupted",
        pid: worker.pid,
      });
      const close = await waitForClose(worker, 1000);
      expect(close).toEqual({ code: 130, signal: null });
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    }
  });

  test("interrupts a managed Claude process group", async () => {
    const home = await createTemporaryHome();
    const fakeBin = join(home, "bin");
    const projectPath = join(home, "work", "example");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeExecutable(
      join(fakeBin, "claude"),
      `#!/bin/sh
if [ "$1" = "agents" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
trap 'printf stopped > "$HOME/managed-interrupted"; exit 130' INT TERM
printf started > "$HOME/managed-started"
while :; do sleep 1; done
`,
    );

    const created = await runCli(
      [
        "@run",
        `await argc.call.create({ cwd: '${projectPath}', prompt: 'Keep working.' })`,
        "--json",
      ],
      { HOME: home, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    );
    const sessionId = (JSON.parse(created.stdout) as { session_id: string }).session_id;
    await waitForFile(join(home, "managed-started"));

    const snapshot = await runCli(
      ["@run", `await argc.call.wait({ id: '${sessionId}', timeoutMs: 0 })`, "--json"],
      { HOME: home, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    );
    expect(snapshot).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(snapshot.stdout)).toEqual({
      session_id: sessionId,
      status: "running",
      timed_out: true,
      cursor: expect.any(String),
      messages: [],
    });

    const interrupted = await runCli(
      ["@run", `await argc.call.interrupt({ id: '${sessionId}' })`, "--json"],
      { HOME: home, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    );

    expect(interrupted).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(interrupted.stdout)).toMatchObject({
      session_id: sessionId,
      status: "interrupted",
      pid: expect.any(Number),
    });
    await waitForFile(join(home, "managed-interrupted"));
  });
});

async function createTemporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "claude-session-home-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (true) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function runCli(
  args: string[],
  environment: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processHandle = spawn("bun", ["src/main.ts", ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...environment },
  });
  let stdout = "";
  let stderr = "";
  processHandle.stdout.setEncoding("utf8");
  processHandle.stderr.setEncoding("utf8");
  processHandle.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  processHandle.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    processHandle.once("error", reject);
    processHandle.once("close", (code) => resolve(code ?? 1));
  });

  return { exitCode, stdout, stderr };
}

async function waitForClose(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Timed out waiting for child process to close.")),
        timeoutMs,
      );
    }),
  ]);
}
