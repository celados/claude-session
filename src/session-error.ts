export type SessionErrorCode =
  | "bundle_invalid"
  | "bundle_too_large"
  | "claude_run_failed"
  | "cwd_not_found"
  | "handoff_timeout"
  | "host_unreachable"
  | "import_conflict"
  | "remote_cli_missing"
  | "session_busy"
  | "tool_not_found"
  | "version_mismatch";

export class SessionControllerError extends Error {
  readonly code: SessionErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SessionErrorCode, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "SessionControllerError";
    this.code = code;
    this.details = details;
  }
}
