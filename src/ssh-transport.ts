import { spawn } from "node:child_process";

import { SessionControllerError, type SessionErrorCode } from "./session-error.ts";
import type { HostTarget } from "./host-config.ts";
import {
  parseTransportResponse,
  TRANSPORT_PROTOCOL_VERSION,
  type TransportOperation,
} from "./transport-protocol.ts";

export async function callRemote(
  target: HostTarget,
  operation: TransportOperation,
  input: Record<string, unknown>,
  environment: Record<string, string | undefined> = process.env,
): Promise<Record<string, unknown>> {
  const args = ["-o", "BatchMode=yes", target.host, target.bin, "@transport"];
  const child = spawn("ssh", args, {
    env: environment,
  });
  const request = JSON.stringify({
    protocol_version: TRANSPORT_PROTOCOL_VERSION,
    operation,
    input,
  });
  child.stdin.end(request);
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
  if (exitCode === 127) {
    throw new SessionControllerError(
      "remote_cli_missing",
      "The remote claude-session CLI is missing; install it or configure bin in hosts.json.",
      { host: target.host, path: target.bin },
    );
  }
  if (exitCode !== 0) {
    throw new SessionControllerError("host_unreachable", "The SSH transport call failed.", {
      host: target.host,
      exit_code: exitCode,
      stderr: stderr.trim(),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new SessionControllerError(
      "host_unreachable",
      "The remote host returned an invalid transport response.",
      { host: target.host },
    );
  }
  const response = parseTransportResponse(parsed);
  if (!response.ok) {
    throw new SessionControllerError(
      response.error.code as SessionErrorCode,
      response.error.message,
      response.error.details,
    );
  }
  return response.result;
}
