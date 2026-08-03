import type { InferHandlers } from "argc";

import { toJsonSchema, toStandardJsonSchema } from "@valibot/to-json-schema";
import { c } from "argc";
import * as v from "valibot";

export const inputValidators = {
  list: v.object({
    all: v.optional(v.boolean(), false),
  }),
  read: v.object({ id: v.string(), after: v.optional(v.string()) }),
  create: v.object({
    cwd: v.string(),
    name: v.optional(v.string()),
    prompt: v.string(),
  }),
  send: v.object({ id: v.string(), prompt: v.string() }),
  fork: v.object({ id: v.string(), prompt: v.string() }),
  wait: v.object({
    id: v.string(),
    after: v.optional(v.string()),
    timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 30_000),
  }),
  interrupt: v.object({ id: v.string() }),
};

export const inputJsonSchemas = {
  list: toJsonSchema(inputValidators.list),
  read: toJsonSchema(inputValidators.read),
  create: toJsonSchema(inputValidators.create),
  send: toJsonSchema(inputValidators.send),
  fork: toJsonSchema(inputValidators.fork),
  wait: toJsonSchema(inputValidators.wait),
  interrupt: toJsonSchema(inputValidators.interrupt),
};

const inputStandardSchemas = {
  list: toStandardJsonSchema(inputValidators.list),
  read: toStandardJsonSchema(inputValidators.read),
  create: toStandardJsonSchema(inputValidators.create),
  send: toStandardJsonSchema(inputValidators.send),
  fork: toStandardJsonSchema(inputValidators.fork),
  wait: toStandardJsonSchema(inputValidators.wait),
  interrupt: toStandardJsonSchema(inputValidators.interrupt),
};

const list = c
  .meta({
    description: "List active Claude agents and resumable historical sessions.",
    examples: [
      "claude-session list --all",
      'claude-session @run "await argc.call.list({ all: true })" --json',
    ],
  })
  .input(inputStandardSchemas.list);

const read = c
  .meta({
    description: "Read normalized user and assistant text from one Claude session.",
    examples: [
      "claude-session read --id SESSION_ID",
      `claude-session @run "await argc.call.read({ id: 'SESSION_ID' })" --json`,
    ],
  })
  .input(inputStandardSchemas.read);

const create = c
  .meta({
    description: "Create a named managed Claude session in one working directory.",
    examples: [
      "claude-session create --cwd ./repo --name investigation --prompt 'Investigate the failure.'",
    ],
  })
  .input(inputStandardSchemas.create);

const send = c
  .meta({
    description: "Send a new managed turn to an idle Claude session without changing its id.",
    examples: ["claude-session send --id SESSION_ID --prompt 'Continue the investigation.'"],
  })
  .input(inputStandardSchemas.send);

const fork = c
  .meta({
    description: "Fork completed Claude context into a new managed session.",
    examples: ["claude-session fork --id SESSION_ID --prompt 'Try another approach.'"],
  })
  .input(inputStandardSchemas.fork);

const wait = c
  .meta({
    description: "Wait until a Claude session stops running or the bounded timeout expires.",
    examples: ["claude-session wait --id SESSION_ID --timeoutMs 30000"],
  })
  .input(inputStandardSchemas.wait);

const interrupt = c
  .meta({
    description: "Interrupt the process group for a currently running Claude session.",
    examples: ["claude-session interrupt --id SESSION_ID"],
  })
  .input(inputStandardSchemas.interrupt);

export const schema = { list, read, create, send, fork, wait, interrupt };

export type AppHandlers = InferHandlers<typeof schema>;
