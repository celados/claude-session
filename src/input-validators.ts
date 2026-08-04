import * as v from "valibot";

const host = v.optional(v.string());

export const inputValidators = {
  list: v.object({
    all: v.optional(v.boolean(), false),
    host,
    allHosts: v.optional(v.boolean(), false),
  }),
  read: v.object({ id: v.string(), after: v.optional(v.string()), host }),
  create: v.object({
    cwd: v.string(),
    name: v.optional(v.string()),
    prompt: v.string(),
    host,
  }),
  send: v.object({ id: v.string(), prompt: v.string(), host }),
  fork: v.object({ id: v.string(), prompt: v.string(), host }),
  wait: v.object({
    id: v.string(),
    after: v.optional(v.string()),
    timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 30_000),
    host,
  }),
  interrupt: v.object({ id: v.string(), host }),
  export: v.object({
    id: v.string(),
    host,
    out: v.optional(v.string()),
    handoff: v.optional(v.string()),
    handoffTimeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 600_000),
  }),
  import: v.object({
    bundle: v.string(),
    host,
    cwd: v.optional(v.string()),
  }),
  handoff: v.object({
    id: v.string(),
    from: v.optional(v.string()),
    to: v.string(),
    cwd: v.optional(v.string()),
    focus: v.optional(v.string()),
  }),
};
