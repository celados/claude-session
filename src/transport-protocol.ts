import * as v from "valibot";

import { SessionControllerError } from "./session-error.ts";

export const TRANSPORT_PROTOCOL_VERSION = 1;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

const operationValidator = v.picklist([
  "list",
  "read",
  "create",
  "send",
  "fork",
  "wait",
  "interrupt",
  "export",
  "import",
]);

const transportRequestValidator = v.object({
  protocol_version: v.number(),
  operation: operationValidator,
  input: v.record(v.string(), v.unknown()),
});

const transportErrorValidator = v.object({
  code: v.string(),
  message: v.string(),
  details: v.record(v.string(), v.unknown()),
});

const transportResponseValidator = v.variant("ok", [
  v.object({ ok: v.literal(true), result: v.record(v.string(), v.unknown()) }),
  v.object({ ok: v.literal(false), error: transportErrorValidator }),
]);

export type TransportOperation = v.InferOutput<typeof operationValidator>;
export type TransportRequest = v.InferOutput<typeof transportRequestValidator>;
export type TransportError = {
  code: string;
  message: string;
  details: Record<string, unknown>;
};
export type TransportResponse =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: TransportError };

export function parseTransportRequest(value: unknown): TransportRequest {
  const request = v.parse(transportRequestValidator, value);
  if (request.protocol_version !== TRANSPORT_PROTOCOL_VERSION) {
    throw new SessionControllerError(
      "version_mismatch",
      "The remote transport protocol version is incompatible.",
      {
        local_protocol_version: TRANSPORT_PROTOCOL_VERSION,
        remote_protocol_version: request.protocol_version,
      },
    );
  }
  return request;
}

export function parseTransportResponse(value: unknown): TransportResponse {
  return v.parse(transportResponseValidator, value);
}

export function encodeBundle(bundle: Uint8Array): string {
  assertBundleSize(bundle.byteLength);
  return Buffer.from(bundle).toString("base64");
}

export function decodeBundle(encoded: string): Uint8Array {
  const approximateBytes = Math.floor((encoded.length * 3) / 4);
  assertBundleSize(approximateBytes);
  if (!isValidBase64(encoded)) {
    throw new SessionControllerError(
      "bundle_invalid",
      "The bundle payload is not valid base64.",
      {},
    );
  }
  const bundle = Buffer.from(encoded, "base64");
  assertBundleSize(bundle.byteLength);
  return bundle;
}

function isValidBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  let paddingStarted = false;
  let padding = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x3d) {
      paddingStarted = true;
      padding++;
      if (padding > 2 || index < value.length - 2) return false;
      continue;
    }
    if (paddingStarted) return false;
    const valid =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!valid) return false;
  }
  return true;
}

export function assertBundleSize(bytes: number): void {
  if (bytes > MAX_BUNDLE_BYTES) {
    throw new SessionControllerError(
      "bundle_too_large",
      "The bundle exceeds the 64 MiB v1 transport limit.",
      { bytes, max_bytes: MAX_BUNDLE_BYTES },
    );
  }
}

export function transportFailure(error: unknown): TransportResponse {
  if (error instanceof SessionControllerError) {
    return {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }
  return {
    ok: false,
    error: {
      code: "claude_session_error",
      message: error instanceof Error ? error.message : "Claude session operation failed.",
      details: {},
    },
  };
}
