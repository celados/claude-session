import * as v from "valibot";

import { importSessionBundle, exportSessionBundle } from "./migration-controller.ts";
import {
  createSession,
  forkSession,
  interruptSession,
  listSessions,
  readSession,
  sendToSession,
  waitForSession,
} from "./session-controller.ts";
import { inputValidators } from "./input-validators.ts";
import {
  decodeBundle,
  encodeBundle,
  parseTransportRequest,
  transportFailure,
  type TransportRequest,
  type TransportResponse,
} from "./transport-protocol.ts";

const exportTransportInput = v.object({
  id: v.string(),
  sourceHost: v.string(),
  handoff: v.optional(v.string()),
  handoffTimeoutMs: v.optional(v.number()),
});

const importTransportInput = v.object({
  bundle_base64: v.string(),
  cwd: v.optional(v.string()),
});

export type TransportDispatch = (request: TransportRequest) => Promise<Record<string, unknown>>;

export async function handleTransportRequest(
  value: unknown,
  dispatch: TransportDispatch = dispatchTransportOperation,
): Promise<TransportResponse> {
  try {
    const request = parseTransportRequest(value);
    return { ok: true, result: await dispatch(request) };
  } catch (error) {
    return transportFailure(error);
  }
}

export async function runTransportServer(): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await new Response(Bun.stdin).text());
  } catch (error) {
    process.stdout.write(`${JSON.stringify(transportFailure(error))}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await handleTransportRequest(value))}\n`);
}

async function dispatchTransportOperation(
  request: TransportRequest,
): Promise<Record<string, unknown>> {
  switch (request.operation) {
    case "list": {
      const input = v.parse(inputValidators.list, request.input);
      return await listSessions(input.all);
    }
    case "read": {
      const input = v.parse(inputValidators.read, request.input);
      return await readSession(input.id, input.after);
    }
    case "create": {
      const input = v.parse(inputValidators.create, request.input);
      return await createSession(input);
    }
    case "send": {
      const input = v.parse(inputValidators.send, request.input);
      return await sendToSession(input.id, input.prompt);
    }
    case "fork": {
      const input = v.parse(inputValidators.fork, request.input);
      return await forkSession(input.id, input.prompt);
    }
    case "wait": {
      const input = v.parse(inputValidators.wait, request.input);
      return await waitForSession(input.id, input.after, input.timeoutMs);
    }
    case "interrupt": {
      const input = v.parse(inputValidators.interrupt, request.input);
      return await interruptSession(input.id);
    }
    case "export": {
      const input = v.parse(exportTransportInput, request.input);
      const exported = await exportSessionBundle({
        id: input.id,
        sourceHost: input.sourceHost,
        handoff: input.handoff,
        handoffTimeoutMs: input.handoffTimeoutMs,
      });
      return { bundle_base64: encodeBundle(exported.bundle), manifest: exported.manifest };
    }
    case "import": {
      const input = v.parse(importTransportInput, request.input);
      return await importSessionBundle({
        bundle: decodeBundle(input.bundle_base64),
        cwd: input.cwd,
      });
    }
  }
}
