#!/usr/bin/env bun

import { cli } from "argc";

import packageJson from "../package.json" with { type: "json" };
import { handlers } from "./handlers.ts";
import { schema } from "./schema.ts";
import { runTransportServer } from "./transport-server.ts";

const app = cli(schema, {
  name: "claude-session",
  version: packageJson.version,
  description: "Machine-readable Claude Code session control for agent workflows.",
});

if (process.argv[2] === "@transport") {
  await runTransportServer();
} else {
  const args = process.argv.slice(2);
  if (args[0] === "export") args[0] = "export-session";
  if (args[0] === "import") args[0] = "import-session";
  await app.run({ handlers }, args);
}
