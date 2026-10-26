/** Anthropic API id for Claude Opus 5.5. */
export const OPUS_55_API = "claude-opus-5-5";

/** Default API model outside Cursor sessions. */
export const DEFAULT_API_MODEL = "claude-opus-5";

/** Claude Code CLI shorthand outside Cursor sessions. */
export const DEFAULT_CLI_MODEL = "opus";

/** Claude Code CLI model id for Opus 5.5. */
export const OPUS_55_CLI = "claude-opus-5-5";

/**
 * True when this process was started from a Cursor Agent shell or task. Cursor
 * sets `CURSOR_AGENT` on integrated terminals used by Agent.
 */
export function isCursorSession(): boolean {
  const flag = process.env.CURSOR_AGENT;
  if (flag === "1" || flag === "true") return true;
  if (process.env.CURSOR_CONVERSATION_ID?.trim()) return true;
  return false;
}

export function resolveApiModel(): string {
  const override = process.env.MIRROR_AI_API_MODEL?.trim();
  if (override) return override;
  return isCursorSession() ? OPUS_55_API : DEFAULT_API_MODEL;
}

export function resolveCliModel(): string {
  const override = process.env.MIRROR_AI_CLI_MODEL?.trim();
  if (override) return override;
  return isCursorSession() ? OPUS_55_CLI : DEFAULT_CLI_MODEL;
}

export type AuditRunner = "cli" | "api" | "cursor";
