export type SessionErrorCode = "claude_run_failed" | "session_busy" | "tool_not_found";

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
