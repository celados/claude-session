import { describe, expect, test } from "vite-plus/test";

import {
  MAX_BUNDLE_BYTES,
  decodeBundle,
  parseTransportRequest,
} from "../src/transport-protocol.ts";

describe("Feature 1: Private transport protocol", () => {
  test("1.7 rejects an incompatible protocol before dispatch", () => {
    expect(() =>
      parseTransportRequest({ protocol_version: 2, operation: "list", input: { all: false } }),
    ).toThrow("protocol version");
  });

  test("accepts a versioned request envelope", () => {
    expect(
      parseTransportRequest({ protocol_version: 1, operation: "send", input: { id: "S" } }),
    ).toEqual({ protocol_version: 1, operation: "send", input: { id: "S" } });
  });

  test("rejects base64 bundles larger than the v1 limit", () => {
    expect(() => decodeBundle(Buffer.alloc(MAX_BUNDLE_BYTES + 1).toString("base64"))).toThrow(
      "64 MiB",
    );
  });
});
