/**
 * The security rules knowledge base: `docs/security-rules.md` in
 * superapp-workspace. Each rule is one root cause seen in past findings (VULN
 * tickets, earlier Mirror AI reports), with how to detect it statically.
 *
 * The security pass gets a compact digest of the rules (ID, name, severity,
 * detection logic, false positives) so every finding is mapped to a Rule ID or
 * marked NEW. A rule is a detection hint, never evidence: findings still need
 * citations from the pinned checkouts.
 *
 * Where the rules come from, in order:
 *   1. MIRROR_AI_SECURITY_RULES — a file path (ark-audit.sh fetches the latest
 *      docs/security-rules.md from superapp-workspace mirror-ai-reports into the run folder);
 *   2. the bundled copy at prompts/references/security-rules.md.
 *
 * `node src/security-rules.ts proposals <report.md> <out.md> [label]` writes the report's
 * NEW-rule proposals for human review; nothing here edits the rules file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The bundled fallback copy, relative to the Mirror AI root. */
export const BUNDLED_SECURITY_RULES = "prompts/references/security-rules.md";

/** `SR-CRYPTO-001`: area of capitals (digits allowed), then three or more digits. */
export const RULE_ID = /^SR-[A-Z][A-Z0-9]*-\d{3,}$/;
/** A rule ID anywhere in a text. */
const RULE_ID_IN = /\bSR-[A-Z][A-Z0-9]*-\d{3,}\b/i;

/** The Rule cell of a finding that no rule covers. */
export const NEW_RULE = "NEW";

export interface SecurityRule {
  id: string;
  name: string;
  category: string;
  severity: string;
  platforms: string;
  reference: string;
  /** `Retired` when the rule is kept only for its history. */
  status: string;
  detection: string;
  falsePositives: string;
}

export interface LoadedRules {
  rules: SecurityRule[];
  /** Where the text came from, e.g. `superapp-workspace docs/security-rules.md @ 1a2b3c4` or the bundled path. */
  source: string;
}

