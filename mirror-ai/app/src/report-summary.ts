/**
 * Turns a parity report (the Markdown the audit writes) into numbers a
 * dashboard can rank and compare across runs: findings per module with a
 * weight, a 0-100 score, a status, coverage, and a fingerprint per finding so
 * the next run can tell new findings from resolved and persisting ones.
 *
 *   npm run summarize -- <parity-report.md> [--run run.json] [--out summary.json]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type Severity = "High" | "Medium" | "Low";
export type Confidence = "Confirmed" | "Runtime" | "Potential" | "Requirements gap" | "Unknown";
export type Status = "red" | "amber" | "green" | "grey";
export type FindingKind = "business-logic" | "api-high-risk" | "api-drift" | "api-stale-constant" | "api-base-url" | "ui-divergent";

export interface Finding {
  kind: FindingKind;
  id: string;
  area: string;
  severity: Severity;
  confidence: Confidence;
  weight: number;
  files: string[];
  fingerprint: string;
}

export interface ModuleSummary {
  key: string;
  label: string;
  miscellaneous: boolean;
  findings: Finding[];
  counts: {
    high: number;
    highConfirmed: number;
    medium: number;
    low: number;
    apiDrift: number;
    uiDivergent: number;
    hardcodedCopy: number;
  };
  coverage: number | null;
  incompleteSections: string[];
  /** Null when the business-logic section could not be produced: there is nothing to score. */
  score: number | null;
  status: Status;
}

export interface ReportSummary {
  version: 1;
  modules: ModuleSummary[];
  totals: ModuleSummary["counts"] & { modules: number; incompleteModules: number };
  /** Mean of the non-Miscellaneous module scores, or null if there are none. */
  score: number | null;
  status: Status;
}

export const SEVERITY_WEIGHT: Record<Severity, number> = { High: 10, Medium: 4, Low: 1 };
export const CONFIDENCE_FACTOR: Record<Confidence, number> = {
  Confirmed: 1,
  Runtime: 0.6,
  Potential: 0.5,
  "Requirements gap": 0.3,
  Unknown: 0.5,
};
const HARDCODED_WEIGHT = 0.25;
const HARDCODED_CAP = 5;
/** Below this share of matching files read, a module's status is grey: the audit saw too little. */
export const MIN_COVERAGE = 0.8;

const MODULE_HEADING = /^# Business logic audit — (.+)$/;
const FILE_REF = /[A-Za-z0-9_.+\-/]+\.(?:kt|kts|java|swift)\b/g;

export function moduleKeyOf(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function summarizeReport(markdown: string): ReportSummary {
  const modules = splitModules(markdown).map(({ label, body }) => summarizeModule(label, body));
  const scored = modules.filter((module) => !module.miscellaneous && module.score !== null);
  const totals = {
    modules: modules.length,
    incompleteModules: modules.filter((module) => module.incompleteSections.length > 0).length,
    high: 0,
    highConfirmed: 0,
    medium: 0,
    low: 0,
    apiDrift: 0,
    uiDivergent: 0,
    hardcodedCopy: 0,
  };
  for (const module of modules) {
    for (const key of Object.keys(module.counts) as (keyof ModuleSummary["counts"])[]) totals[key] += module.counts[key];
  }
  const score = scored.length ? round(scored.reduce((sum, module) => sum + (module.score ?? 0), 0) / scored.length) : null;
  const statuses = modules.filter((module) => !module.miscellaneous).map((module) => module.status);
  return { version: 1, modules, totals, score, status: worstStatus(statuses) };
}

function splitModules(markdown: string): { label: string; body: string[] }[] {
  const out: { label: string; body: string[] }[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = MODULE_HEADING.exec(line.trim());
    if (heading) {
      out.push({ label: heading[1].trim(), body: [] });
      continue;
    }
    out.at(-1)?.body.push(line);
  }
  return out;
}

/** The module's lines grouped by `### ` section, keyed by a short section id. */
function sections(lines: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current = "preamble";
  for (const line of lines) {
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) {
      const title = heading[1].toLowerCase();
      current = title.includes("business logic difference matrix")
        ? "bl"
        : title.includes("hard-coded copy")
          ? "hardcoded"
          : title.includes("ui difference")
            ? "ui"
            : title.includes("api contract drift")
              ? "api"
              : current;
      if (!map.has(current)) map.set(current, []);
      continue;
    }
    if (!map.has(current)) map.set(current, []);
    map.get(current)!.push(line);
  }
  return map;
}

