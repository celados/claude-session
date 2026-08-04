import type { AppHandlers } from "./schema.ts";
import { domainError } from "argc";

import {
  createSessionService,
  exportSessionService,
  forkSessionService,
  handoffSessionService,
  importSessionService,
  interruptSessionService,
  listSessionService,
  readSessionService,
  sendSessionService,
  waitSessionService,
} from "./session-service.ts";
import { SessionControllerError } from "./session-error.ts";

export const handlers: AppHandlers = {
  list: async (options) => await withSessionErrors(async () => listSessionService(options.input)),
  read: async (options) => await withSessionErrors(async () => readSessionService(options.input)),
  create: async (options) =>
    await withSessionErrors(async () => createSessionService(options.input)),
  send: async (options) =>
    await withSessionErrors(async () => {
      return await sendSessionService(options.input);
    }),
  fork: async (options) =>
    await withSessionErrors(async () => {
      return await forkSessionService(options.input);
    }),
  wait: async (options) =>
    await withSessionErrors(async () => {
      return await waitSessionService(options.input);
    }),
  interrupt: async (options) =>
    await withSessionErrors(async () => {
      return await interruptSessionService(options.input);
    }),
  "export-session": async (options) =>
    await withSessionErrors(async () => exportSessionService(options.input)),
  "import-session": async (options) =>
    await withSessionErrors(async () => importSessionService(options.input)),
  handoff: async (options) =>
    await withSessionErrors(async () => handoffSessionService(options.input)),
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
