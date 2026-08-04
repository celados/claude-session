# Remote Hosts & Session Migration — BDD Spec

> Context: claude-session currently controls only local Claude Code sessions. This
> spec adds (a) remote execution of every existing verb via `--host` (SSH exec
> transport), and (b) session migration via `export` / `import` / `handoff`.
> Design inputs: the SSH-exec-transport discussion and the omp.sh research
> (migration = cross-host fork; self-contained lineage bundles; execution stays
> on the machine that owns the state; agent-written closing summary before
> hand-off; no silent fallbacks).
> Status: **Draft — pending user review**

---

## Scope Boundaries

**Included:**

- Optional `host` parameter on all seven existing verbs
  (`list`, `read`, `create`, `send`, `fork`, `wait`, `interrupt`).
- SSH exec transport: the remote side runs the same `claude-session` binary via
  `ssh <host> … @transport`; payload travels over stdin.
- Host declaration file `~/.config/claude-session/hosts.json` (thin: ssh alias →
  optional remote binary path; participation in fan-out).
- `list --all-hosts` fan-out with per-host error reporting.
- New verbs: `export`, `import`, `handoff` (orchestrated export → import).
- Bundle format: gzip tarball containing `manifest.json` + transcript JSONL.
- Import preserves the original session id (Claude's documented cross-host
  restore path); lineage is recorded in a separate session registry.
  New-id "fork on import" semantics are deferred until a supported approach
  is proven by a characterization test.
- Explicit cwd remapping on import; mismatches are errors, never silent.
- Bundles include resume-relevant sidecars (tool-results, subagents) with an
  inventory and checksums; working-tree files are excluded (Git owns those).

**Not included:**

- Real-time session mirroring / collaborative viewing (omp `/collab`).
- A daemon, HTTP server, or any transport other than SSH exec.
- `steer` / mid-turn injection; `send --queue` (possible follow-up, separate spec).
- Migrating a running session; migrating working-tree files (Git owns those).
- Host auth management (SSH config owns identity, keys, tunnels).
- Read/write permission tiers per host.

---

## Terminology

| Term               | Definition                                                                                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **host**           | A name resolvable by the user's SSH configuration (`ssh <host>` works non-interactively). `local` (or omitted) means this machine.                                                                                                                                                                    |
| **transport call** | One `ssh <host> <remote-bin> @transport` invocation carrying a single verb. `@transport` is a private, versioned wire mode: it reads one JSON request envelope from stdin and writes one `{ ok: true, result } \| { ok: false, error }` envelope to stdout, so domain errors survive the wire intact. |
| **bundle**         | A self-contained `.tar.gz` produced by `export`: `manifest.json` + the session transcript JSONL + resume-relevant sidecars (tool-results, subagents), with per-file checksums in the manifest.                                                                                                        |
| **lineage**        | Metadata recording where an imported session came from: source host, export time, source cwd. Stored in a session registry owned by this tool, never inside Claude-owned files.                                                                                                                       |
| **closing turn**   | An extra turn run by `export --handoff`, asking the session's agent to summarize state, open questions, and next steps before packaging.                                                                                                                                                              |
| **idle**           | The session has no running managed job and no running native Claude process (same predicate `send` uses today).                                                                                                                                                                                       |

---

## Data Contracts

New/changed input validators (valibot, following `src/schema.ts` conventions):

```ts
// Every existing verb gains:
host: v.optional(v.string())            // undefined => local

list: { all, host, allHosts: v.optional(v.boolean(), false) }

export: {
  id: v.string(),
  host: v.optional(v.string()),         // where the session lives
  out: v.optional(v.string()),          // bundle path, default ./<id>.claude-session.tgz
  handoff: v.optional(v.string()),      // focus prompt for the closing turn
  handoffTimeoutMs: v.optional(...),    // bound on the closing turn; timeout or
                                        // claude_run_failed aborts the export
}

import: {
  bundle: v.string(),                   // bundle path
  host: v.optional(v.string()),         // where to import to
  cwd: v.optional(v.string()),          // remap target cwd; required when recorded cwd is absent
}

handoff: {
  id: v.string(),
  from: v.optional(v.string()),         // source host, default local
  to: v.string(),                       // target host
  cwd: v.optional(v.string()),          // cwd remap on target
  focus: v.optional(v.string()),        // forwarded to export --handoff
}
```

