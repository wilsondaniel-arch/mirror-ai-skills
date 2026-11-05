import { readFileSync } from "node:fs";
import path from "node:path";
import type { ComparisonMode } from "./types.ts";

/**
 * Canonical full-market workflow from superapp-workspace
 * (`docs/10-api-contract-drift.md`, branch `feature/api-contract-drift-v2`).
 * The api-skill pass reads this at runtime so section 3 is always discovered
 * from the pinned Android/iOS checkouts, never from a baked-in market report.
 */
export const API_DRIFT_WORKFLOW = "prompts/references/api-contract-drift-workflow.md";

const WORKFLOW_CHAR_BUDGET = Number(process.env.MIRROR_AI_API_WORKFLOW_BUDGET) || 16_000;

export function readApiDriftWorkflow(projectRoot: string): string {
  try {
    const full = readFileSync(path.join(projectRoot, API_DRIFT_WORKFLOW), "utf8").trim();
    return trimWorkflow(full);
  } catch {
    return "";
  }
}

function trimWorkflow(text: string): string {
  if (!text) return "";
  const budget = WORKFLOW_CHAR_BUDGET;
  if (budget <= 0 || text.length <= budget) return text;
  const head = Math.floor(budget * 0.75);
  const tail = budget - head - 80;
  return [
    text.slice(0, head),
    "",
    "> _(Workflow truncated for token budget; discover contracts from the pinned checkouts.)_",
    "",
    text.slice(-tail),
  ].join("\n");
}

/** Extra instructions appended to the api-skill system prompt for this audit. */
export function apiDriftScopeNote(mode: ComparisonMode): string {
  if (mode === "repository") {
    return [
      "## Scope for this run — full market",
      "",
      "Inventory **every wired BFF path** in both checkouts at the pinned commits.",
      "Follow the workflow's full-market discovery gates and tables (Meta, inventory, baseline, stale, environment).",
      "**Do not** paste rows from another market, an old `docs/reports/*.md`, or Mirror AI's `reference/` folder — only code you read in these two repos.",
    ].join("\n");
  }
  return [
    "## Scope for this run — this module only",
    "",
    "Inventory BFF paths **this module** reaches on each platform (directly or via repositories/use cases).",
    "Use the same contract values, drift tags, and column sets as the workflow.",
    "**Do not** paste another module's or market's inventory; discover from the pinned checkouts.",
  ].join("\n");
}
