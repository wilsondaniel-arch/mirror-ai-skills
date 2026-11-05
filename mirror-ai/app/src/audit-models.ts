/** Anthropic API id for Claude Opus 5.5. */
export const OPUS_55_API = "claude-opus-5-5";

/** Default API model outside Cursor sessions. */
export const DEFAULT_API_MODEL = "claude-opus-5";

/** Claude Code CLI shorthand outside Cursor sessions. */
export const DEFAULT_CLI_MODEL = "opus";

/** Claude Code CLI model id for Opus 5.5. */
export const OPUS_55_CLI = "claude-opus-5-5";

/** True when this process was started from a Cursor Agent shell or task. */
export function isCursorSession(): boolean {
  const flag = process.env.CURSOR_AGENT;
  if (flag === "1" || flag === "true") return true;
  if (process.env.CURSOR_CONVERSATION_ID?.trim()) return true;
  return false;
}

/** Unified model override for all runners. */
function getUserModel(): string | null {
  return process.env.MIRROR_AI_MODEL?.trim() || null;
}

export function resolveApiModel(): string {
  const userModel = getUserModel();
  if (userModel) return userModel;
  return DEFAULT_API_MODEL;
}

export function resolveCliModel(): string {
  const userModel = getUserModel();
  if (userModel) return userModel;
  const cliOverride = process.env.MIRROR_AI_CLI_MODEL?.trim();
  if (cliOverride) return cliOverride;
  return DEFAULT_CLI_MODEL;
}

export function resolveCursorModel(effort: string): string {
  const userModel = getUserModel();
  if (userModel) return userModel;
  const configured = process.env.MIRROR_AI_CURSOR_MODEL?.trim() || OPUS_55_CLI;
  return resolveCursorModelWithEffort(configured, effort);
}

function resolveCursorModelWithEffort(model: string, effort: string): string {
  if (/^(none|minimal|low|medium|high|xhigh|max)$/.test(model.split(/[-]/).pop() ?? "")) {
    return model;
  }
  if (!/-(none|minimal|low|medium|high|xhigh|max)$/.test(model)) {
    if (effort === "low" || effort === "medium") return `${model}-${effort}`;
    return `${model}-high`;
  }
  return model;
}

export type AuditRunner = "cli" | "api" | "cursor" | "budget";