`manifest.json` inside a bundle:

```jsonc
{
  "version": 1,
  "protocol_version": 1, // compatibility is keyed to this, not tool_version
  "session_id": "…", // preserved across the migration
  "source_host": "…", // hostname or "local"
  "cwd": "/original/working/dir",
  "name": "…", // optional
  "exported_at": 1754280000000,
  "tool_version": "0.1.0", // informational only
  "handoff": true, // whether a closing turn was run
  "files": [
    // inventory of every archived file
    { "path": "transcript.jsonl", "sha256": "…", "bytes": 12345 },
  ],
}
```

`hosts.json`:

```jsonc
{
  "version": 1,
  "hosts": {
    "nas": { "bin": "/home/user/.bun/bin/claude-session" }, // bin optional
    "devbox": { "includeInAllHosts": false }, // default true
  },
}
```

Additional contracts decided during spec review:

- Session identity is the pair `(host, session_id)`; `list` dedup and fan-out
  merging key on the pair, never on the id alone.
- Transport compatibility is a `protocol_version` handshake, not exact tool
  version equality. `version_mismatch` reports both protocol versions.
- Bundle bytes cross the wire as base64 inside the transport envelope with a
  documented v1 size limit (64 MiB); `out`/`bundle` paths always resolve on
  the orchestrator machine, remote sides only exchange bytes.
- Archive extraction is a security boundary: reject path traversal, absolute
  entries, symlinks/hardlinks escaping staging, oversized or truncated
  archives; stage, validate checksums, then install atomically.
- Claude state access honors `CLAUDE_CONFIG_DIR`; imported sessions live in a
  versioned session registry (separate from process job records) that
  participates in list/read/send/fork/wait/busy detection.
- The idle/busy predicate is centralized and shared by send, fork, export,
  and handoff (today fork's check is weaker than send's; that gets fixed).
- `wait` across dropped connections is replayable at-least-once from the same
  cursor: no gaps, duplicates possible only if the caller already consumed a
  response before the drop.
- POSIX local and remote hosts only for v1.

Error codes (extending `SessionControllerError`): `host_unreachable`,
`remote_cli_missing`, `version_mismatch`, `session_busy` (reused),
`cwd_not_found`, `bundle_invalid`, `bundle_too_large`, `import_conflict`.

---

## Feature 1: Host addressing and SSH exec transport

> How any verb reaches a remote machine.

### Scenario 1.1: Verb without host runs locally, unchanged

```gherkin
Given no host parameter is provided
When any verb is invoked
Then it executes through the existing local controller
  And behavior and output are byte-identical to today
```

### Scenario 1.2: Verb with host executes on the remote machine

```gherkin
Given host "nas" is reachable over SSH
  And the same claude-session version is installed on "nas"
When "send --id S --prompt P --host nas" is invoked
Then the CLI performs one transport call to "nas" carrying the send request
  And the resume, process spawn, and job record all happen on "nas"
  And the local JSON output equals what "nas" produced, plus "host": "nas"
```

### Scenario 1.3: Prompt payload travels over stdin, never argv

```gherkin
Given a prompt containing quotes, newlines, and shell metacharacters
When any verb with a prompt is invoked with a host
Then the full JSON request is written to the remote process stdin
  And no part of the prompt appears in the ssh command line
```

### Scenario 1.4: Remote binary path comes from hosts.json

```gherkin
Given hosts.json declares "nas" with bin "/home/user/.bun/bin/claude-session"
When a transport call targets "nas"
Then the ssh command invokes that absolute path
```

### Scenario 1.5: Host not declared and not an SSH alias

```gherkin
Given host "nowhere" is neither in hosts.json nor resolvable by ssh
When any verb targets "nowhere"
Then the call fails with "host_unreachable" naming the host
  And nothing is executed locally as a fallback
```

### Scenario 1.6: Remote CLI missing

```gherkin
Given host "nas" is reachable but claude-session is not installed there
When any verb targets "nas"
Then the call fails with "remote_cli_missing" including the attempted path
  And the error suggests installing the CLI or setting "bin" in hosts.json
```

### Scenario 1.7: Version handshake

