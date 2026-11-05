import { spawnSync } from "node:child_process";
import { hasCursorAgentCli } from "./cursor-agent.ts";
import { resolveApiModel, resolveCliModel, type AuditRunner } from "./audit-models.ts";
import { resolveCursorModel } from "./cursor-agent.ts";
import { budgetModelLabel } from "./budget-audit.ts";
export type AuditEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AuditRunSettings {
  effort: AuditEffort;
  /** When set, passed verbatim to the Cursor `agent` CLI as `--model`. */
  cursorModel: string | null;
}

export interface ModelOption {
  value: string;
  label: string;
}

const EFFORT_LEVELS: AuditEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function defaultAuditEffort(): AuditEffort {
  const raw = process.env.MIRROR_AI_EFFORT?.trim() || "high";
  return parseAuditEffort(raw) ?? "high";
}

export function parseAuditEffort(value: unknown): AuditEffort | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return EFFORT_LEVELS.includes(trimmed as AuditEffort) ? (trimmed as AuditEffort) : null;
}

export function auditRunSettings(request: { effort?: string; cursorModel?: string }): AuditRunSettings {
  const effort = parseAuditEffort(request.effort) ?? defaultAuditEffort();
  const cursorModel =
    typeof request.cursorModel === "string" && request.cursorModel.trim() ? request.cursorModel.trim() : null;
  return { effort, cursorModel };
}

export function resolveCursorModelForRun(settings: AuditRunSettings): string {
  if (settings.cursorModel) return settings.cursorModel;
  return resolveCursorModel(settings.effort);
}

export function resolveAuditModelForRun(runner: AuditRunner, settings: AuditRunSettings): string {
  const userModel = process.env.MIRROR_AI_MODEL?.trim();
  if (userModel) return userModel;
  if (runner === "budget") return budgetModelLabel();
  if (runner === "cursor") return resolveCursorModelForRun(settings);
  if (runner === "cli") {
    const cliOverride = process.env.MIRROR_AI_CLI_MODEL?.trim();
    return cliOverride || resolveCliModel();
  }
  const apiOverride = process.env.MIRROR_AI_API_MODEL?.trim();
  return apiOverride || resolveApiModel();
}

/** Parses `agent --list-models` lines like `claude-opus-5-5-high - Claude Opus…`. */
export function parseAgentModelList(stdout: string): ModelOption[] {
  const options: ModelOption[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+-\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    options.push({ value: match[1], label: `${match[1]} — ${match[2]}` });
  }
  return options;
}

export function listAgentModels(): { ok: true; options: ModelOption[] } | { ok: false; error: string } {
  if (!hasCursorAgentCli()) {
    return { ok: false, error: "Install the Cursor Agent CLI (`agent`) and run `agent login` once." };
  }
  const probe = spawnSync("agent", ["--list-models"], { encoding: "utf8", timeout: 30_000 });
  if (probe.status !== 0) {
    const detail = `${probe.stderr}\n${probe.stdout}`.trim().slice(0, 240);
    return { ok: false, error: detail || "Could not list models from the Cursor agent CLI." };
  }
  const options = parseAgentModelList(probe.stdout);
  if (options.length === 0) {
    return { ok: false, error: "The Cursor agent CLI returned no models." };
  }
  return { ok: true, options };
}

export function auditSettingsPayload(runner: AuditRunner): {
  effort: AuditEffort;
  cursorModel: string | null;
  derivedCursorModel: string;
  runner: AuditRunner;
  effortOptions: { value: AuditEffort; label: string }[];
} {
  const settings = auditRunSettings({});
  return {
    effort: settings.effort,
    cursorModel: settings.cursorModel,
    derivedCursorModel: resolveCursorModelForRun(settings),
    runner,
    effortOptions: [
      { value: "low", label: "Low — cheapest Opus 5.5 tier" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High — default quality" },
      { value: "xhigh", label: "Extra high" },
      { value: "max", label: "Max" },
    ],
  };
}