function cells(row: string): string[] {
  const parts = row.split("|").map((cell) => cell.trim());
  return parts.slice(1, parts.at(-1) === "" ? -1 : undefined);
}

function isDataRow(row: string): boolean {
  return row.trim().startsWith("|") && !/^\|\s*:?-{2,}/.test(row.trim());
}

function parseSeverity(text: string): Severity | null {
  const value = text.replace(/\*/g, "").trim().toLowerCase();
  if (value === "high") return "High";
  if (value === "medium") return "Medium";
  if (value === "low") return "Low";
  return null;
}

function parseConfidence(text: string): Confidence {
  const value = text.replace(/\*/g, "").toLowerCase();
  if (value.includes("confirmed")) return "Confirmed";
  if (value.includes("runtime")) return "Runtime";
  if (value.includes("potential")) return "Potential";
  if (value.includes("requirement")) return "Requirements gap";
  return "Unknown";
}

function filesIn(text: string): string[] {
  return [...new Set(text.match(FILE_REF) ?? [])].sort();
}

/**
 * Stable across runs: the audit renumbers BL ids and rewords areas every
 * time, but the files a finding cites stay the same while the code does.
 */
export function fingerprint(moduleKey: string, kind: FindingKind, area: string, files: string[]): string {
  const basis = files.length ? files.join(",") : area.toLowerCase().replace(/[^a-z0-9]/g, "");
  return createHash("sha1").update(`${moduleKey}|${kind}|${basis}`).digest("hex").slice(0, 12);
}

function finding(moduleKey: string, kind: FindingKind, id: string, area: string, severity: Severity, confidence: Confidence, text: string): Finding {
  const files = filesIn(text);
  return {
    kind,
    id,
    area,
    severity,
    confidence,
    weight: round(SEVERITY_WEIGHT[severity] * CONFIDENCE_FACTOR[confidence]),
    files,
    fingerprint: fingerprint(moduleKey, kind, area, files),
  };
}

function summarizeModule(label: string, lines: string[]): ModuleSummary {
  const key = moduleKeyOf(label);
  const parts = sections(lines);
  const findings: Finding[] = [];
  const incompleteSections: string[] = [];
  for (const [name, body] of parts) {
    if (name !== "preamble" && body.some((line) => /could not be produced/i.test(line))) incompleteSections.push(name);
  }

  // Business logic matrix: | ID | Area | Android | iOS | Impact | Severity | Confidence |
  for (const row of (parts.get("bl") ?? []).filter((line) => /^\|\s*BL-\d+/.test(line.trim()))) {
    const c = cells(row);
    if (c.length < 7) continue;
    // Read severity and confidence from the end so a stray pipe in a cell cannot shift them.
    const severity = parseSeverity(c[c.length - 2]);
    if (!severity) continue;
    findings.push(finding(key, "business-logic", c[0], c[1], severity, parseConfidence(c[c.length - 1]), c.slice(2, -2).join(" ")));
  }

  // UI: rows of the per-screen slot tables whose last cell is the state.
  let uiDivergent = 0;
  for (const row of (parts.get("ui") ?? []).filter(isDataRow)) {
    const c = cells(row);
    const state = (c.at(-1) ?? "").toLowerCase();
    if (/^(divergent|missing\b.*)$/.test(state)) {
      uiDivergent++;
      findings.push(finding(key, "ui-divergent", c[0] ?? "", c[0] ?? "", "Low", "Potential", row));
    }
  }

  // Hard-coded copy: the section states the total; fall back to counting HC rows.
  const hardcodedLines = parts.get("hardcoded") ?? [];
  const stated = hardcodedLines.map((line) => /^(\d+) user-visible string/.exec(line.trim())).find(Boolean);
  const hardcodedCopy = stated ? Number(stated[1]) : hardcodedLines.filter((line) => /^\|\s*HC-\d+/.test(line.trim())).length;

  // API drift subsections (#### Meta / High-risk findings / API inventory / Stale constants / Environment base URLs).
  const api = subsections(parts.get("api") ?? []);
  for (const row of (api.get("high-risk findings") ?? []).filter(isDataRow).slice(1)) {
    const c = cells(row);
    findings.push(finding(key, "api-high-risk", c[0] ?? "", `${c[0] ?? ""} ${c.at(-1) ?? ""}`.trim(), "High", "Confirmed", row));
  }
  let apiDrift = findings.filter((item) => item.kind === "api-high-risk").length;
  for (const row of (api.get("api inventory") ?? []).filter(isDataRow).slice(1)) {
    const c = cells(row);
    if (/drift/i.test(c[1] ?? "")) {
      apiDrift++;
      findings.push(finding(key, "api-drift", c[0] ?? "", c[0] ?? "", "Medium", "Potential", row));
    }
  }
  for (const row of (api.get("stale constants") ?? []).filter(isDataRow).slice(1)) {
    const c = cells(row);
    findings.push(finding(key, "api-stale-constant", c[0] ?? "", c[0] ?? "", "Low", "Confirmed", row));
  }
  for (const row of (api.get("environment base urls") ?? []).filter(isDataRow).slice(1)) {
    if (/mismatch|differ|drift/i.test(row)) {
      const c = cells(row);
      findings.push(finding(key, "api-base-url", c[0] ?? "", `base URL ${c[0] ?? ""}`, "High", "Confirmed", row));
    }
  }

  const coverage = coverageOf(lines);
  const counts = {
    high: findings.filter((item) => item.severity === "High").length,
    highConfirmed: findings.filter((item) => item.severity === "High" && item.confidence === "Confirmed").length,
    medium: findings.filter((item) => item.severity === "Medium").length,
    low: findings.filter((item) => item.severity === "Low").length,
    apiDrift,
    uiDivergent,
    hardcodedCopy,
  };
  const penalty =
    findings.reduce((sum, item) => sum + item.weight, 0) + Math.min(HARDCODED_CAP, hardcodedCopy * HARDCODED_WEIGHT);
  const score = incompleteSections.includes("bl") ? null : round(Math.max(0, 100 - penalty));
  const miscellaneous = key === "miscellaneous";
  return {
    key,
    label,
    miscellaneous,
    findings,
    counts,
    coverage,
    incompleteSections,
    score,
    status: statusOf({ score, counts, coverage, incomplete: incompleteSections.length > 0 }),
  };
}

