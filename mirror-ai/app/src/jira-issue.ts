/**
 * Builds the Jira issue (summary + Atlassian Document Format description) for
 * one Mirror AI run, from the run's summary.json and run.json. Deterministic:
 * no model copies the payload, so nothing is dropped or reworded.
 *
 *   node --experimental-strip-types src/jira-issue.ts <artifacts_dir> [--project TER] [--out jira-issue.json]
 *
 * The description says what was audited (market, scope, modules, branch and
 * commits per platform, Ark session, date), the totals, a per-module table,
 * the top High findings and links to the HTML / Markdown report. The report
 * files themselves are attached by scripts/ark-jira.sh.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Counts = { high: number; highConfirmed: number; medium: number; low: number; apiDrift: number; uiDivergent: number; hardcodedCopy: number };
type Finding = { kind: string; id: string; area: string; severity: string; confidence: string; files?: string[] };
type ModuleSummary = { key: string; label: string; miscellaneous?: boolean; counts: Counts; findings: Finding[]; score: number; status: string; incompleteSections?: string[] };
export type Summary = { totals: Counts & { modules: number; incompleteModules: number }; score: number; status: string; modules: ModuleSummary[] };
export type RunMeta = {
  app?: string;
  market?: string;
  date?: string;
  scope?: string;
  modules?: string[];
  branch?: string;
  android?: { branch?: string; commit?: string };
  ios?: { branch?: string; commit?: string };
  sessionId?: string;
  reportUrl?: string;
  reportMdUrl?: string;
};

type Node = Record<string, unknown>;
const text = (t: string, marks?: Node[]): Node => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });
const bold = (t: string) => text(t, [{ type: "strong" }]);
const code = (t: string) => text(t, [{ type: "code" }]);
const link = (t: string, href: string) => text(t, [{ type: "link", attrs: { href } }]);
const para = (...parts: (Node | string)[]): Node => ({ type: "paragraph", content: parts.map((p) => (typeof p === "string" ? text(p) : p)) });
const heading = (level: number, t: string): Node => ({ type: "heading", attrs: { level }, content: [text(t)] });
const bullets = (items: (Node | string)[][]): Node => ({ type: "bulletList", content: items.map((parts) => ({ type: "listItem", content: [para(...parts)] })) });
const cell = (parts: (Node | string)[], header = false): Node => ({ type: header ? "tableHeader" : "tableCell", content: [para(...parts)] });
const table = (head: string[], rows: (Node | string)[][]): Node => ({
  type: "table",
  attrs: { isNumberColumnEnabled: false, layout: "default" },
  content: [{ type: "tableRow", content: head.map((h) => cell([h], true)) }, ...rows.map((r) => ({ type: "tableRow", content: r.map((c) => cell([c])) }))],
});
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const short = (sha?: string) => (sha ? sha.slice(0, 7) : "unknown");

export function buildJiraIssue(summary: Summary, run: RunMeta, opts: { project?: string; top?: number } = {}): { fields: Node } {
  const market = run.market || run.app || "unknown-market";
  const t = summary.totals;
  const mods = summary.modules ?? [];
  const names = mods.filter((m) => !m.miscellaneous).map((m) => m.label);
  const whole = run.scope === "project";
  const date = (run.date ?? new Date().toISOString()).slice(0, 10);
  const branch = run.branch || run.android?.branch || run.ios?.branch || "unknown";
  const what = whole ? `whole-project parity audit (${mods.length} modules)` : names.length <= 3 ? `${names.join(", ")} parity audit` : `${names.length}-module parity audit`;
  const summaryLine = cut(`[${market}] Mirror AI — ${what} @ ${branch} (${date})`, 250);

  const scopeText = whole ? `Whole project — ${mods.length} modules (every module common to Android and iOS, plus Miscellaneous)` : `Selected modules — ${names.join(", ")}`;
  const top = opts.top ?? 15;
  const rank = (f: Finding) => (/^confirmed/i.test(f.confidence) ? 0 : /runtime/i.test(f.confidence) ? 1 : 2);
  const highs = mods
    .flatMap((m) => m.findings.filter((f) => /^high$/i.test(f.severity)).map((f) => ({ module: m.label, ...f })))
    .sort((a, b) => rank(a) - rank(b));

  const content: Node[] = [
    para(bold("Mirror AI Android/iOS parity audit"), ` — ${market}.`),
    heading(3, "What was audited"),
    bullets([
      [bold("Market / app: "), `${market}${run.app && run.app !== market ? ` (${run.app})` : ""}`],
      [bold("Scope: "), cut(scopeText, 400)],
      [bold("Branch: "), code(branch)],
      [bold("Android: "), code(run.android?.branch || branch), " @ ", code(short(run.android?.commit))],
      [bold("iOS: "), code(run.ios?.branch || branch), " @ ", code(short(run.ios?.commit))],
      [bold("Ark session: "), run.sessionId ? code(run.sessionId) : "n/a", " · flow ", code("telco-apps-mirror-audit")],
      [bold("Date: "), date],
    ]),
    heading(3, "Result"),
    bullets([
      [bold("Score: "), `${summary.score} (${summary.status})`],
      [bold("Business logic: "), `High ${t.high} (${t.highConfirmed} confirmed) · Medium ${t.medium} · Low ${t.low}`],
      [bold("API contract drift: "), String(t.apiDrift), " · ", bold("Divergent UI slots: "), String(t.uiDivergent), " · ", bold("Hard-coded strings: "), String(t.hardcodedCopy)],
      ...(t.incompleteModules ? [[bold("Incomplete modules: "), String(t.incompleteModules)]] : []),
    ]),
    para(
      bold("Report: "),
      run.reportUrl ? link("HTML report", run.reportUrl) : text("HTML report attached"),
      " · ",
      run.reportMdUrl ? link("Markdown", run.reportMdUrl) : text("Markdown attached"),
      " · the HTML and Markdown are also attached to this issue.",
    ),
    heading(3, `Modules (${mods.length})`),
    table(
      ["Module", "High", "Medium", "Low", "API drift", "Score"],
      [...mods]
        .sort((a, b) => b.counts.high - a.counts.high || a.score - b.score)
        .map((m) => [m.label, `${m.counts.high}${m.counts.highConfirmed ? ` (${m.counts.highConfirmed}✓)` : ""}`, String(m.counts.medium), String(m.counts.low), String(m.counts.apiDrift), `${m.score} ${m.status}`]),
    ),
    heading(3, highs.length > top ? `Top ${top} of ${highs.length} High findings` : `High findings (${highs.length})`),
  ];
  if (!highs.length) content.push(para("No High-severity business-logic findings."));
  else
    content.push(
      bullets(
        highs.slice(0, top).map((f) => {
          const files = [...new Set((f.files ?? []).map((x) => x.split("/").pop() as string))].slice(0, 2);
          return [bold(`${f.module} ${f.id}`), ` — ${cut(f.area, 90)} (${f.confidence || "n/a"})${files.length ? ` · ${files.join(", ")}` : ""}`];
        }),
      ),
    );
  if (highs.length > top) content.push(para(`+${highs.length - top} more High findings in the attached report.`));

  return {
    fields: {
      project: { key: opts.project || "TER" },
      issuetype: { name: "Task" },
      summary: summaryLine,
      labels: ["mirror-ai", "android-ios-parity", market.replace(/\s+/g, "-")],
      description: { type: "doc", version: 1, content },
    },
  };
}

export function main(argv: string[]): number {
  const dir = argv.find((a, k) => !a.startsWith("--") && !/^--(project|out)$/.test(argv[k - 1] ?? ""));
  const opt = (n: string) => {
    const k = argv.indexOf(`--${n}`);
    return k >= 0 ? argv[k + 1] : undefined;
  };
  if (!dir) {
    console.error("Usage: node src/jira-issue.ts <artifacts_dir> [--project TER] [--out jira-issue.json]");
    return 1;
  }
  const summary = JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8")) as Summary;
  const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunMeta;
  const issue = buildJiraIssue(summary, run, { project: opt("project") });
  const out = opt("out") ?? path.join(dir, "jira-issue.json");
  writeFileSync(out, JSON.stringify(issue));
  console.error(`jira-issue: ${out} (${JSON.stringify(issue).length} bytes)`);
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exit(main(process.argv.slice(2)));
