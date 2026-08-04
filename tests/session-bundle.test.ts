import { describe, expect, test } from "vite-plus/test";
import { gzipSync } from "node:zlib";

import {
  createBundleArchive,
  parseBundleArchive,
  type BundleManifest,
} from "../src/session-bundle.ts";

describe("Feature 3: Export bundle", () => {
  test("3.1 preserves the complete transcript and inventories resume sidecars", () => {
    const transcript = Buffer.from('{"sessionId":"S","type":"user"}\n');
    const result = createFixture([
      { path: "transcript.jsonl", data: transcript },
      { path: "sidecars/tool-results/result.txt", data: Buffer.from("large result") },
      { path: "sidecars/subagents/agent-a.jsonl", data: Buffer.from("subagent") },
    ]);

    const parsed = parseBundleArchive(result);

    expect(parsed.manifest.session_id).toBe("S");
    expect(parsed.files.get("transcript.jsonl")).toEqual(transcript);
    expect(parsed.manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "transcript.jsonl", bytes: transcript.byteLength }),
        expect.objectContaining({ path: "sidecars/tool-results/result.txt" }),
        expect.objectContaining({ path: "sidecars/subagents/agent-a.jsonl" }),
      ]),
    );
  });

  test("4.5 rejects a checksum mismatch", () => {
    const archive = createFixture([{ path: "transcript.jsonl", data: Buffer.from("original") }]);
    const parsed = parseBundleArchive(archive);
    const badManifest: BundleManifest = {
      ...parsed.manifest,
      files: parsed.manifest.files.map((file) => ({ ...file, sha256: "0".repeat(64) })),
    };
    const tampered = createBundleArchive(badManifest, parsed.files);

    expect(() => parseBundleArchive(tampered)).toThrow("checksum");
  });

  test.each(["../escape", "/absolute", "sidecars/../../escape"])(
    "4.5 rejects unsafe archive path %s",
    (path) => {
      const manifest = baseManifest();
      expect(() =>
        createBundleArchive(
          manifest,
          new Map([
            ["transcript.jsonl", Buffer.from("valid")],
            [path, Buffer.from("bad")],
          ]),
        ),
      ).toThrow("Unsafe bundle path");
    },
  );

  test("4.5 rejects a truncated gzip archive", () => {
    const archive = createFixture([{ path: "transcript.jsonl", data: Buffer.from("data") }]);
    expect(() => parseBundleArchive(archive.subarray(0, archive.length - 8))).toThrow(
      "valid gzip archive",
    );
  });

  test("4.5 rejects unsupported tar entry types", () => {
    const header = Buffer.alloc(512);
    header.write("link", 0, "utf8");
    header.write("0000777\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write("00000000000\0", 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.fill(0x20, 148, 156);
    header.write("2", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    const archive = gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));

    expect(() => parseBundleArchive(archive)).toThrow("Unsupported bundle entry type");
  });
});

function createFixture(files: Array<{ path: string; data: Buffer }>): Uint8Array {
  const fileMap = new Map(files.map((file) => [file.path, file.data]));
  return createBundleArchive(baseManifest(), fileMap);
}

function baseManifest(): Omit<BundleManifest, "files"> {
  return {
    version: 1,
    protocol_version: 1,
    session_id: "S",
    source_host: "local",
    cwd: "/tmp/project",
    exported_at: 1,
    tool_version: "0.1.0",
    handoff: false,
  };
}
