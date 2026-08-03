import type { AppHandlers } from "./schema.ts";
import { domainError } from "argc";

import {
  createSession,
  forkSession,
  interruptSession,
  listSessions,
  readSession,
  sendToSession,
  waitForSession,
} from "./session-controller.ts";
import { SessionControllerError } from "./session-error.ts";

export const handlers: AppHandlers = {
  list: async (options) => await listSessions(options.input.all),
  read: async (options) => await readSession(options.input.id, options.input.after),
  create: async (options) => await createSession(options.input),
  send: async (options) =>
    await withSessionErrors(async () => {
      return await sendToSession(options.input.id, options.input.prompt);
    }),
  fork: async (options) =>
    await withSessionErrors(async () => {
      return await forkSession(options.input.id, options.input.prompt);
    }),
  wait: async (options) =>
    await withSessionErrors(async () => {
      return await waitForSession(options.input.id, options.input.after, options.input.timeoutMs);
    }),
  interrupt: async (options) =>
    await withSessionErrors(async () => {
      return await interruptSession(options.input.id);
    }),
};

async function withSessionErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SessionControllerError) {
      throw domainError(error.code, error.message, error.details);
    }
    throw error;
  }
}
