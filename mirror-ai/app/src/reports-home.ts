/**
 * Builds the report indexes on superapp-workspace main:
 *
 *   reports/README.md        home page: one row per app, its latest report
 *   reports/<app>/README.md  that app's reports grouped by sprint (branch),
 *                            newest sprint first, newest report first
 *   README.html beside each  one self-contained offline page holding every
 *                            index and every parity-report.html (see bundleHtml)
 *
 *   node --experimental-strip-types src/reports-home.ts <reports_dir> [--apps caribbean,panama,lcpr]
 *
 * Every report folder holds run.json (written by run-meta.ts and ark-publish.sh);
 * `generatedBy` in it names who ran the audit. Folder names follow
 * <App>-<Module | Module+N | ALL>-<YYYY-MM-DD> (see reportFolderName).
 */
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { branches, branchLabel } from "./branch-label.ts";

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
  security?: boolean;
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
  const scope = mods.length === 0 ? "ALL" : mods.length === 1 ? mods[0] : `${mods[0]}+${mods.length - 1}`;
  // A security audit gets its own folder (<App>-<scope>-SEC-<date>) next to the parity reports.
  const what = run.security ? `${scope}-SEC` : scope;
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

/** Sprint group for a run: one sprint when both platforms agree, else `Android: Sprint-21 · iOS: Sprint-22`. */
export function sprintOfRun(run: Run): string {
  const { android, ios } = branches(run);
  const a = sprintOf(android ?? ios), i = sprintOf(ios ?? android);
  return a === i ? a : `Android: ${a} · iOS: ${i}`;
}

