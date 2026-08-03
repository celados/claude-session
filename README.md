# claude-session

Machine-readable lifecycle control for Claude Code sessions. It provides the
small session API needed by another agent or orchestrator: list, create, read,
send, fork, wait, and interrupt.

## Install

Requirements: Bun and an authenticated `claude` CLI on `PATH`.

```sh
bun add --global \
  "claude-session@https://github.com/celados/claude-session/releases/latest/download/claude-session.tgz"
claude-session --help
```

This installs the same GitHub Release artifact used by every public user. The
package remains marked `private` so it cannot be published to npm by mistake.

## Install the agent integration

The plugin combines an MCP server, which exposes executable session tools, with
a Skill that teaches the host when to create, continue, fork, wait for, or
interrupt a session. Install it from this public repository after installing the
CLI above.

Claude Code:

```sh
claude plugin marketplace add celados/claude-session
claude plugin install claude-session@claude-session --scope user
```

Codex:

```sh
codex plugin marketplace add celados/claude-session
codex plugin add claude-session@claude-session
```

Start a new Claude Code or Codex session after installation. The MCP server
appears as `claude-session`; its tools are `list_sessions`, `read_session`,
`create_session`, `send_to_session`, `fork_session`, `wait_for_session`, and
`interrupt_session`.

## Commands

| Command     | Behavior                                                               |
| ----------- | ---------------------------------------------------------------------- |
| `list`      | Merge native Claude agents, indexed history, and locally managed runs. |
| `create`    | Allocate a session UUID and start a detached headless Claude turn.     |
| `read`      | Return normalized user/assistant text and an opaque cursor.            |
| `send`      | Start another detached turn on the same idle session UUID.             |
| `fork`      | Copy completed context into a new session UUID and start a turn.       |
| `wait`      | Wait until completion or a bounded timeout, then return new messages.  |
| `interrupt` | Interrupt the managed process group or native Claude process.          |

Human-readable commands return YAML:

```sh
claude-session list --all
claude-session create --cwd "$PWD" --name investigation \
  --prompt "Investigate the failing build."
claude-session read --id SESSION_ID
claude-session send --id SESSION_ID --prompt "Continue and run the tests."
claude-session fork --id SESSION_ID --prompt "Try the alternative design."
claude-session wait --id SESSION_ID --timeoutMs 30000
claude-session interrupt --id SESSION_ID
```

For strict JSON, use argc's `@run` interface. `--json` belongs to `@run`, not to
an individual command:

```sh
claude-session @run 'await argc.call.list({ all: true })' --json
claude-session @run \
  'await argc.call.wait({ id: "SESSION_ID", timeoutMs: 30000 })' --json
```

The complete machine-readable API is available through:

```sh
claude-session @schema
```

The same API is available to MCP clients over stdio:

```sh
claude-session-mcp
```

## Lifecycle model

Runs started by this tool use Claude's headless JSON mode rather than Claude's
native `--background` agent manager. This is intentional: headless mode accepts
a caller-provided UUID, so `send` can resume the exact same session and `fork`
can return the new UUID immediately.

If `send` or `fork` targets an idle native background agent, the tool first
releases it with `claude stop`, preserving its conversation, and then resumes it
as a managed run. Concurrent turns are rejected with `session_busy`.

Managed job metadata and private stdout/stderr logs live under
`$XDG_STATE_HOME/claude-session/jobs`, or `~/.local/state/claude-session/jobs`
when `XDG_STATE_HOME` is unset. Prompt handoff files use mode `0600` and are
unlinked immediately after the child process starts.

## Development

```sh
bun install
bun run test
bun run typecheck
bun run check
bun run verify:package
```

Releases are deliberately created through the `Release claude-session` GitHub
Actions workflow. It tests the source, verifies an isolated global install,
publishes versioned and stable tarballs plus `SHA256SUMS`, and then repeats the
install without a GitHub token.
