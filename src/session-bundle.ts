import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

import * as v from "valibot";

import { SessionControllerError } from "./session-error.ts";
import { assertBundleSize, TRANSPORT_PROTOCOL_VERSION } from "./transport-protocol.ts";

const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;

const bundleFileValidator = v.object({
  path: v.string(),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const bundleManifestValidator = v.object({
  version: v.literal(1),
  protocol_version: v.literal(TRANSPORT_PROTOCOL_VERSION),
  session_id: v.string(),
  source_host: v.string(),
  cwd: v.string(),
  name: v.optional(v.string()),
  exported_at: v.number(),
  tool_version: v.string(),
  handoff: v.boolean(),
  files: v.array(bundleFileValidator),
});

export type BundleFile = v.InferOutput<typeof bundleFileValidator>;
export type BundleManifest = v.InferOutput<typeof bundleManifestValidator>;
export type BundleManifestInput = Omit<BundleManifest, "files">;
export type ParsedBundle = {
  manifest: BundleManifest;
  files: Map<string, Buffer>;
};

export function createBundleArchive(
  manifestInput: BundleManifestInput | BundleManifest,
  files: Map<string, Buffer>,
): Uint8Array {
  if (!files.has("transcript.jsonl")) {
    throw bundleInvalid("The bundle is missing transcript.jsonl.");
  }
  for (const path of files.keys()) assertSafeBundlePath(path);
  const inventory = [...files.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map((entry) => inventoryEntry(entry[0], entry[1]));
  const manifest = v.parse(bundleManifestValidator, {
    ...manifestInput,
    files: "files" in manifestInput ? manifestInput.files : inventory,
  });
  const entries = new Map<string, Buffer>([
    ["manifest.json", Buffer.from(`${JSON.stringify(manifest)}\n`)],
    ...files.entries(),
  ]);
  const archive = gzipSync(createTar(entries), { level: 9 });
  assertBundleSize(archive.byteLength);
  return archive;
}

export function parseBundleArchive(bundle: Uint8Array): ParsedBundle {
  assertBundleSize(bundle.byteLength);
  let tar: Buffer;
  try {
    tar = gunzipSync(bundle, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch (error) {
    throw bundleInvalid(`The bundle is not a valid gzip archive: ${messageOf(error)}`);
  }
  if (tar.byteLength > MAX_UNCOMPRESSED_BYTES) {
    throw bundleInvalid("The expanded bundle exceeds the 64 MiB v1 limit.");
  }
  const entries = parseTar(tar);
  const manifestContents = entries.get("manifest.json");
  if (!manifestContents) throw bundleInvalid("The bundle is missing manifest.json.");
  let manifest: BundleManifest;
  try {
    manifest = v.parse(bundleManifestValidator, JSON.parse(manifestContents.toString("utf8")));
  } catch (error) {
    throw bundleInvalid(`The bundle manifest is invalid: ${messageOf(error)}`);
  }
  entries.delete("manifest.json");
  if (!entries.has("transcript.jsonl"))
    throw bundleInvalid("The bundle is missing transcript.jsonl.");
  verifyInventory(manifest.files, entries);
  return { manifest, files: entries };
}

export function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function createTar(entries: Map<string, Buffer>): Buffer {
  const chunks: Buffer[] = [];
  for (const [path, contents] of entries) {
    assertSafeBundlePath(path);
    const header = createTarHeader(path, contents.byteLength);
    chunks.push(header, contents);
    const padding = paddedSize(contents.byteLength) - contents.byteLength;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  return Buffer.concat(chunks);
}

function createTarHeader(path: string, bytes: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  const split = splitTarPath(path);
  writeString(header, split.name, 0, 100);
  writeOctal(header, 0o600, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, bytes, 124, 12);
  writeOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeString(header, "ustar", 257, 6);
  writeString(header, "00", 263, 2);
  if (split.prefix) writeString(header, split.prefix, 345, 155);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  const encodedChecksum = `${checksum.toString(8).padStart(6, "0")}\0 `;
  header.write(encodedChecksum, 148, 8, "ascii");
  return header;
}

function parseTar(tar: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + TAR_BLOCK_BYTES <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) return entries;
    verifyTarHeaderChecksum(header);
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    assertSafeBundlePath(path);
    if (entries.has(path)) throw bundleInvalid(`Duplicate bundle entry: ${path}`);
    const type = header[156];
    if (type !== 0 && type !== 0x30) {
      throw bundleInvalid(`Unsupported bundle entry type for ${path}.`);
    }
    const bytes = readOctal(header, 124, 12);
    const contentStart = offset + TAR_BLOCK_BYTES;
    const contentEnd = contentStart + bytes;
    if (contentEnd > tar.byteLength) throw bundleInvalid(`Truncated bundle entry: ${path}`);
    entries.set(path, Buffer.from(tar.subarray(contentStart, contentEnd)));
    offset = contentStart + paddedSize(bytes);
  }
  throw bundleInvalid("The tar archive is truncated.");
}

function verifyInventory(inventory: BundleFile[], files: Map<string, Buffer>): void {
  const seen = new Set<string>();
  for (const item of inventory) {
    assertSafeBundlePath(item.path);
    if (seen.has(item.path)) throw bundleInvalid(`Duplicate manifest entry: ${item.path}`);
    seen.add(item.path);
    const contents = files.get(item.path);
    if (!contents) throw bundleInvalid(`Manifest file is missing: ${item.path}`);
    if (contents.byteLength !== item.bytes) {
      throw bundleInvalid(`Bundle byte count does not match for ${item.path}.`);
    }
    if (sha256(contents) !== item.sha256) {
      throw bundleInvalid(`Bundle checksum does not match for ${item.path}.`);
    }
  }
  for (const path of files.keys()) {
    if (!seen.has(path)) throw bundleInvalid(`Bundle file is not inventoried: ${path}`);
  }
}

function inventoryEntry(path: string, contents: Buffer): BundleFile {
  return { path, sha256: sha256(contents), bytes: contents.byteLength };
}

function assertSafeBundlePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw bundleInvalid(`Unsafe bundle path: ${path}`);
  }
}

function splitTarPath(path: string): { name: string; prefix?: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw bundleInvalid(`Bundle path is too long: ${path}`);
}

function verifyTarHeaderChecksum(header: Buffer): void {
  const expected = readOctal(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = [...copy].reduce((sum, byte) => sum + byte, 0);
  if (expected !== actual) throw bundleInvalid("The tar header checksum is invalid.");
}

function writeString(buffer: Buffer, value: string, offset: number, length: number): void {
  if (Buffer.byteLength(value) > length) throw bundleInvalid(`Tar field is too long: ${value}`);
  buffer.write(value, offset, length, "utf8");
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  if (encoded.length > length) throw bundleInvalid("Tar numeric field exceeds v1 limits.");
  buffer.write(encoded, offset, length, "ascii");
}

function readString(buffer: Buffer, offset: number, length: number): string {
  const value = buffer.subarray(offset, offset + length);
  const nul = value.indexOf(0);
  return value.subarray(0, nul < 0 ? value.length : nul).toString("utf8");
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const value = readString(buffer, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw bundleInvalid("The tar archive has an invalid numeric field.");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw bundleInvalid("Invalid tar size.");
  return parsed;
}

function paddedSize(bytes: number): number {
  return Math.ceil(bytes / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
}

function bundleInvalid(message: string): SessionControllerError {
  return new SessionControllerError("bundle_invalid", message, {});
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
