/**
 * Builds the report indexes on superapp-workspace main:
 *
 *   reports/README.md        home page: one row per app, its latest report
 *   reports/<app>/README.md  that app's reports grouped by sprint (branch),
 *                            newest sprint first, newest report first
 *   README.html beside each  the same page as standalone HTML with relative
 *                            links, to browse the indexes from a clone
 *
 *   node --experimental-strip-types src/reports-home.ts <reports_dir> [--apps caribbean,panama,lcpr]
 *
 * Every report folder holds run.json (written by run-meta.ts and ark-publish.sh);
 * `generatedBy` in it names who ran the audit. Folder names follow
 * <App>-<Module | Module+N | ALL>-<YYYY-MM-DD> (see reportFolderName).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type Run = {
  app?: string;
  market?: string;
  date?: string;
  scope?: string;
  modules?: string[];
  branch?: string;
  android?: { branch?: string; commit?: string };
  ios?: { branch?: string; commit?: string };
  sessionId?: string;
  jiraKey?: string;
  jiraUrl?: string;
  generatedBy?: string;
};
export type Report = { folder: string; run: Run; files: string[] };

export const APP_NAMES: Record<string, string> = { caribbean: "Caribbean", panama: "Panama", lcpr: "LCPR", networkqoe: "NetworkQoE" };
const appName = (id: string) => APP_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

/**
 * `<App>-<Module>-<YYYY-MM-DD in IST>`: one module -> `Caribbean-BILL_PAYMENT-2026-11-12`,
 * several -> first module + how many more, `Caribbean-BILL_PAYMENT+2-2026-11-12`,
 * whole project -> `Caribbean-ALL-2026-11-13`. ark-publish appends `-2`, `-3`, ...
 * when that folder already exists on the reports branch.
 */
export function reportFolderName(appId: string, run: Run): string {
  const mods = run.scope === "project" ? [] : (run.modules ?? []).filter(Boolean);
  const what = mods.length === 0 ? "ALL" : mods.length === 1 ? mods[0] : `${mods[0]}+${mods.length - 1}`;
  const t = run.date ? new Date(run.date) : new Date();
  const ist = new Date(t.getTime() + (5 * 60 + 30) * 60_000); // date in IST, as the READMEs show it
  return `${appName(appId)}-${what}-${ist.toISOString().slice(0, 10)}`.replace(/[^A-Za-z0-9_.+-]/g, "-");
}

/** True for a folder already in the `<App>-<Module>-<YYYY-MM-DD>[-n]` form. */
export const isReportFolderName = (s?: string) => /^[A-Za-z0-9]+-.+-\d{4}-\d{2}-\d{2}(-\d+)?$/.test(s ?? "") && !/_\d{4}-\d{2}-\d{2}_\d{4}$/.test(s ?? "");

/** Sprint group for a branch: `caribbean/release/sprint-20` -> `Sprint-20`, `feature/Sprint-21` -> `Sprint-21`, else the branch. */
export function sprintOf(branch?: string): string {
  const m = /sprint[-_ ]?(\d+)/i.exec(branch ?? "");
  return m ? `Sprint-${m[1]}` : branch || "Unknown branch";
}

/** Report time in IST (UTC+05:30), e.g. 2026-11-13 14:06 IST. */
const fmtDate = (iso?: string) => {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const ist = new Date(t.getTime() + (5 * 60 + 30) * 60_000).toISOString();
  return `${ist.slice(0, 10)} ${ist.slice(11, 16)} IST`;
};
const what = (r: Run) => (r.scope === "project" || !r.modules?.length ? "ALL (full report)" : r.modules.join(", "));
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const cell = (s: string) => s.replace(/\|/g, "\\|");

/**
 * Links are relative to the README they sit in, so they work on any branch (a PR
 * branch before merge, main after). Pass --base <bitbucket src URL of reports/> to
 * make them absolute instead.
 */
let BASE = "";
let AT = "";
const url = (rel: string, folder = false, from = "") => {
  const target = `${enc(rel)}${folder ? "/" : ""}`;
  if (BASE) return `${BASE}/${target}${AT ? `?at=${encodeURIComponent(AT)}` : ""}`;
  const prefix = from ? `${enc(from)}/` : "";
  return target.startsWith(prefix) ? target.slice(prefix.length) || "./" : `../${target}`;
};