```gherkin
Given the local tool and the tool on "nas" have incompatible versions
When the first verb of a process targets "nas"
Then the call fails with "version_mismatch" reporting both versions
  And no session-mutating operation was attempted on "nas"
```

---

## Feature 2: Remote verb semantics

> Existing verbs keep their meaning; only the machine changes.

### Scenario 2.1: list with a host

```gherkin
Given "nas" has two resumable sessions
When "list --host nas" is invoked
Then the result contains those two sessions
  And every entry carries "host": "nas"
```

### Scenario 2.2: list --all-hosts fans out and tolerates failures

```gherkin
Given hosts.json declares "nas" and "devbox"
  And "devbox" is unreachable
When "list --all-hosts" is invoked
Then local and "nas" sessions are returned merged, each tagged with its host
  And the result includes an errors entry for "devbox" with "host_unreachable"
  And the exit is successful
```

### Scenario 2.3: interrupt kills the remote process

```gherkin
Given session S is running on "nas" with pid P
When "interrupt --id S --host nas" is invoked
Then the SIGINT is delivered on "nas" to P's process group
  And no local process is signaled
```

### Scenario 2.4: wait is cursor-idempotent across dropped connections

```gherkin
Given "wait --id S --host nas --after C" is in flight
When the SSH connection drops before completion
Then the local call fails with "host_unreachable"
  And re-invoking wait with the same cursor C replays all messages after C
    with no gap (at-least-once: duplicates only if a response was already
    consumed before the drop)
```

### Scenario 2.5: session_busy is raised by the owning machine

```gherkin
Given session S is running on "nas"
When "send --id S --prompt P --host nas" is invoked
Then the call fails with "session_busy" produced by the remote controller
```

---

## Feature 3: export

> Package an idle session into a self-contained bundle.

### Scenario 3.1: Export an idle local session

```gherkin
Given idle session S with transcript T and cwd W exists locally
When "export --id S" is invoked
Then a bundle file "./S.claude-session.tgz" is created
  And it contains manifest.json with session_id S, cwd W,
    source_host "local", exported_at, and tool_version
  And it contains the complete transcript T unmodified
```

### Scenario 3.2: Export refuses a running session

```gherkin
Given session S is currently running
When "export --id S" is invoked
Then the call fails with "session_busy"
  And no bundle file is created
```

### Scenario 3.3: Export with a closing turn

```gherkin
Given idle session S exists locally
When "export --id S --handoff 'migrating to the NAS'" is invoked
Then one managed turn runs on S asking the agent to summarize current state,
    open questions, and next steps for that focus
  And the bundle is packaged only after that turn completes
  And manifest.json records handoff: true
```

### Scenario 3.4: Export a remote session

```gherkin
Given idle session S exists on "nas"
When "export --id S --host nas --out ./s.tgz" is invoked
Then the bundle is assembled on "nas" and streamed back over the transport
  And "./s.tgz" is written locally with the same manifest contract
```

### Scenario 3.5: Export of an unknown session

```gherkin
Given no session with id X exists
When "export --id X" is invoked
Then the call fails with the existing "Claude session not found" error
```

---

## Feature 4: import

> Materialize a bundle as a resumable session with the same id on another host.

### Scenario 4.1: Import preserves the session id and records lineage

```gherkin
Given a valid bundle B for session S whose recorded cwd exists on this machine
  And no session S exists on this machine
When "import --bundle B" is invoked
Then the transcript and sidecars are staged, checksum-verified, and installed
    atomically under the project directory encoded from cwd, keeping id S
  And lineage (source_host, source cwd, exported_at) is stored in the session
    registry entry for S
  And the output reports S, the lineage, and status "imported"
```

### Scenario 4.2: Imported session is resumable

```gherkin
Given bundle B for session S was imported
When "send --id S --prompt 'continue'" is invoked
Then the session is found via the session registry
  And the turn resumes with the full migrated conversation context
```

### Scenario 4.3: cwd remapping

```gherkin
Given bundle B records cwd "/Users/a/proj" which does not exist here
  And "/home/b/proj" exists here
When "import --bundle B --cwd /home/b/proj" is invoked
Then the transcript is placed under the directory encoded from "/home/b/proj"
  And the session registry records "/home/b/proj" as the session's cwd
```

