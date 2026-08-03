#!/usr/bin/env bun

import { cli } from "argc";

import packageJson from "../package.json" with { type: "json" };
import { handlers } from "./handlers.ts";
import { schema } from "./schema.ts";

const app = cli(schema, {
  name: "claude-session",
  version: packageJson.version,
  description: "Machine-readable Claude Code session control for agent workflows.",
});

await app.run({ handlers }, process.argv.slice(2));