export function readReports(appDir: string): Report[] {
  if (!existsSync(appDir)) return [];
  return readdirSync(appDir)
    .filter((f) => statSync(path.join(appDir, f)).isDirectory() && existsSync(path.join(appDir, f, "run.json")))
    .map((folder) => ({ folder, run: JSON.parse(readFileSync(path.join(appDir, folder, "run.json"), "utf8")) as Run, files: readdirSync(path.join(appDir, folder)) }))
    .sort((a, b) => String(b.run.date).localeCompare(String(a.run.date)));
}

export function appIndex(appId: string, reports: Report[]): string {
  const out = [`# ${appName(appId)} — Mirror AI reports`, "", `[← All apps](${BASE ? `${BASE}/${AT ? `?at=${encodeURIComponent(AT)}` : ""}` : "../"})`, ""];
  if (!reports.length) return [...out, "No reports yet.", ""].join("\n");
  out.push("Report name: `<App>-<Module | Module+N | ALL>-<Date>`. Latest sprint and latest report first.", "");
  const groups = new Map<string, Report[]>();
  for (const r of reports) {
    const k = sprintOf(r.run.branch);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [sprint, list] of groups) {
    out.push(`## ${sprint}`, "", "| Report name | Generated by / Assignee | Modules | Branch | Date | Jira | Report |", "|---|---|---|---|---|---|---|");
    for (const r of list) {
      const html = r.files.includes("parity-report.html") ? `[HTML](${url(`${appId}/${r.folder}/parity-report.html`, false, appId)})` : "";
      const md = r.files.includes("parity-report.md") ? `[MD](${url(`${appId}/${r.folder}/parity-report.md`, false, appId)})` : "";
      out.push(
        `| [${cell(r.folder)}](${url(`${appId}/${r.folder}`, true, appId)}) | ${cell(r.run.generatedBy || "—")} | ${cell(what(r.run))} | \`${cell(r.run.branch || "—")}\` | ${fmtDate(r.run.date)} | ${r.run.jiraKey && r.run.jiraUrl ? `[${r.run.jiraKey}](${r.run.jiraUrl})` : "—"} | ${[html, md].filter(Boolean).join(" · ")} |`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}

export function homeIndex(apps: { id: string; reports: Report[] }[]): string {
  const out = [
    "# Mirror AI — Android/iOS parity reports",
    "",
    "Latest report per app. Click the app or Folder to open the app's report folder (full history, grouped by sprint), or HTML for the latest report.",
    "",
    "| App | Report name | Generated by / Assignee | Branch | Date | Report |",
    "|---|---|---|---|---|---|",
  ];
  for (const a of apps) {
    const r = a.reports[0];
    if (!r) {
      out.push(`| [${appName(a.id)}](${url(a.id, true)}) | No reports yet | — | — | — | [Folder](${url(a.id, true)}) |`);
      continue;
    }
    out.push(
      `| [${appName(a.id)}](${url(a.id, true)}) | ${cell(r.folder)} | ${cell(r.run.generatedBy || "—")} | \`${cell(r.run.branch || "—")}\` | ${fmtDate(r.run.date)} | [HTML](${url(`${a.id}/${r.folder}/parity-report.html`)}) · [Folder](${url(a.id, true)}) |`,
    );
  }
  out.push("");
  return out.join("\n");
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline markdown as the indexes use it: `code`, [text](href), with \| kept as a literal pipe. */
function inline(md: string, href: (h: string) => string): string {
  const parts = md.split(/(`[^`]*`)/);
  return parts
    .map((p) =>
      p.startsWith("`") && p.endsWith("`") && p.length > 1
        ? `<code>${esc(p.slice(1, -1).replace(/\\\|/g, "|"))}</code>`
        : esc(p.replace(/\\\|/g, "|")).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, h) => {
            const target = href(h.replace(/&amp;/g, "&"));
            const ext = /^https?:/.test(target) ? ' target="_blank" rel="noopener"' : "";
            return `<a href="${esc(target)}"${ext}>${t}</a>`;
          }),
    )
    .join("");
}

const splitRow = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());

/**
 * The README.md beside it as a standalone page: the same headings, text and tables,
 * with folder links pointed at the README.html inside them (an app folder, the home
 * page) so the indexes can be browsed straight from a clone with no Markdown viewer.
 */
export function indexHtml(md: string, href: (h: string) => string): string {
  const lines = md.split("\n");
  const body: string[] = [];
  let title = "Mirror AI reports";
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      if (h[1] === "#") title = h[2];
      body.push(`<h${h[1].length}>${inline(h[2], href)}</h${h[1].length}>`);
    } else if (line.trim().startsWith("|") && /^\s*\|[-|\s:]+\|\s*$/.test(lines[k + 1] ?? "")) {
      const head = splitRow(line);
      k++;
      const rows: string[][] = [];
      while (k + 1 < lines.length && lines[k + 1].trim().startsWith("|")) rows.push(splitRow(lines[++k]));
      body.push(
        `<div class="wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c, href)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, href)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table></div>",
      );
    } else if (line.trim()) body.push(`<p>${inline(line, href)}</p>`);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title.replace(/`/g, ""))}</title>
<style>
:root { --bg:#ffffff; --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --head:#f6f8fa; --link:#0969da; --code:#eff1f3; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#3d444d; --head:#151b23; --link:#4493f8; --code:#262c36; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width:1200px; margin:0 auto; padding:24px 16px 48px; }
h1 { font-size:1.75em; margin:0 0 12px; padding-bottom:8px; border-bottom:1px solid var(--line); }
h2 { font-size:1.3em; margin:28px 0 8px; padding-bottom:6px; border-bottom:1px solid var(--line); }
p { margin:8px 0 14px; color:var(--muted); }
a { color:var(--link); text-decoration:none; } a:hover { text-decoration:underline; }
code { background:var(--code); padding:1px 6px; border-radius:6px; font:12.5px ui-monospace, SFMono-Regular, Menlo, monospace; white-space:nowrap; }
.wrap { overflow-x:auto; margin:8px 0 16px; }
table { border-collapse:collapse; width:100%; }
th, td { border:1px solid var(--line); padding:7px 12px; text-align:left; vertical-align:top; }
th { background:var(--head); font-weight:600; white-space:nowrap; }
tbody tr:nth-child(even) td { background:color-mix(in srgb, var(--head) 60%, transparent); }
</style>
</head>
<body>
<main>
${body.join("\n")}
</main>
</body>
</html>
`;
}

export function main(argv: string[]): number {
  const dir = argv.find((a, k) => !a.startsWith("--") && !["--apps", "--base", "--at"].includes(argv[k - 1] ?? ""));
  const b = argv.indexOf("--base");
  const at = argv.indexOf("--at");
  if (!dir) {
    console.error("Usage: node src/reports-home.ts <reports_dir> [--apps caribbean,panama,lcpr] [--base <bitbucket src url of reports/>] [--at <branch>]");
    return 1;
  }
  const k = argv.indexOf("--apps");
  const ids = k >= 0 ? argv[k + 1].split(",") : readdirSync(dir).filter((f) => statSync(path.join(dir, f)).isDirectory());
  const apps = ids.map((id) => ({ id, reports: readReports(path.join(dir, id)) }));

  // README.html: always relative links, so it opens from a clone (file://) on any branch.
  // A folder link goes to that folder's README.html when it has one (home, app folders).
  BASE = "";
  AT = "";
  const local = (from: string) => (h: string) => {
    if (/^[a-z]+:/i.test(h) || !h.endsWith("/")) return h;
    const target = path.join(dir, from, decodeURIComponent(h));
    return existsSync(path.join(target, "README.md")) || apps.some((a) => path.resolve(dir, a.id) === path.resolve(target)) || path.resolve(target) === path.resolve(dir)
      ? `${h}README.html`
      : h;
  };
  for (const a of apps) {
    mkdirSync(path.join(dir, a.id), { recursive: true });
    writeFileSync(path.join(dir, a.id, "README.html"), indexHtml(appIndex(a.id, a.reports), local(a.id)));
  }
  writeFileSync(path.join(dir, "README.html"), indexHtml(homeIndex(apps), local("")));

  // README.md: what Bitbucket renders under a folder's file listing (README.* is the home page).
  if (b >= 0) BASE = argv[b + 1].replace(/\/$/, "");
  if (at >= 0) AT = argv[at + 1];
  for (const a of apps) writeFileSync(path.join(dir, a.id, "README.md"), appIndex(a.id, a.reports));
  writeFileSync(path.join(dir, "README.md"), homeIndex(apps));
  console.error(`README.md + README.html, and ${apps.length} app index(es) of each, written in ${dir}`);
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exit(main(process.argv.slice(2)));
