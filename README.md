# claude-session

Machine-readable lifecycle control for Claude Code sessions. It provides the
small session API needed by another agent or orchestrator: list, create, read,
send, fork, wait, and interrupt.

## Install

Requirements: Bun and an authenticated `claude` CLI on `PATH`.

```sh
bun install
bun link
claude-session --help
```

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
bun run test
bun run typecheck
bun run check
```
