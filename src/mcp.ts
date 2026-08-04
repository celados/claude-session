#!/usr/bin/env bun

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import packageJson from "../package.json" with { type: "json" };
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as v from "valibot";

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
import { inputJsonSchemas, inputValidators } from "./schema.ts";

const instructions =
  "Manage Claude Code sessions. Use create_session for new work; send_to_session to continue an idle session with the same id; and fork_session for alternate context. Never send or fork while the source is running. Read once to get a cursor, then pass it to wait_for_session. Prefer bounded waits over polling. Interrupt only when requested or abandoning owned work.";

const tools: Tool[] = [
  tool("list_sessions", "List active or resumable Claude Code sessions.", "list", true),
  tool("read_session", "Read normalized messages from one Claude Code session.", "read", true),
  tool(
    "create_session",
    "Create a managed Claude Code session and start its first turn.",
    "create",
  ),
  tool("send_to_session", "Continue an idle Claude Code session without changing its id.", "send"),
  tool("fork_session", "Fork completed Claude context into a new managed session.", "fork"),
  tool(
    "wait_for_session",
    "Wait for completion or timeout and return messages after a cursor.",
    "wait",
    true,
  ),
  tool("interrupt_session", "Interrupt a running Claude Code session.", "interrupt", false, true),
  tool("export_session", "Export an idle Claude Code session bundle.", "export"),
  tool("import_session", "Import a Claude Code session bundle without changing its id.", "import"),
  tool("handoff_session", "Move a resumable session context between hosts.", "handoff"),
];

const server = new Server(
  { name: "claude-session", version: packageJson.version },
  { capabilities: { tools: {} }, instructions },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await callTool(request.params.name, request.params.arguments ?? {});
    return success(result);
  } catch (error) {
    return failure(error);
  }
});

await server.connect(new StdioServerTransport());

type InputName = keyof typeof inputJsonSchemas;
type JsonObject = Record<string, unknown>;

function tool(
  name: string,
  description: string,
  inputName: InputName,
  readOnlyHint = false,
  destructiveHint = false,
): Tool {
  return {
    name,
    description,
    inputSchema: inputJsonSchemas[inputName] as Tool["inputSchema"],
    annotations: {
      readOnlyHint,
      destructiveHint,
      idempotentHint: readOnlyHint,
      openWorldHint: false,
    },
  };
}

async function callTool(name: string, input: JsonObject): Promise<JsonObject> {
  switch (name) {
    case "list_sessions": {
      const parsed = v.parse(inputValidators.list, input);
      return await listSessionService(parsed);
    }
    case "read_session": {
      const parsed = v.parse(inputValidators.read, input);
      return await readSessionService(parsed);
    }
    case "create_session": {
      const parsed = v.parse(inputValidators.create, input);
      return await createSessionService(parsed);
    }
    case "send_to_session": {
      const parsed = v.parse(inputValidators.send, input);
      return await sendSessionService(parsed);
    }
    case "fork_session": {
      const parsed = v.parse(inputValidators.fork, input);
      return await forkSessionService(parsed);
    }
    case "wait_for_session": {
      const parsed = v.parse(inputValidators.wait, input);
      return await waitSessionService(parsed);
    }
    case "interrupt_session": {
      const parsed = v.parse(inputValidators.interrupt, input);
      return await interruptSessionService(parsed);
    }
    case "export_session": {
      const parsed = v.parse(inputValidators.export, input);
      return await exportSessionService(parsed);
    }
    case "import_session": {
      const parsed = v.parse(inputValidators.import, input);
      return await importSessionService(parsed);
    }
    case "handoff_session": {
      const parsed = v.parse(inputValidators.handoff, input);
      return await handoffSessionService(parsed);
    }
    default:
      throw new SessionControllerError("tool_not_found", "Unknown Claude session tool.", {
        tool: name,
      });
  }
}

function success(result: JsonObject): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: JsonObject;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function failure(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: JsonObject;
} {
  const payload =
    error instanceof SessionControllerError
      ? { code: error.code, message: error.message, ...error.details }
      : {
          code: "claude_session_error",
          message: error instanceof Error ? error.message : "Claude session operation failed.",
        };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
