---
name: manage-claude-sessions
description: Create, continue, fork, inspect, wait for, and interrupt Claude Code sessions through the claude-session MCP tools. Use when the user asks to delegate work to Claude, keep one primary conversation focused while Claude works separately, manage or inspect Claude sessions, branch an existing Claude context, or resume prior Claude work.
---

# Manage Claude Sessions

Keep the user's current conversation as the control plane. Put independent or
context-heavy work into a Claude session and report its result back here.

## Choose the lifecycle operation

- Use `create_session` for a new assignment. Give it an absolute working directory,
  a short stable name, and a self-contained prompt.
- Use `send_to_session` to continue an idle session without changing its id.
- Use `fork_session` when the same completed context should explore a different
  approach. The fork returns a new id.
- Use `list_sessions` to discover active or resumable sessions and `read_session`
  to inspect one.
- Use `wait_for_session` with the cursor returned by `read_session`; prefer one
  bounded wait over repeated polling.
- Use `interrupt_session` only when the user requests cancellation or the owned
  run must be abandoned.

## Safety and coordination

Never send to or fork a running source session. Preserve session ids in updates so
the user can continue the same context later. Do not claim completion from process
state alone: read the returned messages and summarize the actual result, remaining
questions, and any files changed.
