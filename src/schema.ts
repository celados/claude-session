import type { InferHandlers } from "argc";

import { toJsonSchema, toStandardJsonSchema } from "@valibot/to-json-schema";
import { c } from "argc";

import { inputValidators } from "./input-validators.ts";

export { inputValidators } from "./input-validators.ts";

export const inputJsonSchemas = {
  list: toJsonSchema(inputValidators.list),
  read: toJsonSchema(inputValidators.read),
  create: toJsonSchema(inputValidators.create),
  send: toJsonSchema(inputValidators.send),
  fork: toJsonSchema(inputValidators.fork),
  wait: toJsonSchema(inputValidators.wait),
  interrupt: toJsonSchema(inputValidators.interrupt),
  export: toJsonSchema(inputValidators.export),
  import: toJsonSchema(inputValidators.import),
  handoff: toJsonSchema(inputValidators.handoff),
};

const inputStandardSchemas = {
  list: toStandardJsonSchema(inputValidators.list),
  read: toStandardJsonSchema(inputValidators.read),
  create: toStandardJsonSchema(inputValidators.create),
  send: toStandardJsonSchema(inputValidators.send),
  fork: toStandardJsonSchema(inputValidators.fork),
  wait: toStandardJsonSchema(inputValidators.wait),
  interrupt: toStandardJsonSchema(inputValidators.interrupt),
  export: toStandardJsonSchema(inputValidators.export),
  import: toStandardJsonSchema(inputValidators.import),
  handoff: toStandardJsonSchema(inputValidators.handoff),
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

const exportSession = c
  .meta({ description: "Export an idle Claude session as a resumable bundle." })
  .input(inputStandardSchemas.export);

const importSession = c
  .meta({ description: "Import a resumable Claude session bundle without changing its id." })
  .input(inputStandardSchemas.import);

const handoff = c
  .meta({ description: "Export a session from one host and import it on another host." })
  .input(inputStandardSchemas.handoff);

export const schema = {
  list,
  read,
  create,
  send,
  fork,
  wait,
  interrupt,
  "export-session": exportSession,
  "import-session": importSession,
  handoff,
};

export type AppHandlers = InferHandlers<typeof schema>;