### Scenario 4.7: Import refuses to overwrite an existing session

```gherkin
Given a valid bundle B for session S
  And a session S already exists on this machine
When "import --bundle B" is invoked
Then the call fails with "import_conflict" naming S
  And nothing on this machine is modified
```

### Scenario 4.4: Missing cwd without remap is an error

```gherkin
Given bundle B records cwd "/Users/a/proj" which does not exist here
When "import --bundle B" is invoked without --cwd
Then the call fails with "cwd_not_found" naming the recorded cwd
  And the error instructs to pass --cwd
  And no transcript file is written
```

### Scenario 4.5: Corrupt or incompatible bundle

```gherkin
Given file F is not a valid bundle (bad archive, missing manifest,
    or unsupported manifest version)
When "import --bundle F" is invoked
Then the call fails with "bundle_invalid" describing what was wrong
  And nothing is written
```

### Scenario 4.6: Import to a remote host

```gherkin
Given a valid bundle B exists locally
  And "/data/proj" exists on "nas"
When "import --bundle B --host nas --cwd /data/proj" is invoked
Then the bundle is streamed to "nas" over the transport
  And the import (validation and placement) executes on "nas", preserving id S
  And the output reports S and "host": "nas"
```

---

## Feature 5: handoff

> One-step migration: export from source, import to target, local machine
> orchestrates. Source and target need not reach each other.

### Scenario 5.1: Local to remote handoff

```gherkin
Given idle session S exists locally
  And "/data/proj" exists on "nas"
When "handoff --id S --to nas --cwd /data/proj" is invoked
Then S is exported locally, streamed through this machine, imported on "nas"
  And the output reports session id S, "host": "nas", and lineage to the source
  And S remains intact locally
```

### Scenario 5.2: Remote to remote handoff via the orchestrator

```gherkin
Given idle session S exists on "devbox"
  And "nas" and "devbox" cannot reach each other directly
When "handoff --id S --from devbox --to nas --cwd /data/proj" is invoked
Then the bundle travels devbox → local → nas
  And the import completes on "nas"
```

### Scenario 5.3: Handoff with focus runs the closing turn on the source

```gherkin
Given idle session S exists locally
When "handoff --id S --to nas --focus 'continue the refactor'" is invoked
Then the closing turn runs on S before export (as in Scenario 3.3)
  And the imported transcript on "nas" ends with that closing summary
```

### Scenario 5.4: Import failure leaves the source untouched and the bundle recoverable

```gherkin
Given idle session S exists locally
  And the import step on "nas" fails (e.g. cwd_not_found)
When "handoff --id S --to nas" is invoked
Then the command fails with the import error
  And S is not deleted or replaced and remains resumable locally
    (a closing turn that already ran remains appended)
  And the exported bundle is retained under the XDG state path (mode 0600)
    and its path is reported for retry
```

### Scenario 5.5: Handoff refuses a running source

```gherkin
Given session S is currently running
When "handoff --id S --to nas" is invoked
Then the call fails with "session_busy" before any export work starts
```

---

## Acceptance Checklist

- [ ] All seven existing verbs accept `host` and behave identically locally when it is omitted.
- [ ] Remote execution uses SSH exec + stdin JSON; prompts never appear in argv.
- [ ] Remote failures (`host_unreachable`, `remote_cli_missing`, `version_mismatch`) are explicit; no silent local fallback anywhere.
- [ ] `list --all-hosts` merges per-host results and reports per-host errors without failing the whole call.
- [ ] `export` produces a self-contained bundle, refuses running sessions, and supports the `--handoff` closing turn.
- [ ] `import` preserves the session id, installs atomically after checksum validation, records lineage in the session registry, and rejects missing cwd / invalid bundles / existing sessions without partial writes.
- [ ] An opt-in characterization test against the real `claude` CLI proves same-id cross-host restore (transcript placement + `--resume`).
- [ ] An imported session resumes correctly via `send`.
- [ ] `handoff` composes export + import through the orchestrator, works remote-to-remote, and leaves the source intact on failure.
- [ ] MCP server exposes `export_session`, `import_session`, `handoff_session`, and `host` parameters on existing tools.
- [ ] README and the plugin Skill document the new verbs and host model.
