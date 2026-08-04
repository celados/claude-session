import { describe, expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleTransportRequest } from "../src/transport-server.ts";

describe("Feature 1: Private transport server", () => {
  test("1.7 rejects a protocol mismatch before invoking a mutating operation", async () => {
    let dispatched = false;

    const response = await handleTransportRequest(
      { protocol_version: 2, operation: "send", input: { id: "S", prompt: "bad" } },
      async () => {
        dispatched = true;
        return {};
      },
    );

    expect(dispatched).toBe(false);
    expect(response).toMatchObject({ ok: false, error: { code: "version_mismatch" } });
  });

  test("main dispatches @transport before argc and writes one JSON envelope", async () => {
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const child = spawn("bun", ["src/main.ts", "@transport"], { cwd: projectRoot });
    child.stdin.end(
      JSON.stringify({ protocol_version: 2, operation: "send", input: { prompt: "unsafe" } }),
    );
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

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      error: { code: "version_mismatch" },
    });
  });
});