function subsections(lines: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current = "";
  for (const line of lines) {
    const heading = /^####\s+(.+)$/.exec(line);
    if (heading) {
      current = heading[1].trim().toLowerCase();
      map.set(current, []);
      continue;
    }
    if (current) map.get(current)!.push(line);
  }
  return map;
}

/** Share of matching source files the audit read, from its coverage note. */
export function coverageOf(lines: string[]): number | null {
  const note = lines.find((line) => line.includes("Budget audit coverage"));
  const match = note && /scanned (\d+)\/(\d+) matching Android and (\d+)\/(\d+) matching iOS/.exec(note);
  if (!match) return null;
  const [read, total] = [Number(match[1]) + Number(match[3]), Number(match[2]) + Number(match[4])];
  return total === 0 ? 1 : round(read / total, 3);
}

export function statusOf(input: { score: number | null; counts: ModuleSummary["counts"]; coverage: number | null; incomplete: boolean }): Status {
  if (input.score === null || input.incomplete || (input.coverage !== null && input.coverage < MIN_COVERAGE)) return "grey";
  if (input.counts.highConfirmed > 0 || input.score < 60) return "red";
  if (input.counts.high > 0 || input.score < 80) return "amber";
  return "green";
}

const STATUS_RANK: Record<Status, number> = { red: 3, amber: 2, grey: 1, green: 0 };

export function worstStatus(statuses: Status[]): Status {
  if (statuses.length === 0) return "grey";
  return statuses.reduce((worst, status) => (STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst), "green" as Status);
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function main(argv: string[]): number {
  const input = argv.find((arg, index) => !arg.startsWith("--") && !argv[index - 1]?.startsWith("--"));
  if (!input) {
    console.error("Usage: npm run summarize -- <parity-report.md> [--out summary.json]");
    return 1;
  }
  const summary = summarizeReport(readFileSync(path.resolve(input), "utf8"));
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  const out = flag(argv, "--out");
  if (out) writeFileSync(path.resolve(out), json);
  else process.stdout.write(json);
  console.error(
    `${summary.modules.length} module(s), score ${summary.score ?? "n/a"}, status ${summary.status}, ` +
      `High ${summary.totals.high} (${summary.totals.highConfirmed} confirmed), Medium ${summary.totals.medium}, Low ${summary.totals.low}`,
  );
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exit(main(process.argv.slice(2)));
