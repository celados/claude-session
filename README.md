# claude-session

Machine-readable lifecycle control for Claude Code sessions. It provides the
small session API needed by another agent or orchestrator: list, create, read,
send, fork, wait, interrupt, export, import, and handoff. Every lifecycle
operation can target a POSIX SSH host.

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
`interrupt_session`. Migration adds `export_session`, `import_session`, and
`handoff_session`.

### Keep the CLI and plugin versions matched

The CLI and the plugin ship through two different channels that upgrade
independently: the CLI comes from a GitHub Release tarball, while the plugin
tracks this repository's `main` branch. The plugin's MCP server executes the
globally installed CLI, so a mismatch is easy to create and awkward to notice —
the tool list comes from the CLI while the Skill text comes from the plugin, and
a stale half shows up as missing tools or as guidance describing tools that do
not exist.

Upgrade both together, then restart the agent session:

```sh
bun add --global \
  "claude-session@https://github.com/celados/claude-session/releases/latest/download/claude-session.tgz"
claude plugin marketplace update claude-session
claude plugin update claude-session@claude-session
```

Remote hosts have the same rule: every machine listed in `hosts.json` needs a
CLI whose transport protocol version matches the local one, or calls fail with
`version_mismatch`.

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
| `export`    | Package an idle session and its resume-relevant sidecars.              |
| `import`    | Restore a bundle while preserving its Claude session id.               |
| `handoff`   | Relay a bundle from one host to another through this machine.          |

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
claude-session export --id SESSION_ID --out ./session.tgz
claude-session import --bundle ./session.tgz --cwd "$PWD"
claude-session handoff --id SESSION_ID --to nas --cwd /srv/project
```

For strict JSON, use argc's `@run` interface. `--json` belongs to `@run`, not to
an individual command:

```sh
claude-session @run 'await argc.call.list({ all: true })' --json
claude-session @run \
  'await argc.call.wait({ id: "SESSION_ID", timeoutMs: 30000 })' --json
claude-session @run \
  'await argc.call["export-session"]({ id: "SESSION_ID", out: "./session.tgz" })' --json
```

The complete machine-readable API is available through:

```sh
claude-session @schema
```

The same API is available to MCP clients over stdio:

```sh
claude-session-mcp
```

## Remote hosts

Pass `host` to any operation. The reserved host `local`, or an omitted host,
uses this machine. Explicit remote hosts may be any safe SSH alias; hosts in
`~/.config/claude-session/hosts.json` also participate in `list --allHosts`.

```json
{
  "version": 1,
  "hosts": {
    "nas": { "bin": "/home/user/.bun/bin/claude-session" },
    "devbox": { "includeInAllHosts": false }
  }
}
```

SSH authentication remains owned by the user's SSH configuration. Transport
uses one non-interactive SSH exec call and a private versioned `@transport`
JSON envelope. Prompts and bundle bytes travel over stdin, never in remote
argv. Remote bundle payloads are limited to 64 MiB in v1.

Session identity is `(host, session_id)`. Import preserves the session id and
refuses to overwrite an existing local session. Bundle paths always refer to
the machine running this CLI or MCP server, even when the session itself is
remote.

Bundles contain plaintext Claude transcripts and resume-relevant tool-result
and subagent sidecars. They may contain secrets from prior tool calls. Bundle
files use mode `0600`; store and transfer them accordingly. Imports validate
archive paths, sizes, and SHA-256 inventory before committing staged files.
Failed handoffs retain a retryable bundle under the XDG state directory and
report its path in the error.

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

Imported session lineage is stored separately under the same state root. Claude
state discovery honors `CLAUDE_CONFIG_DIR`.

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