/** Splits the rules file into one rule per `### SR-…` heading and reads its fields. */
export function parseSecurityRules(text: string): SecurityRule[] {
  const rules: SecurityRule[] = [];
  // `### SR-NET-004 — name`, also with `-`, `–` or `:` between the ID and the name.
  const heads = [...text.matchAll(/^###\s+(SR-[A-Z][A-Z0-9]*-\d{3,})\s*[—–:-]\s*(.+)$/gm)];
  heads.forEach((head, index) => {
    const start = head.index! + head[0].length;
    // A rule ends at the next rule, or at the next `##`/`###` heading that is not one of its fields.
    const rest = text.slice(start, index + 1 < heads.length ? heads[index + 1].index : undefined);
    const end = rest.search(/^#{2,3}\s/m);
    const body = end >= 0 ? rest.slice(0, end) : rest;
    // `- **Field:** value`, `- **Field**: value` or `Field: value`.
    const meta = (field: string) => new RegExp(`^(?:[-*]\\s+)?\\**${field}\\**:\\**\\s*(.+)$`, "mi").exec(body)?.[1].trim() ?? "";
    const section = (field: string) => {
      const match = new RegExp(`^####\\s+${field}\\s*$`, "mi").exec(body);
      if (!match) return "";
      const after = body.slice(match.index + match[0].length);
      const next = after.search(/^####\s/m);
      return (next >= 0 ? after.slice(0, next) : after).trim();
    };
    rules.push({
      id: head[1],
      name: meta("Rule Name") || head[2].trim(),
      category: meta("Security Category"),
      severity: meta("Severity"),
      platforms: meta("Affected Platforms"),
      reference: meta("Reference"),
      status: meta("Status") || "Active",
      detection: section("Detection Logic"),
      falsePositives: section("False Positive Considerations"),
    });
  });
  return rules;
}

/** Reads the rules from MIRROR_AI_SECURITY_RULES, else the bundled copy. Never throws. */
export function loadSecurityRules(projectRoot: string, env: NodeJS.ProcessEnv = process.env): LoadedRules {
  const override = env.MIRROR_AI_SECURITY_RULES?.trim();
  const candidates = [
    ...(override ? [{ file: path.resolve(override), source: env.MIRROR_AI_SECURITY_RULES_SOURCE?.trim() || override }] : []),
    { file: path.join(projectRoot, BUNDLED_SECURITY_RULES), source: `bundled ${BUNDLED_SECURITY_RULES}` },
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate.file)) continue;
    try {
      const rules = parseSecurityRules(readFileSync(candidate.file, "utf8"));
      if (rules.length > 0) return { rules, source: candidate.source };
    } catch {
      // try the next source
    }
  }
  return { rules: [], source: "none" };
}

/** Collapses a rule section to one line for the prompt digest. */
function oneLine(text: string, max: number): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The part of the security pass prompt that carries the rules: how to map
 * findings, then one compact entry per active rule.
 */
export function securityRulesPrompt(loaded: LoadedRules): string {
  const active = loaded.rules.filter((rule) => !/retired/i.test(rule.status));
  if (active.length === 0) return "";
  // Rules that only a server can show are not looked for in app code; they are named once for *Not assessed*.
  const serverOnly = active.filter((rule) => /^\s*backend\s*$/i.test(rule.platforms));
  const checked = active.filter((rule) => !serverOnly.includes(rule));
  const entries = checked.map((rule) =>
    [
      `- **${rule.id}** ${rule.name} — ${rule.category}; baseline ${rule.severity}; ${rule.platforms}.`,
      `  Detect: ${oneLine(rule.detection, 2000)}`,
      rule.falsePositives ? `  Not a finding: ${oneLine(rule.falsePositives, 1000)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return [
    "# Security rules (knowledge base)",
    "",
    `Rules source: ${loaded.source} (${active.length} active rules).`,
    "",
    "Use these rules as a checklist of root causes to look for, and to label findings:",
    "",
    "- Put the matching Rule ID in the **Rule** column of every Security findings row, or `NEW` when no rule's root cause fits.",
    "- A rule is a detection hint, not evidence. Report a rule only when the pinned checkouts show it, with file and line citations. Never copy a rule's references, tickets or examples into a finding.",
    "- One root cause is one finding: never publish two rows with the same Rule and the same cited code location. Where a module-level root cause is the App-wide one, refer to it instead of repeating it.",
    "- Check each rule's *Not a finding* note before reporting it. Start from the rule's baseline severity and adjust it to what the code shows.",
    "- For every `NEW` row, add a *Proposed rules* row (see the skill).",
    "",
    ...entries,
    ...(serverOnly.length
      ? ["", `Server-side only, not detectable in app code (list under *Not assessed* when relevant): ${serverOnly.map((rule) => `${rule.id} ${rule.name}`).join("; ")}.`]
      : []),
  ].join("\n");
}

export interface ProposedRule {
  module: string;
  id: string;
  name: string;
  category: string;
  findings: string;
  evidence: string;
  closest: string;
}

/** A citation the proposal can be checked against: `path/File.ext:12`. */
const CITATION = /[A-Za-z0-9_.+\-/]+\.(?:kt|kts|java|swift|m|mm|cpp|h|xml|plist|pro|gradle|toml|json|entitlements|xcconfig|resolved|lock|properties)(?::\d+)/;

/** Table cells, honouring `\\|` inside a cell. */
function tableCells(line: string): string[] {
  return line
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim())
    .slice(1, -1);
}

/**
 * Reads every *Proposed rules* row of the report's Security Analysis sections.
 * Keeps a proposal only when it cites code (`path:line`); drops one that names
 * a rule ID (a proposal is never an existing or invented rule) or repeats an
 * existing rule's name, and drops repeats of the same proposed name.
 */
export function extractProposedRules(report: string, known: Iterable<Pick<SecurityRule, "id" | "name">> = []): ProposedRule[] {
  const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const knownNames = new Set([...known].map((rule) => norm(rule.name)));
  const out: ProposedRule[] = [];
  const seen = new Set<string>();
  let module = "";
  let inProposed = false;
  let header: string[] | null = null;
  for (const line of report.split("\n")) {
    const title = /^# Business logic audit — (.+)$/.exec(line);
    if (title) {
      module = title[1].trim();
      inProposed = false;
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      inProposed = /^####\s+Proposed rules/i.test(line);
      header = null;
      continue;
    }
    if (!inProposed || !line.trim().startsWith("|") || /^\|\s*:?-{2,}/.test(line.trim())) continue;
    const c = tableCells(line);
    if (!header) {
      header = c.map((cell) => cell.toLowerCase());
      continue;
    }
    const at = (re: RegExp) => {
      const index = header!.findIndex((cell) => re.test(cell));
      return index >= 0 ? (c[index] ?? "").replace(/\*/g, "").trim() : "";
    };
    const proposal: ProposedRule = {
      module,
      id: at(/^id$/),
      name: at(/name/),
      category: at(/category|domain/),
      findings: at(/finding/),
      evidence: at(/evidence|citation/),
      closest: at(/closest|nearest|existing/),
    };
    if (!proposal.name || !CITATION.test(proposal.evidence)) continue;
    if (RULE_ID_IN.test(proposal.name) || RULE_ID_IN.test(proposal.id) || knownNames.has(norm(proposal.name))) continue;
    const key = norm(proposal.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(proposal);
  }
  return out;
}

/** Rule IDs the report uses that the rules file does not define, as `<module> <SEC-id>: <rule>`. */
export function unknownRuleIds(report: string, known: Iterable<string>): string[] {
  const ids = new Set(known);
  const out: string[] = [];
  let module = "";
  let ruleAt = -1;
  for (const line of report.split("\n")) {
    const title = /^# Business logic audit — (.+)$/.exec(line);
    if (title) module = title[1].trim();
    if (!line.trim().startsWith("|")) continue;
    const c = tableCells(line);
    if (/^\**id\**$/i.test(c[0] ?? "")) {
      ruleAt = c.findIndex((cell) => /^\**rule\**$/i.test(cell));
      continue;
    }
    if (ruleAt < 0 || !/^\**SEC-\d+/.test(c[0] ?? "")) continue;
    const rule = RULE_ID_IN.exec(c[ruleAt] ?? "")?.[0].toUpperCase();
    if (rule && !ids.has(rule)) out.push(`${module} ${c[0].replace(/\*/g, "")}: ${rule}`);
  }
  return out;
}

/** The review file written next to the report; empty string when there is nothing to review. */
export function renderProposals(proposals: ProposedRule[], rulesSource: string, reportLabel: string, unknown: string[] = []): string {
  if (proposals.length === 0 && unknown.length === 0) return "";
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "—";
  return [
    "# Proposed security rules",
    "",
    `From ${reportLabel}. Rules in force for this run: ${rulesSource}.`,
    "",
    "These are **proposals** from the security pass for root causes that no rule in",
    "`docs/security-rules.md` covered. Each one cites code from this run. None is",
    "validated: before adding one, re-read the cited code, then open a PR to",
    "`docs/security-rules.md` that either adds a rule with the next free ID in its area",
    "or extends the closest rule. Do not remove existing references.",
    "",
    "| # | Module | Finding | Proposed rule | Category | Evidence | Closest existing rule |",
    "|---|--------|---------|---------------|----------|----------|-----------------------|",
    ...proposals.map(
      (p, index) =>
        `| ${index + 1} | ${cell(p.module)} | ${cell(p.findings)} | ${cell(p.name)} | ${cell(p.category)} | ${cell(p.evidence)} | ${cell(p.closest)} |`,
    ),
    ...(unknown.length
      ? ["", "## Rule IDs not in the rules file", "", "These findings name a rule that `docs/security-rules.md` does not define. Map them to a real rule or treat them as `NEW`:", "", ...unknown.map((item) => `- ${item}`)]
      : []),
    "",
  ].join("\n");
}

/** CLI: `proposals <report.md> <out.md> [label]` — writes the review file when there is at least one proposal. */
function main(argv: string[]): number {
  const [command, reportPath, outPath, label] = argv;
  if (command === "count" && reportPath) {
    // How many rules a file holds, by the same parser the audit uses (ark-audit.sh checks a fetched file with it).
    try {
      console.log(parseSecurityRules(readFileSync(reportPath, "utf8")).length);
    } catch {
      console.log(0);
    }
    return 0;
  }
  if (command !== "proposals" || !reportPath || !outPath) {
    console.error("usage: node src/security-rules.ts proposals <parity-report.md> <proposed-security-rules.md> [report label]");
    return 2;
  }
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const loaded = loadSecurityRules(projectRoot);
  const report = readFileSync(reportPath, "utf8");
  const proposals = extractProposedRules(report, loaded.rules);
  const unknown = unknownRuleIds(report, loaded.rules.map((rule) => rule.id));
  const text = renderProposals(proposals, loaded.source, label || path.basename(path.dirname(path.resolve(reportPath))), unknown);
  if (text) writeFileSync(outPath, text);
  console.error(`security rules: ${loaded.rules.length} from ${loaded.source}; ${proposals.length} proposed rule(s), ${unknown.length} unknown rule ID(s)${text ? ` → ${outPath}` : ""}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
