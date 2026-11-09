/**
 * Builds the Mirror AI reports dashboard from a `reports/` tree:
 *
 *   reports/apps.json                      [{ id, name, market, jiraProject? }]
 *   reports/<app>/<run>/summary.json       from report-summary.ts
 *   reports/<app>/<run>/run.json           RunMeta below
 *
 * and writes reports/index.json, reports/README.md, reports/dashboard.html and
 * reports/<app>/README.md. Runs are replayed oldest first: each complete module
 * result replaces that module's state, an incomplete one never does, so a
 * module-scoped run updates only its modules and a failed run changes nothing.
 *
 *   npm run dashboard -- <reports-dir> [--app <id>] [--app-only]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { worstStatus, type Finding, type ModuleSummary, type ReportSummary, type Status } from "./report-summary.ts";

export interface AppConfig {
  id: string;
  name: string;
  market: string;
  jiraProject?: string;
}

export interface RunMeta {
  app: string;
  market?: string;
  date: string;
  scope: "project" | "modules";
  modules?: string[];
  branch?: string;
  android?: { branch?: string; commit?: string };
  ios?: { branch?: string; commit?: string };
  sessionId?: string;
  jiraKey?: string;
  jiraUrl?: string;
  prUrl?: string;
}

/** A module is stale when its last complete audit is older than this. */
export const STALE_DAYS = 14;

export interface ModuleState {
  key: string;
  label: string;
  miscellaneous: boolean;
  score: number;
  status: Status;
  counts: ModuleSummary["counts"];
  coverage: number | null;
  date: string;
  run: string;
  findings: Finding[];
  /** Set when a later run tried this module and could not produce it. */
  lastFailedAt?: string;
}

export interface RunEntry {
  folder: string;
  meta: RunMeta;
  /** App score right after this run was applied. */
  appScore: number | null;
  modules: string[];
  failedModules: string[];
  new: number;
  resolved: number;
  persisting: number;
}

export interface AppIndex {
  id: string;
  name: string;
  market: string;
  status: Status;
  score: number | null;
  previousScore: number | null;
  stale: boolean;
  lastRun: RunEntry | null;
  modules: ModuleState[];
  miscellaneous: ModuleState | null;
  totals: ModuleSummary["counts"] & { modules: number };
  coverage: number | null;
  runs: RunEntry[];
}

export interface DashboardIndex {
  version: 1;
  generatedAt: string;
  apps: AppIndex[];
  hotspots: { key: string; label: string; apps: { id: string; high: number; highConfirmed: number }[] }[];
}