/** Branch cell: `release/x`, or Android: `a` · iOS: `b` when the platforms were on different branches. */
const branchCell = (run: Run) => {
  const { android, ios } = branches(run);
  const c = (b: string) => `\`${cell(b)}\``;
  if (android && ios && android !== ios) return `Android: ${c(android)} · iOS: ${c(ios)}`;
  const one = branchLabel(run);
  return one ? c(one) : "—";
};

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
    const k = sprintOfRun(r.run);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [sprint, list] of groups) {
    out.push(`## ${sprint}`, "", "| Report name | Generated by / Assignee | Modules | Branch | Date | Jira | Report |", "|---|---|---|---|---|---|---|");
    for (const r of list) {
      const html = r.files.includes("parity-report.html") ? `[HTML](${url(`${appId}/${r.folder}/parity-report.html`, false, appId)})` : "";
      const md = r.files.includes("parity-report.md") ? `[MD](${url(`${appId}/${r.folder}/parity-report.md`, false, appId)})` : "";
      out.push(
        `| [${cell(r.folder)}](${url(`${appId}/${r.folder}`, true, appId)}) | ${cell(r.run.generatedBy || "—")} | ${cell(what(r.run))} | ${branchCell(r.run)} | ${fmtDate(r.run.date)} | ${r.run.jiraKey && r.run.jiraUrl ? `[${r.run.jiraKey}](${r.run.jiraUrl})` : "—"} | ${[html, md].filter(Boolean).join(" · ")} |`,
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
      `| [${appName(a.id)}](${url(a.id, true)}) | ${cell(r.folder)} | ${cell(r.run.generatedBy || "—")} | ${branchCell(r.run)} | ${fmtDate(r.run.date)} | [HTML](${url(`${a.id}/${r.folder}/parity-report.html`)}) · [Folder](${url(a.id, true)}) |`,
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

/** The headings, text and tables of an index README.md as HTML, links mapped by `href`. */
function mdBody(md: string, href: (h: string) => string): string {
  const lines = md.split("\n");
  const body: string[] = [];
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) body.push(`<h${h[1].length}>${inline(h[2], href)}</h${h[1].length}>`);
    else if (line.trim().startsWith("|") && /^\s*\|[-|\s:]+\|\s*$/.test(lines[k + 1] ?? "")) {
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
  return body.join("\n");
}

export type Bundle = { home: string; apps: { id: string; html: string }[]; reports: { app: string; folder: string; title: string; gz: string }[] };

/**
 * Everything in one offline page: the home index, every app's index and every
 * parity-report.html (gzip + base64, unpacked in the browser on click). The same
 * page is written as reports/README.html and reports/<app>/README.html, opening on
 * the home or that app's view, so downloading any ONE of them gives a manager every
 * report of every app with nothing else to fetch.
 */
export function buildBundle(dir: string, apps: { id: string; reports: Report[] }[], mdUrl: (rel: string) => string): Bundle {
  const has = new Set<string>();
  const reports: Bundle["reports"] = [];
  for (const a of apps)
    for (const r of a.reports) {
      const file = path.join(dir, a.id, r.folder, "parity-report.html");
      if (!existsSync(file)) continue;
      has.add(`${a.id}/${r.folder}`);
      reports.push({ app: a.id, folder: r.folder, title: `${appName(a.id)} · ${r.folder}`, gz: gzipSync(readFileSync(file), { level: 9 }).toString("base64") });
    }
  const map = (from: string) => (h: string) => {
    if (/^[a-z]+:/i.test(h) || h.startsWith("#")) return h;
    const rel = path.posix.normalize(path.posix.join(from || ".", decodeURIComponent(h))).replace(/\/$/, "");
    if (rel === "." || rel === "") return "#/";
    if (rel.endsWith(".md")) return mdUrl(rel);
    const [app, folder, file] = rel.split("/");
    if (folder === undefined) return apps.some((a) => a.id === app) ? `#/app/${encodeURIComponent(app)}` : h;
    if (has.has(`${app}/${folder}`) && (file === undefined || file === "parity-report.html")) return `#/report/${encodeURIComponent(app)}/${encodeURIComponent(folder)}`;
    return mdUrl(rel);
  };
  return {
    home: mdBody(homeIndex(apps), map("")),
    apps: apps.map((a) => ({ id: a.id, html: mdBody(appIndex(a.id, a.reports), map(a.id)) })),
    reports,
  };
}

export function bundleHtml(b: Bundle, start: string): string {
  const views = [`<section data-view="/">${b.home}</section>`, ...b.apps.map((a) => `<section data-view="/app/${esc(a.id)}" hidden>${a.html}</section>`)];
  const data = b.reports
    .map((r, i) => `<script type="application/gzip;base64" id="r${i}" data-key="${esc(`${r.app}/${r.folder}`)}" data-title="${esc(r.title)}" data-app="${esc(r.app)}">${r.gz}</script>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mirror AI reports</title>
<style>
:root { --bg:#ffffff; --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --head:#f6f8fa; --link:#0969da; --code:#eff1f3; --bar:#f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#3d444d; --head:#151b23; --link:#4493f8; --code:#262c36; --bar:#151b23; } }
* { box-sizing: border-box; }
html, body { height:100%; }
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
.note { font-size:13px; }
#viewer { position:fixed; inset:0; display:flex; flex-direction:column; background:var(--bg); }
#viewer[hidden] { display:none; }
#bar { display:flex; gap:16px; align-items:center; flex-wrap:wrap; padding:8px 16px; border-bottom:1px solid var(--line); background:var(--bar); }
#bar strong { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#bar button { font:inherit; color:var(--link); background:none; border:0; padding:0; cursor:pointer; }
#frame { flex:1; width:100%; border:0; background:#fff; }
#msg { padding:24px 16px; color:var(--muted); }
</style>
</head>
<body>
<main>
${views.join("\n")}
<p class="note">Offline bundle: this one file holds every app's index and all ${b.reports.length} report(s). Save it and open it anywhere, no other files needed.</p>
</main>
<div id="viewer" hidden>
  <div id="bar"><a id="back" href="#/">← Back</a><strong id="title"></strong><button id="tab" type="button">Open in new tab</button><button id="save" type="button">Download report</button></div>
  <div id="msg" hidden></div>
  <iframe id="frame" title="Report"></iframe>
</div>
${data}
<script>
(() => {
  const START = ${JSON.stringify(start)};
  const $ = (id) => document.getElementById(id);
  const cache = new Map();
  let current = null;
  async function unpack(el) {
    if (cache.has(el.id)) return cache.get(el.id);
    const bin = Uint8Array.from(atob(el.textContent.trim()), (c) => c.charCodeAt(0));
    const html = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    cache.set(el.id, html);
    return html;
  }
  function show(view) {
    $("viewer").hidden = true;
    document.title = "Mirror AI reports";
    let found = false;
    for (const s of document.querySelectorAll("section[data-view]")) { const on = s.dataset.view === view; s.hidden = !on; found ||= on; }
    if (!found) document.querySelector('section[data-view="/"]').hidden = false;
    window.scrollTo(0, 0);
  }
  async function open(key) {
    const el = [...document.querySelectorAll("script[data-key]")].find((s) => s.dataset.key === key);
    if (!el) return show("/");
    $("viewer").hidden = false;
    $("title").textContent = el.dataset.title;
    $("back").href = "#/app/" + encodeURIComponent(el.dataset.app);
    document.title = el.dataset.title;
    $("msg").hidden = true;
    $("frame").hidden = false;
    try {
      current = { html: await unpack(el), name: key.replace(/\\//g, "_") + ".html" };
      $("frame").srcdoc = current.html;
    } catch (e) {
      $("frame").hidden = true;
      $("msg").hidden = false;
      $("msg").textContent = "This browser cannot unpack the report (" + e + "). Open the file in a current Chrome, Edge, Safari or Firefox.";
    }
  }
  function route() {
    const h = decodeURIComponent((location.hash || "#" + START).slice(1)) || "/";
    if (h.startsWith("/report/")) open(h.slice(8)); else show(h);
  }
  const blobUrl = () => URL.createObjectURL(new Blob([current.html], { type: "text/html" }));
  $("tab").onclick = () => current && window.open(blobUrl(), "_blank");
  $("save").onclick = () => { if (!current) return; const a = document.createElement("a"); a.href = blobUrl(); a.download = current.name; a.click(); };
  window.addEventListener("hashchange", route);
  route();
})();
</script>
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
  const base = b >= 0 ? argv[b + 1].replace(/\/$/, "") : "";
  const branch = at >= 0 ? argv[at + 1] : "";

  // README.html: the self-contained offline bundle, one copy per folder, each opening on its own view.
  // Built from the relative-link indexes; Markdown reports are not embedded, so their links go to
  // Bitbucket when --base is given.
  BASE = "";
  AT = "";
  const bundle = buildBundle(dir, apps, (rel) => (base ? `${base}/${enc(rel)}${branch ? `?at=${encodeURIComponent(branch)}` : ""}` : enc(rel)));
  writeFileSync(path.join(dir, "README.html"), bundleHtml(bundle, "/"));
  for (const a of apps) {
    mkdirSync(path.join(dir, a.id), { recursive: true });
    writeFileSync(path.join(dir, a.id, "README.html"), bundleHtml(bundle, `/app/${a.id}`));
  }

  // README.md: what Bitbucket renders under a folder's file listing (README.* is the home page).
  BASE = base;
  AT = branch;
  for (const a of apps) writeFileSync(path.join(dir, a.id, "README.md"), appIndex(a.id, a.reports));
  writeFileSync(path.join(dir, "README.md"), homeIndex(apps));
  console.error(`README.md + README.html (offline bundle, ${bundle.reports.length} report(s)) written in ${dir} and ${apps.length} app folder(s)`);
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exit(main(process.argv.slice(2)));
