import type { InferHandlers } from "argc";

import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { c } from "argc";
import * as v from "valibot";

const s = toStandardJsonSchema;

const list = c
  .meta({
    description: "List active Claude agents and resumable historical sessions.",
    examples: [
      "claude-session list --all",
      'claude-session @run "await argc.call.list({ all: true })" --json',
    ],
  })
  .input(
    s(
      v.object({
        all: v.optional(v.boolean(), false),
      }),
    ),
  );

const read = c
  .meta({
    description: "Read normalized user and assistant text from one Claude session.",
    examples: [
      "claude-session read --id SESSION_ID",
      `claude-session @run "await argc.call.read({ id: 'SESSION_ID' })" --json`,
    ],
  })
  .input(s(v.object({ id: v.string(), after: v.optional(v.string()) })));

const create = c
  .meta({
    description: "Create a named managed Claude session in one working directory.",
    examples: [
      "claude-session create --cwd ./repo --name investigation --prompt 'Investigate the failure.'",
    ],
  })
  .input(
    s(
      v.object({
        cwd: v.string(),
        name: v.optional(v.string()),
        prompt: v.string(),
      }),
    ),
  );

const send = c
  .meta({
    description: "Send a new managed turn to an idle Claude session without changing its id.",
    examples: ["claude-session send --id SESSION_ID --prompt 'Continue the investigation.'"],
  })
  .input(s(v.object({ id: v.string(), prompt: v.string() })));

const fork = c
  .meta({
    description: "Fork completed Claude context into a new managed session.",
    examples: ["claude-session fork --id SESSION_ID --prompt 'Try another approach.'"],
  })
  .input(s(v.object({ id: v.string(), prompt: v.string() })));

const wait = c
  .meta({
    description: "Wait until a Claude session stops running or the bounded timeout expires.",
    examples: ["claude-session wait --id SESSION_ID --timeoutMs 30000"],
  })
  .input(
    s(
      v.object({
        id: v.string(),
        after: v.optional(v.string()),
        timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 30_000),
      }),
    ),
  );

const interrupt = c
  .meta({
    description: "Interrupt the process group for a currently running Claude session.",
    examples: ["claude-session interrupt --id SESSION_ID"],
  })
  .input(s(v.object({ id: v.string() })));

export const schema = { list, read, create, send, fork, wait, interrupt };

export type AppHandlers = InferHandlers<typeof schema>;