const EMPTY_COUNTS = (): ModuleSummary["counts"] => ({ high: 0, highConfirmed: 0, medium: 0, low: 0, apiDrift: 0, uiDivergent: 0, hardcodedCopy: 0 });

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function loadApps(reportsDir: string): AppConfig[] {
  const configured = readJson<AppConfig[]>(path.join(reportsDir, "apps.json")) ?? [];
  const known = new Set(configured.map((app) => app.id));
  // An app folder with runs but no entry in apps.json still shows up, named after its folder.
  for (const entry of readdirSync(reportsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !known.has(entry.name) && !entry.name.startsWith(".")) {
      configured.push({ id: entry.name, name: entry.name, market: entry.name });
    }
  }
  return configured.sort((left, right) => left.id.localeCompare(right.id));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function appScore(states: Iterable<ModuleState>): number | null {
  const scored = [...states].filter((state) => !state.miscellaneous);
  return scored.length ? round(scored.reduce((sum, state) => sum + state.score, 0) / scored.length) : null;
}

export function buildAppIndex(reportsDir: string, app: AppConfig, now = new Date()): AppIndex {
  const appDir = path.join(reportsDir, app.id);
  const runs: { folder: string; meta: RunMeta; summary: ReportSummary }[] = [];
  if (existsSync(appDir)) {
    for (const entry of readdirSync(appDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const summary = readJson<ReportSummary>(path.join(appDir, entry.name, "summary.json"));
      const meta = readJson<RunMeta>(path.join(appDir, entry.name, "run.json"));
      if (summary && meta) runs.push({ folder: entry.name, meta, summary });
    }
  }
  runs.sort((left, right) => left.meta.date.localeCompare(right.meta.date) || left.folder.localeCompare(right.folder));

  const states = new Map<string, ModuleState>();
  const entries: RunEntry[] = [];
  for (const run of runs) {
    let added = 0;
    let resolved = 0;
    let persisting = 0;
    const done: string[] = [];
    const failed: string[] = [];
    for (const module of run.summary.modules) {
      const previous = states.get(module.key);
      if (module.score === null) {
        failed.push(module.key);
        if (previous) previous.lastFailedAt = run.meta.date;
        continue;
      }
      done.push(module.key);
      if (previous) {
        const before = new Set(previous.findings.map((item) => item.fingerprint));
        const after = new Set(module.findings.map((item) => item.fingerprint));
        for (const print of after) (before.has(print) ? persisting++ : added++);
        for (const print of before) if (!after.has(print)) resolved++;
      } else {
        added += module.findings.length;
      }
      states.set(module.key, {
        key: module.key,
        label: module.label,
        miscellaneous: module.miscellaneous,
        score: module.score,
        status: module.status,
        counts: module.counts,
        coverage: module.coverage,
        date: run.meta.date,
        run: run.folder,
        findings: module.findings,
      });
    }
    entries.push({
      folder: run.folder,
      meta: run.meta,
      appScore: appScore(states.values()),
      modules: done,
      failedModules: failed,
      new: added,
      resolved,
      persisting,
    });
  }

  const all = [...states.values()];
  const modules = all.filter((state) => !state.miscellaneous).sort((left, right) => left.label.localeCompare(right.label));
  const miscellaneous = all.find((state) => state.miscellaneous) ?? null;
  const totals = { ...EMPTY_COUNTS(), modules: modules.length };
  for (const state of modules) for (const key of Object.keys(state.counts) as (keyof ModuleSummary["counts"])[]) totals[key] += state.counts[key];
  const covered = modules.filter((state) => state.coverage !== null);
  const lastRun = entries.at(-1) ?? null;
  const stale = !lastRun || now.getTime() - Date.parse(lastRun.meta.date) > STALE_DAYS * 86_400_000;
  const scores = entries.map((entry) => entry.appScore).filter((score): score is number => score !== null);
  return {
    id: app.id,
    name: app.name,
    market: app.market,
    status: stale ? "grey" : worstStatus(modules.map((state) => state.status)),
    score: appScore(modules),
    previousScore: scores.length > 1 ? scores[scores.length - 2] : null,
    stale,
    lastRun,
    modules,
    miscellaneous,
    totals,
    coverage: covered.length ? round(covered.reduce((sum, state) => sum + (state.coverage ?? 0), 0) / covered.length, 3) : null,
    runs: entries,
  };
}

export function buildIndex(reportsDir: string, now = new Date()): DashboardIndex {
  const apps = loadApps(reportsDir).map((app) => buildAppIndex(reportsDir, app, now));
  const byModule = new Map<string, { key: string; label: string; apps: { id: string; high: number; highConfirmed: number }[] }>();
  for (const app of apps) {
    for (const state of app.modules) {
      if (state.counts.high === 0) continue;
      const entry = byModule.get(state.key) ?? { key: state.key, label: state.label, apps: [] };
      entry.apps.push({ id: app.id, high: state.counts.high, highConfirmed: state.counts.highConfirmed });
      byModule.set(state.key, entry);
    }
  }
  const hotspots = [...byModule.values()]
    .filter((entry) => entry.apps.length >= 2)
    .sort((left, right) => right.apps.length - left.apps.length || left.label.localeCompare(right.label));
  return { version: 1, generatedAt: now.toISOString(), apps, hotspots };
}

// ------------------------------------------------------------------ Markdown

const STATUS_ICON: Record<Status, string> = { red: "🔴", amber: "🟠", green: "🟢", grey: "⚪" };
const STATUS_WORD: Record<Status, string> = { red: "At risk", amber: "Watch", green: "Healthy", grey: "Incomplete / stale" };

function cell(value: unknown): string {
  return String(value ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function day(iso?: string): string {
  return iso ? iso.slice(0, 10) : "—";
}

function delta(app: AppIndex): string {
  if (app.score === null) return "—";
  if (app.previousScore === null) return `${app.score}`;
  const change = round(app.score - app.previousScore);
  return `${app.score} (${change > 0 ? "▲" : change < 0 ? "▼" : "="}${change === 0 ? "" : Math.abs(change)})`;
}

function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function scopeText(meta: RunMeta): string {
  return meta.scope === "project" ? "whole project" : `modules: ${(meta.modules ?? []).join(", ") || "—"}`;
}

/** The HTML report first (what people open), the Markdown beside it. */
export function reportLinks(folderPath: string): string {
  const base = encodeURI(folderPath);
  return `[HTML](${base}/parity-report.html) · [md](${base}/parity-report.md)`;
}

function reportLink(app: AppIndex, run: RunEntry | null, base: string): string {
  return run ? reportLinks(`${base}${run.folder}`) : "—";
}

function jiraLink(meta?: RunMeta): string {
  if (!meta?.jiraKey) return "—";
  return meta.jiraUrl ? `[${meta.jiraKey}](${meta.jiraUrl})` : meta.jiraKey;
}

const LEGEND = [
  "**Status:** 🔴 At risk (a confirmed High finding, or score < 60) · 🟠 Watch (an unconfirmed High, or score < 80) · 🟢 Healthy · ⚪ Incomplete (a section could not be produced, under 80% of matching files read, or no audit in 14 days).",
  "",
  "**Score:** 100 minus the weight of every open finding — High 10, Medium 4, Low 1, multiplied by confidence (Confirmed ×1, Runtime verification ×0.6, Potential ×0.5, Requirements gap ×0.3), plus 0.25 per hard-coded string (at most 5 per module). An app's score is the mean of its modules' latest scores; Miscellaneous is reported separately.",
].join("\n");

export function renderReadme(index: DashboardIndex): string {
  const lines = [
    "# Mirror AI — Android/iOS parity dashboard",
    "",
    `_Generated ${index.generatedAt.replace("T", " ").slice(0, 16)} UTC from every report under this folder. Open [dashboard.html](dashboard.html) for charts._`,
    "",
    LEGEND,
    "",
    "## All apps",
    "",
    "| App | Status | Score (Δ) | Last audit | Scope | Modules | High (confirmed) | Medium | Low | API drift | Hard-coded copy | Miscellaneous | Coverage | Report | Jira |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const app of index.apps) {
    const run = app.lastRun;
    const misc = app.miscellaneous ? `${app.miscellaneous.findings.length} finding(s), ${STATUS_ICON[app.miscellaneous.status]}` : "—";
    lines.push(
      `| ${app.runs.length ? `[${cell(app.name)}](${app.id}/README.md)` : cell(app.name)} | ${STATUS_ICON[app.status]} ${STATUS_WORD[app.status]} | ${delta(app)} | ${day(run?.meta.date)}${run?.meta.branch ? ` · \`${cell(run.meta.branch)}\`` : ""} | ${run ? cell(scopeText(run.meta)) : "—"} | ${app.totals.modules} | ${app.totals.high} (${app.totals.highConfirmed}) | ${app.totals.medium} | ${app.totals.low} | ${app.totals.apiDrift} | ${app.totals.hardcodedCopy} | ${misc} | ${pct(app.coverage)} | ${reportLink(app, run, `${app.id}/`)} | ${jiraLink(run?.meta)} |`,
    );
  }
  lines.push("", "## Cross-app hotspots", "");
  if (index.hotspots.length === 0) {
    lines.push("No module has High findings in more than one app.");
  } else {
    lines.push("Modules with High findings in two or more apps — often shared code worth fixing once.", "", "| Module | Apps (High / confirmed) |", "|---|---|");
    for (const spot of index.hotspots) {
      lines.push(`| ${cell(spot.label)} | ${spot.apps.map((entry) => `${entry.id} ${entry.high}/${entry.highConfirmed}`).join(", ")} |`);
    }
  }
  lines.push("", "## Apps", "", ...index.apps.map((app) => (app.runs.length ? `- [${app.name}](${app.id}/README.md) — ${app.runs.length} run(s)` : `- ${app.name} — no runs yet`)), "");
  return lines.join("\n");
}

export function renderAppReadme(app: AppIndex): string {
  const lines = [
    `# ${app.name} — Mirror AI parity`,
    "",
    `[← All apps](../README.md) · Status ${STATUS_ICON[app.status]} ${STATUS_WORD[app.status]} · Score ${delta(app)} · ${app.totals.modules} module(s) · coverage ${pct(app.coverage)}${app.stale ? ` · **no audit in ${STALE_DAYS} days**` : ""}`,
    "",
    "## Modules",
    "",
    "| Module | Status | Score | Business logic (H/M/L) | UI divergent | API drift | Hard-coded copy | Coverage | Last audited | Report |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const state of app.modules) {
    const failed = state.lastFailedAt ? ` (later run failed ${day(state.lastFailedAt)})` : "";
    lines.push(
      `| ${cell(state.label)} | ${STATUS_ICON[state.status]} | ${state.score} | ${state.counts.high}/${state.counts.medium}/${state.counts.low} | ${state.counts.uiDivergent} | ${state.counts.apiDrift} | ${state.counts.hardcodedCopy} | ${pct(state.coverage)} | ${day(state.date)}${failed} | ${reportLinks(state.run)} |`,
    );
  }

  const high = app.modules
    .flatMap((state) => state.findings.filter((item) => item.severity === "High").map((item) => ({ state, item })))
    .sort((left, right) => right.item.weight - left.item.weight)
    .slice(0, 15);
  lines.push("", "## Open High findings", "");
  if (high.length === 0) lines.push("None.");
  else {
    lines.push("| Module | ID | Area | Confidence | Files | Report |", "|---|---|---|---|---|---|");
    for (const { state, item } of high) {
      lines.push(`| ${cell(state.label)} | ${cell(item.id)} | ${cell(item.area)} | ${item.confidence} | ${cell(item.files.slice(0, 3).map((file) => `\`${file}\``).join(", "))} | ${reportLinks(state.run)} |`);
    }
  }

  lines.push("", "## Miscellaneous", "");
  if (!app.miscellaneous) lines.push("No whole-project audit yet: Miscellaneous covers code that no common module claims.");
  else {
    const misc = app.miscellaneous;
    lines.push(`${STATUS_ICON[misc.status]} score ${misc.score} · High ${misc.counts.high} (${misc.counts.highConfirmed} confirmed) · Medium ${misc.counts.medium} · Low ${misc.counts.low} · API drift ${misc.counts.apiDrift} · audited ${day(misc.date)} · ${reportLinks(misc.run)}`);
  }

  lines.push("", "## Run history", "", "| Date | Scope | Branch | App score | New | Resolved | Persisting | Failed modules | Report | PR | Jira |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const run of [...app.runs].reverse()) {
    lines.push(
      `| ${run.meta.date.replace("T", " ").slice(0, 16)} | ${cell(scopeText(run.meta))} | ${run.meta.branch ? `\`${cell(run.meta.branch)}\`` : "—"} | ${run.appScore ?? "—"} | ${run.new} | ${run.resolved} | ${run.persisting} | ${run.failedModules.length ? cell(run.failedModules.join(", ")) : "—"} | ${reportLinks(run.folder)} | ${run.meta.prUrl ? `[PR](${run.meta.prUrl})` : "—"} | ${jiraLink(run.meta)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------- HTML

export function renderDashboardHtml(index: DashboardIndex): string {
  // Only what the page draws: drop finding lists except High ones to keep the file small.
  const slim = {
    ...index,
    apps: index.apps.map((app) => ({
      ...app,
      modules: app.modules.map((state) => ({ ...state, findings: state.findings.filter((item) => item.severity === "High") })),
      miscellaneous: app.miscellaneous ? { ...app.miscellaneous, findings: app.miscellaneous.findings.filter((item) => item.severity === "High") } : null,
    })),
  };
  const data = JSON.stringify(slim).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mirror AI Parity Dashboard</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e3e2dd;--red:#c8372d;--amber:#d98a00;--green:#2e8b57;--grey:#9a9a94;--accent:#3b5bdb}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--panel:#1f1f1d;--ink:#ecebe6;--muted:#a3a29c;--line:#34332f;--red:#ef6a5f;--amber:#f0b03a;--green:#55b98a;--grey:#7c7b75;--accent:#8ea2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1240px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.muted{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;cursor:pointer}.card.sel{outline:2px solid var(--accent)}
.card h3{margin:0;font-size:15px;display:flex;justify-content:space-between;gap:8px}.card h3 .muted{white-space:nowrap;font-weight:400;font-size:12px}.score{font-size:30px;font-weight:650;margin:6px 0 2px;font-variant-numeric:tabular-nums}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.red{background:var(--red)}.amber{background:var(--amber)}.green{background:var(--green)}.grey{background:var(--grey)}
.kv{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--muted);font-size:12px;margin-top:6px}.kv b{color:var(--ink);font-weight:600}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--panel)}td.wrap{white-space:normal;min-width:240px}
.heat td.c{text-align:center;font-variant-numeric:tabular-nums;color:#fff;font-weight:600;border-left:2px solid var(--panel)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}select{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px 8px}
svg text{fill:var(--muted);font-size:11px}.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--muted);margin:8px 0}
</style>
</head>
<body>
<main>
<h1>Mirror AI — Android/iOS parity</h1>
<div class="muted" id="gen"></div>
<div class="legend"><span><span class="dot red"></span>At risk</span><span><span class="dot amber"></span>Watch</span><span><span class="dot green"></span>Healthy</span><span><span class="dot grey"></span>Incomplete / stale</span><span>Score = 100 − weighted open findings</span></div>
<h2>Apps</h2><div class="cards" id="cards"></div>
<h2>Score trend</h2><div class="panel"><svg id="trend" width="100%" height="240" role="img" aria-label="App score over runs"></svg></div>
<h2>Modules × apps</h2><div class="panel"><table class="heat" id="heat"></table></div>
<h2>High findings</h2><div class="panel"><div class="filters"><select id="fApp"></select><select id="fConf"><option value="">All confidence</option><option>Confirmed</option><option>Runtime</option><option>Potential</option><option>Requirements gap</option></select></div><table id="findings"></table></div>
<h2>Run history</h2><div class="panel"><table id="runs"></table></div>
</main>
<script>
const D=${data};
const COL={red:'var(--red)',amber:'var(--amber)',green:'var(--green)',grey:'var(--grey)'};
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let sel=null;
document.getElementById('gen').textContent='Generated '+D.generatedAt.replace('T',' ').slice(0,16)+' UTC · '+D.apps.length+' app(s)';
function cards(){document.getElementById('cards').innerHTML=D.apps.map(a=>{const r=a.lastRun;const d=a.score!=null&&a.previousScore!=null?Math.round((a.score-a.previousScore)*10)/10:null;
return '<div class="card'+(sel===a.id?' sel':'')+'" data-id="'+esc(a.id)+'"><h3><span><span class="dot '+a.status+'"></span>'+esc(a.name)+'</span><span class="muted">'+(r?esc(r.meta.date.slice(0,10)):'no runs')+'</span></h3>'+
'<div class="score">'+(a.score??'—')+(d!=null&&d!==0?' <span style="font-size:14px;color:'+(d>0?'var(--green)':'var(--red)')+'">'+(d>0?'▲':'▼')+Math.abs(d)+'</span>':'')+'</div>'+
'<div class="kv"><span>High <b>'+a.totals.high+'</b> ('+a.totals.highConfirmed+' conf.)</span><span>Med <b>'+a.totals.medium+'</b></span><span>Low <b>'+a.totals.low+'</b></span><span>API drift <b>'+a.totals.apiDrift+'</b></span><span>Modules <b>'+a.totals.modules+'</b></span><span>Coverage <b>'+(a.coverage==null?'—':Math.round(a.coverage*100)+'%')+'</b></span><span>Misc <b>'+(a.miscellaneous?a.miscellaneous.findings.length+' High':'—')+'</b></span></div></div>'}).join('');
document.querySelectorAll('.card').forEach(c=>c.onclick=()=>{sel=sel===c.dataset.id?null:c.dataset.id;render()})}
function trend(){const svg=document.getElementById('trend');const W=svg.clientWidth||900,H=240,P=34;const pts=D.apps.flatMap(a=>a.runs.filter(r=>r.appScore!=null).map(r=>Date.parse(r.meta.date)));
if(!pts.length){svg.innerHTML='<text x="12" y="24">No runs yet</text>';return}const t0=Math.min(...pts),t1=Math.max(...pts)||t0+1;const x=t=>P+(W-2*P)*((t-t0)/((t1-t0)||1)),y=s=>H-P-(H-2*P)*s/100;
const pal=['#3b5bdb','#c8372d','#2e8b57','#d98a00','#7048e8','#0c8599'];let g='';for(const s of [0,50,80,100])g+='<line x1="'+P+'" x2="'+(W-P)+'" y1="'+y(s)+'" y2="'+y(s)+'" stroke="var(--line)"/><text x="4" y="'+(y(s)+4)+'">'+s+'</text>';
D.apps.forEach((a,i)=>{if(sel&&sel!==a.id)return;const rs=a.runs.filter(r=>r.appScore!=null);if(!rs.length)return;const c=pal[i%pal.length];
g+='<polyline fill="none" stroke="'+c+'" stroke-width="2" points="'+rs.map(r=>x(Date.parse(r.meta.date))+','+y(r.appScore)).join(' ')+'"/>';
rs.forEach(r=>g+='<circle cx="'+x(Date.parse(r.meta.date))+'" cy="'+y(r.appScore)+'" r="3" fill="'+c+'"><title>'+esc(a.name)+' '+r.meta.date.slice(0,10)+': '+r.appScore+'</title></circle>');
const l=rs[rs.length-1];g+='<text x="'+x(Date.parse(l.meta.date))+'" y="'+(y(l.appScore)-8)+'" text-anchor="end" style="fill:'+c+'">'+esc(a.name)+'</text>'});svg.innerHTML=g}
function heat(){const apps=D.apps.filter(a=>!sel||a.id===sel);const keys=[...new Map(apps.flatMap(a=>a.modules.map(m=>[m.key,m.label]))).entries()].sort((p,q)=>p[1].localeCompare(q[1]));
let h='<tr><th>Module</th>'+apps.map(a=>'<th>'+esc(a.name)+'</th>').join('')+'</tr>';for(const [k,l] of keys){h+='<tr><td>'+esc(l)+'</td>'+apps.map(a=>{const m=a.modules.find(x=>x.key===k);
return m?'<td class="c" style="background:'+COL[m.status]+'" title="'+esc(m.label+': High '+m.counts.high+', Medium '+m.counts.medium+', Low '+m.counts.low+', audited '+m.date.slice(0,10))+'">'+m.score+'</td>':'<td class="c muted" style="color:var(--muted)">—</td>'}).join('')+'</tr>'}
document.getElementById('heat').innerHTML=keys.length?h:'<tr><td>No modules audited yet</td></tr>'}
function findings(){const fa=document.getElementById('fApp');if(!fa.options.length)fa.innerHTML='<option value="">All apps</option>'+D.apps.map(a=>'<option value="'+esc(a.id)+'">'+esc(a.name)+'</option>').join('');
const app=sel||fa.value,conf=document.getElementById('fConf').value;const rows=D.apps.filter(a=>!app||a.id===app).flatMap(a=>[...a.modules,...(a.miscellaneous?[a.miscellaneous]:[])].flatMap(m=>m.findings.filter(f=>!conf||f.confidence===conf).map(f=>({a,m,f}))));
rows.sort((p,q)=>q.f.weight-p.f.weight);document.getElementById('findings').innerHTML='<tr><th>App</th><th>Module</th><th>ID</th><th>Area</th><th>Confidence</th><th>Files</th><th>Report</th></tr>'+(rows.length?rows.map(({a,m,f})=>'<tr><td>'+esc(a.name)+'</td><td>'+esc(m.label)+'</td><td>'+esc(f.id)+'</td><td class="wrap">'+esc(f.area)+'</td><td>'+esc(f.confidence)+'</td><td class="wrap">'+esc(f.files.slice(0,3).join(', '))+'</td><td><a href="'+encodeURI(a.id+'/'+m.run+'/parity-report.html')+'">open</a></td></tr>').join(''):'<tr><td colspan="7">No High findings</td></tr>')}
function runs(){const rows=D.apps.filter(a=>!sel||a.id===sel).flatMap(a=>a.runs.map(r=>({a,r}))).sort((p,q)=>q.r.meta.date.localeCompare(p.r.meta.date));
document.getElementById('runs').innerHTML='<tr><th>Date</th><th>App</th><th>Scope</th><th>Branch</th><th>Score</th><th>New</th><th>Resolved</th><th>Persisting</th><th>Failed</th><th>Links</th></tr>'+rows.map(({a,r})=>'<tr><td>'+esc(r.meta.date.replace('T',' ').slice(0,16))+'</td><td>'+esc(a.name)+'</td><td>'+esc(r.meta.scope==='project'?'whole project':(r.meta.modules||[]).join(', '))+'</td><td>'+esc(r.meta.branch||'—')+'</td><td>'+(r.appScore??'—')+'</td><td>'+r.new+'</td><td>'+r.resolved+'</td><td>'+r.persisting+'</td><td>'+esc(r.failedModules.join(', ')||'—')+'</td><td><a href="'+encodeURI(a.id+'/'+r.folder+'/parity-report.html')+'">report</a>'+(r.meta.prUrl?' · <a href="'+esc(r.meta.prUrl)+'">PR</a>':'')+(r.meta.jiraUrl?' · <a href="'+esc(r.meta.jiraUrl)+'">'+esc(r.meta.jiraKey)+'</a>':'')+'</td></tr>').join('')}
function render(){cards();trend();heat();findings();runs()}
document.getElementById('fApp').onchange=findings;document.getElementById('fConf').onchange=findings;window.onresize=trend;render();
</script>
</body>
</html>
`;
}

// ----------------------------------------------------------------------- CLI

export function writeDashboard(reportsDir: string, options: { app?: string; appOnly?: boolean; now?: Date } = {}): DashboardIndex {
  const index = buildIndex(reportsDir, options.now);
  for (const app of index.apps) {
    if (options.app && app.id !== options.app) continue;
    if (existsSync(path.join(reportsDir, app.id))) writeFileSync(path.join(reportsDir, app.id, "README.md"), renderAppReadme(app));
  }
  if (!options.appOnly) {
    writeFileSync(path.join(reportsDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    writeFileSync(path.join(reportsDir, "README.md"), renderReadme(index));
    writeFileSync(path.join(reportsDir, "dashboard.html"), renderDashboardHtml(index));
  }
  return index;
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function main(argv: string[]): number {
  const dir = argv.find((arg, at) => !arg.startsWith("--") && !argv[at - 1]?.startsWith("--app"));
  if (!dir || !existsSync(dir)) {
    console.error("Usage: npm run dashboard -- <reports-dir> [--app <id>] [--app-only]");
    return 1;
  }
  const index = writeDashboard(path.resolve(dir), { app: flag(argv, "--app"), appOnly: argv.includes("--app-only") });
  for (const app of index.apps) {
    console.error(`${app.id}: ${STATUS_ICON[app.status]} score ${app.score ?? "—"}, ${app.runs.length} run(s), ${app.totals.modules} module(s)`);
  }
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exit(main(process.argv.slice(2)));
