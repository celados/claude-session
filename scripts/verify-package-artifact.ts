import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type PackResult = Readonly<{
  filename: string;
  files?: readonly Readonly<{ path: string }>[];
}>;

type PackageJson = Readonly<{
  name?: unknown;
  version?: unknown;
  private?: unknown;
}>;

const allowedTopLevelEntries = new Set(["README.md", "package.json", "src"]);
const forbiddenPathPattern =
  /(^|\/)(?:\.env(?:\..*)?|\.npmrc|bunfig\.toml|[^/]*\.test\.[^/]+|__tests__|plugins?|scripts?)(?:\/|$)/i;
const secretMaterialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
] as const;

const packageRoot = resolve(import.meta.dir, "..");
const outputDirectory = parseOutputDirectory(Bun.argv.slice(2));
const temporaryRoot = await mkdtemp(join(tmpdir(), "claude-session-artifact-"));

try {
  const packDirectory = join(temporaryRoot, "pack");
  const consumerDirectory = join(temporaryRoot, "consumer");
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(consumerDirectory, { recursive: true }),
  ]);
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as PackageJson;
  if (packageJson.name !== "claude-session" || typeof packageJson.version !== "string") {
    throw new Error("The package must be named claude-session and have a string version.");
  }
  if (packageJson.private !== true) {
    throw new Error("The package must remain private to prevent registry publication.");
  }

  const packed = await runCommand(
    ["npm", "pack", "--json", "--pack-destination", packDirectory, packageRoot],
    temporaryRoot,
  );
  const packResult = (JSON.parse(packed.stdout) as PackResult[])[0];
  if (!packResult?.filename || !packResult.files) {
    throw new Error("npm pack did not report the artifact contents.");
  }
  await verifyPackageContents(packResult.files.map((file) => file.path));

  const tarballPath = join(packDirectory, packResult.filename);
  const globalDirectory = join(consumerDirectory, "global");
  const globalBinDirectory = join(consumerDirectory, "bin");
  await runCommand(["bun", "add", "--global", `claude-session@${tarballPath}`], consumerDirectory, {
    BUN_INSTALL_GLOBAL_DIR: globalDirectory,
    BUN_INSTALL_BIN: globalBinDirectory,
    BUN_INSTALL_CACHE_DIR: join(consumerDirectory, "cache"),
  });

  const cli = join(globalBinDirectory, "claude-session");
  const mcp = join(globalBinDirectory, "claude-session-mcp");
  const version = (await runCommand([cli, "--version"], consumerDirectory)).stdout.trim();
  if (version !== packageJson.version) {
    throw new Error(`Installed CLI returned version ${version}, expected ${packageJson.version}.`);
  }
  await verifyMcpHandshake(mcp, consumerDirectory, packageJson.version);

  if (outputDirectory) {
    await writeReleaseAssets(tarballPath, packageJson.version, outputDirectory);
  }
  process.stdout.write(`Verified installable artifact: ${packResult.filename}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function parseOutputDirectory(arguments_: readonly string[]): string | undefined {
  if (arguments_.length === 0) return undefined;
  if (arguments_.length !== 2 || arguments_[0] !== "--output-dir" || !arguments_[1]) {
    throw new Error("Usage: verify-package-artifact.ts [--output-dir <directory>]");
  }
  return resolve(arguments_[1]);
}

async function verifyPackageContents(paths: readonly string[]): Promise<void> {
  for (const required of ["package.json", "src/main.ts", "src/mcp.ts"]) {
    if (!paths.includes(required)) throw new Error(`The package is missing ${required}.`);
  }
  for (const path of paths) {
    const topLevelEntry = path.split("/", 1)[0];
    if (!topLevelEntry || !allowedTopLevelEntries.has(topLevelEntry)) {
      throw new Error(`Unexpected package entry: ${path}`);
    }
    if (forbiddenPathPattern.test(path)) throw new Error(`Forbidden package entry: ${path}`);
    const content = await readFile(join(packageRoot, path), "utf8");
    if (secretMaterialPatterns.some((pattern) => pattern.test(content))) {
      throw new Error(`Potential secret material found in package entry: ${path}`);
    }
  }
}

async function verifyMcpHandshake(
  executable: string,
  cwd: string,
  expectedVersion: string,
): Promise<void> {
  const child = Bun.spawn([executable], {
    cwd,
    env: Bun.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "artifact-verifier", version: "1.0.0" },
      },
    })}\n`,
  );
  await child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Installed MCP server failed:\n${stderr}`.trimEnd());
  const response = JSON.parse(stdout.trim()) as {
    result?: { serverInfo?: { name?: unknown; version?: unknown } };
  };
  if (
    response.result?.serverInfo?.name !== "claude-session" ||
    response.result.serverInfo.version !== expectedVersion
  ) {
    throw new Error("Installed MCP server returned unexpected server metadata.");
  }
}

async function writeReleaseAssets(
  tarballPath: string,
  version: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const exactName = `claude-session-${version}.tgz`;
  const stableName = "claude-session.tgz";
  await copyFile(tarballPath, join(destination, exactName), constants.COPYFILE_EXCL);
  await copyFile(tarballPath, join(destination, stableName), constants.COPYFILE_EXCL);
  const digest = createHash("sha256")
    .update(await readFile(tarballPath))
    .digest("hex");
  await writeFile(
    join(destination, "SHA256SUMS"),
    `${digest}  ${exactName}\n${digest}  ${stableName}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  additionalEnvironment: Readonly<Record<string, string>> = {},
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn([...command], {
    cwd,
    env: { ...Bun.env, ...additionalEnvironment, CI: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${exitCode}): ${command.map((value) => basename(value)).join(" ")}\n${stdout}${stderr}`.trimEnd(),
    );
  }
  return { stdout, stderr };
}
