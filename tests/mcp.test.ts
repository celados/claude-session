import { afterEach, describe, expect, test } from "vite-plus/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import packageJson from "../package.json" with { type: "json" };

const temporaryDirectories: string[] = [];
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("claude-session MCP server", () => {
  test("advertises and invokes the public session lifecycle tools over stdio", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-session-mcp-home-"));
    temporaryDirectories.push(home);
    const fakeBin = join(home, "bin");
    await mkdir(fakeBin, { recursive: true });
    await writeExecutable(
      join(fakeBin, "claude"),
      `#!/bin/sh
if [ "$1" = "agents" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
exit 64
`,
    );

    const server = new McpTestClient({
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });
    try {
      const initialized = await server.request<{
        serverInfo: { name: string; version: string };
        capabilities: { tools: Record<string, unknown> };
        instructions: string;
      }>(1, "initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "claude-session-test", version: "1.0.0" },
      });
      expect(initialized).toMatchObject({
        serverInfo: { name: "claude-session", version: packageJson.version },
        capabilities: { tools: {} },
        instructions: expect.stringContaining("Use create_session for new work"),
      });
      server.notify("notifications/initialized", {});

      const listedTools = await server.request<{
        tools: Array<{ name: string; [key: string]: unknown }>;
      }>(2, "tools/list", {});
      expect(listedTools.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "list_sessions",
        "read_session",
        "create_session",
        "send_to_session",
        "fork_session",
        "wait_for_session",
        "interrupt_session",
        "export_session",
        "import_session",
        "handoff_session",
      ]);
      expect(listedTools.tools[0]).toMatchObject({
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: "object",
          properties: expect.objectContaining({ host: { type: "string" } }),
        },
      });
      expect(listedTools.tools.find((tool) => tool.name === "send_to_session")).toMatchObject({
        inputSchema: {
          properties: expect.objectContaining({ host: { type: "string" } }),
        },
      });
      expect(listedTools.tools.find((tool) => tool.name === "export_session")).toMatchObject({
        inputSchema: {
          properties: expect.objectContaining({
            host: { type: "string" },
            handoffTimeoutMs: expect.any(Object),
          }),
        },
      });

      const called = await server.request<{
        content: Array<{ type: string; text: string }>;
        structuredContent: Record<string, unknown>;
      }>(3, "tools/call", {
        name: "list_sessions",
        arguments: { all: true },
      });
      expect(called).toEqual({
        content: [{ type: "text", text: '{"sessions":[]}' }],
        structuredContent: { sessions: [] },
      });
    } finally {
      await server.close();
    }
  });
});

class McpTestClient {
  readonly process: ChildProcessWithoutNullStreams;
  readonly responses = new Map<number, (value: Record<string, unknown>) => void>();
  stderr = "";

  constructor(environment: Record<string, string>) {
    this.process = spawn("bun", ["src/mcp.ts"], {
      cwd: projectRoot,
      env: { ...process.env, ...environment },
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      const message = JSON.parse(line) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: unknown;
      };
      if (message.id === undefined) return;
      const resolve = this.responses.get(message.id);
      if (!resolve) return;
      this.responses.delete(message.id);
      if (message.error) throw new Error(JSON.stringify(message.error));
      resolve(message.result ?? {});
    });
  }

  async request<Result extends Record<string, unknown>>(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result> {
    const result = new Promise<Record<string, unknown>>((resolve) => {
      this.responses.set(id, resolve);
    });
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return (await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error(`MCP request timed out: ${method}\n${this.stderr}`)),
          10_000,
        );
      }),
    ])) as Result;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    if (this.process.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.process.kill("SIGKILL");
        resolve();
      }, 1_000);
      this.process.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}
