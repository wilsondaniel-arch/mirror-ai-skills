/**
 * Renders a Mirror AI parity-report.md in the "executive" report UI: one tile
 * per module, and per module the tabs Business Logic, UI Differences,
 * Hard-coded Strings and API Contract, each with stat cards and collapsible
 * Android/iOS diff cards. Also writes a Markdown twin laid out the same way.
 *
 *   node --experimental-strip-types src/report-ui.ts <run-dir|parity-report.md> [--out report.html] [--md report.md] [--pdf report.pdf] [--title "..."]
 *
 * Styles come from public/report-ui.css. Every value from the report is
 * escaped; only inline code and bold are turned back into markup.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { markdownToHtml } from "./markdown-html.ts";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

type Table = { head: string[]; rows: string[][] };
type Block = { kind: "table"; table: Table } | { kind: "text"; text: string } | { kind: "heading"; level: number; text: string };
type Section = { title: string; blocks: Block[] };
export type Module = { name: string; key: string; intro: Block[]; sections: Section[] };
export type RunMeta = { branch?: string; android?: string; ios?: string; market?: string; date?: string };

const BARE_PATH_RE =
  /(?<![\w`/])(?:[\w@.+\-]+\/)+[\w@.+\-]+\.(?:kt|kts|java|swift|xml|json|plist|xcconfig|gradle|m|h|strings)(?::\d+(?:[-–]\d+)?(?:,\s?\d+(?:[-–]\d+)?)*)?(?![\w/])/g;
const PATH_RE =/^[\w@.+\-/]*\.(?:kt|kts|java|swift|xml|json|plist|xcconfig|gradle|m|h|strings)(?::[\d,\s–\-]+)?$/i;

// ─────────────────────────── parsing ───────────────────────────

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "text", text: para.join("\n").trim() });
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(t);
    if (h) {
      flush();
      blocks.push({ kind: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (t.startsWith("|") && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      flush();
      const head = cells(t);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++].trim()));
      blocks.push({ kind: "table", table: { head, rows } });
      continue;
    }
    if (!t || /^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flush();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return blocks;
}

function cells(row: string): string[] {
  const inner = row.replace(/^\|/, "").replace(/\|\s*$/, "");
  const out: string[] = [];
  let cur = "";
  let tick = false;
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k];
    if (c === "\\" && inner[k + 1] === "|") {
      cur += "|";
      k++;
      continue;
    }
    if (c === "`") tick = !tick;
    if (c === "|" && !tick) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40) || "module";

/** Splits a report into modules (H1 or H2 "Business logic audit — X" headings) and their H3 sections. */
export function parseReport(markdown: string): { preamble: Block[]; modules: Module[] } {
  const blocks = parseBlocks(markdown);
  const isModuleHead = (b: Block) =>
    b.kind === "heading" && (b.level === 1 || (b.level === 2 && /audit\s*[—–-]/i.test(b.text)));
  const hasModuleHeads = blocks.some(isModuleHead);
  const preamble: Block[] = [];
  const modules: Module[] = [];
  let mod: Module | null = null;
  let sec: Section | null = null;
  const used = new Set<string>();
  for (const b of blocks) {
    if (hasModuleHeads && isModuleHead(b)) {
      const raw = (b as { text: string }).text;
      const name = raw.replace(/^.*?audit\s*[—–-]\s*/i, "").replace(/^Mirror AI.*?[—–-]\s*/i, "").trim() || raw;
      let key = slug(name);
      while (used.has(key)) key += "x";
      used.add(key);
      mod = { name, key, intro: [], sections: [] };
      modules.push(mod);
      sec = null;
      continue;
    }
    if (!mod) {
      if (!hasModuleHeads && b.kind === "heading" && b.level === 3) {
        mod = { name: "Report", key: "report", intro: [], sections: [] };
        modules.push(mod);
      } else {
        preamble.push(b);
        continue;
      }
    }
    if (b.kind === "heading" && b.level <= 3) {
      sec = { title: b.text.replace(/^\d+\.\s*/, ""), blocks: [] };
      mod.sections.push(sec);
      continue;
    }
    (sec ? sec.blocks : mod.intro).push(b);
  }
  return { preamble, modules };
}

function classify(title: string): "bl" | "ui" | "hc" | "api" | "summary" | "other" {
  if (/business logic/i.test(title)) return "bl";
  if (/ui difference/i.test(title)) return "ui";
  if (/hard-?coded/i.test(title)) return "hc";
  if (/api contract/i.test(title)) return "api";
  if (/executive summary/i.test(title)) return "summary";
  return "other";
}

const col = (t: Table, ...names: RegExp[]) => t.head.findIndex((h) => names.some((n) => n.test(h)));

// ─────────────────────────── inline helpers ───────────────────────────

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function inline(text: string): string {
  const parts = String(text ?? "").split(/(`[^`]*`)/);
  return parts
    .map((p) => {
      if (/^`[^`]*`$/.test(p)) return `<code translate="no">${esc(p.slice(1, -1))}</code>`;
      return esc(p)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g, "$1<em>$2</em>")
        .replace(/&lt;br\s*\/?&gt;/gi, "<br>");
    })
    .join("");
}

/** Pulls `path/File.kt:12-30` citations out of prose so they render as path chips. */
export function splitCitations(text: string): { prose: string; paths: string[] } {
  const paths: string[] = [];
  let prose = String(text ?? "").replace(/`([^`]+)`/g, (m, inner: string) => {
    if (PATH_RE.test(inner.trim())) {
      paths.push(inner.trim());
      return "\u0000";
    }
    return m;
  });
  // Bare citations (no backticks): dir/File.kt:21-26,36-38. Skip text inside inline code.
  prose = prose
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith("`")
        ? part
        : part.replace(BARE_PATH_RE, (p: string) => {
            paths.push(p);
            return "\u0000";
          }),
    )
    .join("");
  prose = prose
    .replace(/\u0000(?:\s*(?:,|;|and|·|\+)\s*\u0000)+/g, "\u0000")
    .replace(/\(\s*(?:\u0000[\s,;and]*)+\)/g, "")
    .replace(/:\s*(?:\u0000[\s,;and]*)+$/g, "")
    .replace(/\b(is|are)\s+(?:(?:at|in)\s+)?\u0000/g, "$1 cited below")
    .replace(/(?:at|in)\s+\u0000/g, "")
    .replace(/[\s,;]*\u0000[\s,;]*/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { prose, paths: [...new Set(paths)] };
}

const plain = (s: string) => String(s ?? "").replace(/\*\*/g, "").replace(/`/g, "").trim();

// ─────────────────────────── model ───────────────────────────

type BlRow = { id: string; area: string; android: string; ios: string; impact: string; severity: string; confidence: string; merged?: boolean };
type HcRow = { id: string; screen: string; el: string; type: string; platform: string; text: string; file: string };
type UiPair = { id: string; screen: string; pairing: string; androidN: string; iosN: string; matched: string; divergent: string; largest: string; slots: Table | null };

type ModuleView = {
  mod: Module;
  bl: { rows: BlRow[]; notes: Block[] } | null;
  ui: { platforms: Table | null; pairs: UiPair[]; notes: Block[] } | null;
  hc: { rows: HcRow[]; intro: string } | null;
  api: { blocks: Block[] } | null;
  summary: Block[];
  other: Section[];
};

function buildView(mod: Module): ModuleView {
  const view: ModuleView = { mod, bl: null, ui: null, hc: null, api: null, summary: [], other: [] };
  for (const sec of mod.sections) {
    const kind = classify(sec.title);
    if (kind === "bl") view.bl = parseBl(sec.blocks);
    else if (kind === "ui") view.ui = parseUi(sec.blocks);
    else if (kind === "hc") view.hc = parseHc(sec.blocks);
    else if (kind === "api") view.api = { blocks: sec.blocks };
    else if (kind === "summary") view.summary.push(...sec.blocks);
    else view.other.push(sec);
  }
  if (mod.intro.length) view.summary.unshift(...mod.intro);
  return view;
}

function parseBl(blocks: Block[]): { rows: BlRow[]; notes: Block[] } {
  const rows: BlRow[] = [];
  const notes: Block[] = [];
  for (const b of blocks) {
    if (b.kind === "table" && col(b.table, /^id$/i) >= 0 && col(b.table, /severity/i) >= 0) {
      const t = b.table;
      const ix = {
        id: col(t, /^id$/i),
        area: col(t, /area|title/i),
        android: col(t, /android/i),
        ios: col(t, /ios/i),
        impact: col(t, /impact/i),
        severity: col(t, /severity/i),
        confidence: col(t, /confidence/i),
      };
      for (const r of t.rows) {
        if (!r[ix.id]) continue;
        if (r.length < t.head.length && ix.severity === t.head.length - 2 && ix.confidence === t.head.length - 1) {
          // A row with a missing cell (usually Android and iOS behaviour written in one cell).
          // Severity, confidence and impact are always the last three cells, so read those from the right.
          const n = r.length;
          const middle = r.slice(2, Math.max(2, n - 3));
          rows.push({
            id: plain(r[0]),
            area: r[1] ?? "",
            android: middle[0] ?? "",
            ios: middle.slice(1).join(" "),
            impact: r[n - 3] ?? "",
            severity: plain(r[n - 2] ?? ""),
            confidence: plain(r[n - 1] ?? ""),
            merged: middle.length < 2,
          });
          continue;
        }
        rows.push({
          id: plain(r[ix.id]),
          area: r[ix.area] ?? "",
          android: r[ix.android] ?? "",
          ios: r[ix.ios] ?? "",
          impact: r[ix.impact] ?? "",
          severity: plain(r[ix.severity] ?? ""),
          confidence: plain(r[ix.confidence] ?? ""),
        });
      }
    } else notes.push(b);
  }
  return { rows, notes };
}

function parseUi(blocks: Block[]): { platforms: Table | null; pairs: UiPair[]; notes: Block[] } {
  let platforms: Table | null = null;
  const pairs: UiPair[] = [];
  const notes: Block[] = [];
  let pendingSlotsFor: string | null = null;
  let pendingTitle = "";
  for (const b of blocks) {
    if (b.kind === "table" && col(b.table, /^platform$/i) === 0 && col(b.table, /element/i) >= 0) {
      platforms = b.table;
      continue;
    }
    if (b.kind === "table" && col(b.table, /^id$/i) >= 0 && col(b.table, /largest|difference/i) >= 0) {
      const t = b.table;
      const g = (r: string[], re: RegExp) => r[col(t, re)] ?? "";
      for (const r of t.rows)
        pairs.push({
          id: plain(g(r, /^id$/i)),
          screen: g(r, /^screen$/i),
          pairing: plain(g(r, /pairing/i)),
          androidN: plain(g(r, /android/i)),
          iosN: plain(g(r, /ios/i)),
          matched: plain(g(r, /matched/i)),
          divergent: plain(g(r, /divergent/i)),
          largest: g(r, /largest|difference/i),
          slots: null,
        });
      continue;
    }
    if (b.kind === "text") {
      const m = /^\*\*(UI-\d+)\b\s*[—–:-]?\s*(.*?)\*\*$/.exec(b.text.trim());
      if (m) {
        pendingSlotsFor = m[1];
        pendingTitle = m[2];
        continue;
      }
    }
    if (b.kind === "heading") {
      const m = /(UI-\d+)\b\s*[—–:-]?\s*(.*)$/.exec(b.text.replace(/^Layout\s*[—–:-]?\s*/i, ""));
      if (m) {
        pendingSlotsFor = m[1];
        pendingTitle = m[2];
        continue;
      }
    }
    if (b.kind === "table" && pendingSlotsFor && col(b.table, /^slot$/i) >= 0) {
      let p = pairs.find((x) => x.id === pendingSlotsFor);
      if (!p) {
        // A layout block with no summary row: build the pair from its heading and slot states.
        const si = col(b.table, /state/i);
        const div = si >= 0 ? b.table.rows.filter((r) => !/^same$/i.test(plain(r[si] ?? ""))).length : 0;
        p = { id: pendingSlotsFor, screen: pendingTitle || pendingSlotsFor, pairing: "Paired", androidN: "", iosN: "", matched: String(b.table.rows.length - div), divergent: String(div), largest: "", slots: null };
        pairs.push(p);
      }
      p.slots = b.table;
      pendingSlotsFor = null;
      continue;
    }
    notes.push(b);
  }
  return { platforms, pairs, notes };
}

function parseHc(blocks: Block[]): { rows: HcRow[]; intro: string } {
  const rows: HcRow[] = [];
  let intro = "";
  for (const b of blocks) {
    if (b.kind === "text" && !intro) intro = b.text;
    if (b.kind !== "table" || col(b.table, /^id$/i) < 0) continue;
    const t = b.table;
    const g = (r: string[], re: RegExp) => (col(t, re) >= 0 ? r[col(t, re)] ?? "" : "");
    for (const r of t.rows) {
      const on = plain(g(r, /hard-?coded on|platform/i)).toLowerCase();
      const a = plain(g(r, /android/i));
      const i = plain(g(r, /ios/i));
      const platform = /both/.test(on) ? "both" : /android/.test(on) ? "android" : "ios";
      const text = platform === "android" ? a : platform === "ios" ? i : `${a}${a && i && a !== i ? " / " + i : ""}`;
      rows.push({
        id: plain(g(r, /^id$/i)),
        screen: plain(g(r, /^screen$/i)),
        el: plain(g(r, /element/i)),
        type: plain(g(r, /^type$/i)).toLowerCase() || "text",
        platform,
        text: text === "—" ? "" : text,
        file: plain(g(r, /citation|file/i)).split("/").pop() ?? "",
      });
    }
  }
  return { rows, intro };
}

// ─────────────────────────── HTML pieces ───────────────────────────

const stat = (label: string, value: string | number, sub: string, tone = "") =>
  `<div class="stat-card"><div class="stat-label">${esc(label)}</div><div class="stat-value ${tone}">${esc(value)}</div><div class="stat-sub">${esc(sub)}</div></div>`;
const statBar = (cards: string[]) => `<div class="stat-bar">${cards.join("")}</div>`;
const secHead = (title: string) => `<div class="sec-head"><h2 class="sec-title">${esc(title)}</h2><div class="sec-rule"></div></div>`;
const notice = (html: string, icon = "ℹ") => `<div class="notice"><span class="notice-icon">${icon}</span><div>${html}</div></div>`;

function card(id: string, head: string, badges: string, body: string, open: boolean): string {
  const k = `if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleCard('${id}')}`;
  return `<div class="diff-card${open ? " open" : ""}" id="${id}"><div class="diff-card-head" role="button" tabindex="0" aria-expanded="${open}" onclick="toggleCard('${id}')" onkeydown="${k}">${head}<div class="badge-row">${badges}<span class="chevron">▶</span></div></div><div class="diff-body">${body}</div></div>`;
}
const cardHead = (idText: string, title: string) =>
  `<div class="diff-id-row"><span class="diff-id">${esc(idText)}</span><span class="diff-title">${inline(title)}</span></div>`;

function pane(label: string, cls: "android" | "ios", text: string): string {
  const { prose, paths } = splitCitations(text);
  const body =
    (prose && !/^see (android|ios) cell\.?$/i.test(prose) ? inline(prose) : "") +
    (prose && paths.length ? "<br>" : "") +
    paths.map((p) => `<span class="path" translate="no">${esc(p)}</span>`).join("");
  const none = !prose || /^(—|-|n\/a|none)$/i.test(prose.trim());
  return `<div class="split-pane"><div class="split-label ${cls}"><span class="platform-dot"></span>${esc(label)}</div><div class="split-code prose">${
    none && !paths.length ? `<span class="none-label">⚠ No ${cls === "android" ? "Android" : "iOS"} counterpart in the audited source.</span>` : body
  }</div></div>`;
}

function proseHtml(blocks: Block[]): string {
  if (!blocks.length) return "";
  const md = blocks
    .map((b) =>
      b.kind === "text"
        ? b.text
        : b.kind === "heading"
          ? `${"#".repeat(Math.max(3, b.level))} ${b.text}`
          : [`| ${b.table.head.join(" | ")} |`, `|${b.table.head.map(() => "---").join("|")}|`, ...b.table.rows.map((r) => `| ${r.join(" | ")} |`)].join("\n"),
    )
    .join("\n\n");
  return `<div class="md-prose">${markdownToHtml(md).replace(/class="table-wrap"/g, 'class="api-table-wrap"')}</div>`;
}

function textNotices(blocks: Block[]): string {
  const rest: Block[] = [];
  let out = "";
  for (const b of blocks) {
    if (b.kind === "text" && !/^\s*[|#]/.test(b.text)) {
      const t = b.text.replace(/^>\s?/gm, "").trim();
      out += notice(inline(t).replace(/\n/g, "<br>"), /not|unverified|could not|absence|missing/i.test(t) ? "⚠" : "ℹ");
    } else rest.push(b);
  }
  return out + proseHtml(rest);
}

const sevClass = (s: string) => (/high/i.test(s) ? "badge-high" : /medium/i.test(s) ? "badge-medium" : /low/i.test(s) ? "badge-low" : "badge-potential");
const confClass = (s: string) => (/^confirmed/i.test(s) ? "badge-confirmed" : "badge-potential");

function idRange(ids: string[]): string {
  if (!ids.length) return "None found";
  if (ids.length <= 3) return ids.join(", ");
  return `${ids[0]} to ${ids[ids.length - 1]}`;
}

function blSection(v: ModuleView): string {
  const rows = v.bl?.rows ?? [];
  const high = rows.filter((r) => /high/i.test(r.severity)).length;
  const med = rows.filter((r) => /medium/i.test(r.severity)).length;
  const low = rows.filter((r) => /low/i.test(r.severity)).length;
  const conf = rows.filter((r) => /^confirmed/i.test(r.confidence)).length;
  const stats = statBar([
    stat("Total BL Diffs", rows.length, idRange(rows.map((r) => r.id)), rows.length ? "red" : "green"),
    stat("Severity", high ? "High" : med ? "Medium" : low ? "Low" : "—", rows.length ? [high && `${high} high`, med && `${med} medium`, low && `${low} low`].filter(Boolean).join(" · ") : "Nothing rated", high ? "red" : ""),
    stat("User Impact", high + med, `Flows affected (${conf} confirmed)`, high ? "red" : ""),
    stat("Status", rows.length ? "Open" : "Clean", rows.length ? "Needs resolution" : "No difference found", rows.length ? "yellow" : "green"),
  ]);
  const cards = rows
    .map((r, n) =>
      card(
        `${v.mod.key}-${slug(r.id)}`,
        cardHead(r.id, plain(r.area) ? r.area : r.id),
        `<span class="badge ${sevClass(r.severity)}">${esc(r.severity || "—")}</span><span class="badge ${confClass(r.confidence)}">${esc(r.confidence || "—")}</span>`,
        `${r.impact ? `<div class="impact-bar"><strong>Impact:</strong> ${inline(splitCitations(r.impact).prose)}</div>` : ""}<div class="split-view${r.merged ? " split-merged" : ""}">${r.merged ? pane("Android & iOS", "android", r.android) : pane("Android", "android", r.android) + pane("iOS", "ios", r.ios)}</div>`,
        n === 0,
      ),
    )
    .join("");
  const extra = [...v.summary, ...v.other.flatMap((x) => [{ kind: "text", text: `**${x.title}**` } as Block, ...x.blocks])];
  return `<section id="sec-${v.mod.key}-bl" class="section">${stats}${cards}${textNotices([...(v.bl?.notes ?? []), ...extra])}</section>`;
}

function slotKind(type: string): string {
  const t = type.toLowerCase();
  if (/toggle|switch/.test(t)) return "toggle";
  if (/dialog|alert|sheet/.test(t)) return "dialog";
  if (/toast|snack/.test(t)) return "toast";
  return "state";
}

function phone(label: string, screen: string, slots: { slot: string; kind: string; text: string }[]): string {
  const mock = slots
    .map((s) => {
      const n = esc(s.slot), t = esc(/^(—|-)?$/.test(s.text.trim()) ? 'Not present' : s.text);
      if (s.kind === "toggle") return `<div class="wf-slot"><div class="wf-row"><span>${n}</span><span class="wf-switch"></span></div><div class="wf-note">${t}</div></div>`;
      if (s.kind === "dialog") return `<div class="wf-slot"><div class="wf-alert"><b>${n}</b><br>${t}</div></div>`;
      if (s.kind === "toast") return `<div class="wf-slot"><div class="wf-toast">${n}: ${t}</div></div>`;
      return `<div class="wf-slot"><div class="wf-state"><span class="wf-slot-name">${n}</span><span>${t}</span></div></div>`;
    })
    .join("");
  return `<div class="phone"><div class="phone-label">${esc(label)}</div><div class="phone-screen"><div class="wf-bar">${esc(screen)}</div>${mock}</div></div>`;
}

function uiSection(v: ModuleView): string {
  const ui = v.ui!;
  const p = ui.platforms;
  const pr = (name: RegExp, c: RegExp) => {
    if (!p) return "—";
    const row = p.rows.find((r) => name.test(r[0] ?? ""));
    const ci = col(p, c);
    return row && ci >= 0 ? plain(row[ci]) : "—";
  };
  void pr;
  const divergent = ui.pairs.reduce((n, x) => n + (Number.parseInt(x.divergent, 10) || 0), 0);
  const allSlots = ui.pairs.flatMap((x) => {
    if (!x.slots) return [];
    const ti = col(x.slots, /type|kind/i);
    return x.slots.rows.map((r) => (ti >= 0 ? plain(r[ti] ?? "") : "state"));
  });
  const kinds = [...new Set(allSlots)];
  const compared = allSlots.length || ui.pairs.reduce((n, x) => n + (Number.parseInt(x.matched, 10) || 0) + (Number.parseInt(x.divergent, 10) || 0), 0);
  const stats = statBar([
    stat("Screen Pairs", ui.pairs.length, ui.pairs.length ? ui.pairs.map((x) => x.id).join(", ") : "No screens rowed"),
    stat("Slots Differ", divergent, `Of ${compared} compared`),
    stat("Slot Types", kinds.length, kinds.join(", ") || "—"),
    stat("Source", "Code", "Reconstructed, not a screenshot"),
  ]);
  const summary = ui.notes.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text.trim()).join(" ");
  const summaryNotice = summary ? notice(`<strong>Report summary:</strong> ${inline(summary)}`) : "";
  const otherNotes = ui.notes.filter((b) => b.kind !== "text");
  const cards = ui.pairs
    .map((x, n) => {
      const [aScreen, iScreen] = plain(x.screen).split(/\s*↔\s*/);
      const { prose, paths } = splitCitations(x.largest);
      let body = !plain(x.largest) ? "" : `<div class="impact-bar"><strong>Summary:</strong> ${inline(prose)} ${paths.map((q) => `<span class="path" translate="no">${esc(q)}</span>`).join("")}</div>`;
      if (x.slots) {
        const t = x.slots;
        const si = { slot: col(t, /^slot$/i), type: col(t, /type|kind/i), a: col(t, /android/i), i: col(t, /ios/i), state: col(t, /state/i) };
        const diffRows = t.rows.filter((r) => !/^same$/i.test(plain(r[si.state] ?? "")));
        const wf = diffRows.map((r) => ({ slot: plain(r[si.slot]), kind: slotKind(plain(r[si.type] ?? "")), a: plain(r[si.a] ?? ""), i: plain(r[si.i] ?? "") }));
        if (wf.length)
          body += `<p class="wf-caption">Reconstructed from source — not a screenshot</p><div class="wf-wrap">${phone(`Android · ${aScreen ?? ""}`, aScreen ?? "", wf.map((s) => ({ slot: s.slot, kind: s.kind, text: s.a })))}${phone(`iOS · ${iScreen ?? ""}`, iScreen ?? "", wf.map((s) => ({ slot: s.slot, kind: s.kind, text: s.i })))}</div>`;
        body += `<div class="api-table-wrap"><table><thead><tr><th>Slot</th><th>Android</th><th>iOS</th></tr></thead><tbody>${t.rows
          .map((r) => {
            const same = /^same$/i.test(plain(r[si.state] ?? ""));
            return `<tr class="${same ? "slot-same" : "slot-diff"}"><td class="td-path">${inline(r[si.slot] ?? "")}${si.type >= 0 ? `<span class="kind-chip">${esc(plain(r[si.type] ?? ""))}</span>` : ""}</td><td>${inline(r[si.a] ?? "")}</td><td>${inline(r[si.i] ?? "")}</td></tr>`;
          })
          .join("")}</tbody></table></div>`;
      }
      const d = Number.parseInt(x.divergent, 10) || 0;
      const badges = `<span class="badge badge-confirmed">${d} slot${d === 1 ? "" : "s"} differ</span>${x.pairing && !/^paired$/i.test(x.pairing) ? `<span class="badge badge-potential">${esc(x.pairing)}</span>` : ""}`;
      const [a2, i2] = plain(x.screen).split(/\s*↔\s*/);
      return card(`${v.mod.key}-${slug(x.id)}`, cardHead(x.id, `${a2 ?? ""} ↔ ${i2 ?? ""}`), badges, body, n === 0);
    })
    .join("");
  return `<section id="sec-${v.mod.key}-ui" class="section">${stats}${summaryNotice}${cards}${proseHtml(otherNotes)}</section>`;
}

function hcSection(v: ModuleView): string {
  const rows = v.hc!.rows;
  const n = (p: string) => rows.filter((r) => r.platform === p).length;
  const k = v.mod.key;
  return `<section id="sec-${k}-hc" class="section">${statBar([
    stat("Total HC Strings", rows.length, "Literals in code", rows.length ? "red" : "green"),
    stat("Android Only", n("android"), "Strings on Android"),
    stat("iOS Only", n("ios"), "Strings on iOS"),
    stat("On Both", n("both"), "Shared literals", "green"),
  ])}<div class="hc-filter-row" data-hc="${k}">
<input type="search" placeholder="Search screen, text or file…" autocomplete="off" spellcheck="false" aria-label="Search hard-coded strings" oninput="hcSearch('${k}',this.value)">
<button class="filter-btn active-filter" onclick="hcFilter('${k}','all',this)">All (${rows.length})</button>
<button class="filter-btn android-filter" onclick="hcFilter('${k}','android',this)">Android only (${n("android")})</button>
<button class="filter-btn" onclick="hcFilter('${k}','ios',this)">iOS only (${n("ios")})</button>
<button class="filter-btn" onclick="hcFilter('${k}','button',this)">Buttons</button>
<button class="filter-btn" onclick="hcFilter('${k}','title',this)">Titles</button>
<button class="filter-btn" onclick="hcFilter('${k}','text',this)">Body text</button>
</div><div class="diff-card" style="overflow:hidden"><div class="api-table-wrap" style="margin:0"><table><thead><tr><th>ID</th><th>Screen</th><th>Element</th><th>Platform</th><th>Text</th><th>File : Line</th></tr></thead><tbody id="hc-tbody-${k}"></tbody></table></div></div></section>`;
}

function apiSection(v: ModuleView): { html: string; drift: number } {
  const blocks = v.api!.blocks;
  // Group by #### sub-heading.
  const groups: { title: string; blocks: Block[] }[] = [{ title: "", blocks: [] }];
  for (const b of blocks) {
    if (b.kind === "heading") groups.push({ title: b.text, blocks: [] });
    else groups[groups.length - 1].blocks.push(b);
  }
  const kpi = groups.find((g) => /kpi/i.test(g.title))?.blocks.find((b) => b.kind === "table") as { table: Table } | undefined;
  const kv = new Map<string, string>();
  for (const r of kpi?.table.rows ?? []) kv.set(plain(r[0]).toLowerCase(), plain(r[1]));
  const get = (re: RegExp) => [...kv.entries()].find(([key]) => re.test(key))?.[1];
  const highRisk = groups.find((g) => /high-?risk/i.test(g.title))?.blocks.find((b) => b.kind === "table") as { table: Table } | undefined;
  const drift = Number.parseInt(get(/^drift/) ?? "", 10) || (highRisk?.table.rows.filter((r) => /drift/i.test(r.join(" "))).length ?? 0);
  const hasTables = groups.some((g) => g.blocks.some((b) => b.kind === "table"));
  // Stat cards as in the template: Endpoints · Body Drift · Unverified · Method.
  const inventory = groups.find((g) => /inventory/i.test(g.title))?.blocks.find((b) => b.kind === "table") as { table: Table } | undefined;
  const meta = groups.find((g) => /^meta$/i.test(g.title))?.blocks.find((b) => b.kind === "table") as { table: Table } | undefined;
  const metaRow = (re: RegExp) => meta?.table.rows.find((r) => re.test(plain(r[0] ?? "")))?.[1] ?? "";
  const endpoints = get(/audited/) ?? (inventory ? String(inventory.table.rows.length) : hasTables ? "—" : "0");
  const bodyDrift = inventory ? inventory.table.rows.filter((r) => /body/i.test(r.join(" ")) && /drift/i.test(r.join(" "))).length : drift;
  const unverified = meta ? meta.table.rows.filter((r) => /unverified|not shown|not attached|not resolved/i.test(r[1] ?? "")).length : 0;
  const method = plain(metaRow(/method/i)).match(/\b(GET|POST|PUT|PATCH|DELETE)\b/)?.[1];
  const stats = statBar([
    stat("Endpoints", endpoints, "In scope"),
    stat("Body Drift", bodyDrift, bodyDrift ? `${drift} drift in total` : "None confirmed", bodyDrift ? "red" : "green"),
    stat("Unverified", unverified || (hasTables ? 0 : "All"), unverified ? "Meta rows: hosts, headers, config" : hasTables ? "Nothing left open" : "Not resolvable from code", "yellow"),
    method
      ? `<div class="stat-card"><div class="stat-label">Method</div><div class="stat-value" style="color:#1A3D63;font-size:22px;letter-spacing:0.02em">${method}</div><div class="stat-sub">${esc(/json/i.test(metaRow(/method/i)) ? "JSON both platforms" : "Both platforms")}</div></div>`
      : stat("Contract", drift ? "Drift" : "Unknown", drift ? "Review findings" : "Not resolvable from code", drift ? "red" : "yellow"),
  ]);
  let html = "";
  for (const g of groups) {
    if (/kpi/i.test(g.title)) continue;
    if (g.title) html += secHead(g.title);
    for (const b of g.blocks) {
      if (b.kind === "table" && /high-?risk/i.test(g.title)) {
        const t = b.table;
        const pi = col(t, /path|endpoint/i), ci = col(t, /contract/i), wi = col(t, /check/i), di = col(t, /drift|tag/i);
        html += t.rows
          .map((r, n) => {
            const isDrift = /drift/i.test(plain(r[ci] ?? ""));
            const tag = plain(r[di] ?? "") || (isDrift ? "DRIFT" : "SAME");
            return card(
              `${v.mod.key}-api-${n}`,
              cardHead(tag.toUpperCase(), plain(r[pi] ?? "")),
              `<span class="badge ${isDrift ? "badge-drift" : "badge-same"}">${esc(plain(r[ci] ?? "") || tag)}</span>`,
              `<div class="impact-bar"><strong>What to check:</strong> ${inline(r[wi] ?? "")}</div>`,
              n === 0,
            );
          })
          .join("");
        continue;
      }
      if (b.kind === "table") {
        const t = b.table;
        const si = col(t, /^status$|^contract$|^state$/i);
        const metaLike = t.head.every((h) => !plain(h));
        html += `<div class="diff-card"><div class="api-table-wrap" style="margin:0"><table>${metaLike ? "" : `<thead><tr>${t.head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>`}<tbody>${t.rows
          .map(
            (r) =>
              `<tr>${t.head
                .map((_, k) => {
                  const c = r[k] ?? "";
                  const cls = k === 0 ? "td-path" : k === si ? (/same|match/i.test(c) ? "td-same" : /drift|only|missing/i.test(c) ? "td-drift" : /unverified/i.test(c) ? "td-unverified" : "") : /^unverified/i.test(plain(c)) ? "td-unverified" : "";
                  return `<td class="${cls}"${k === 0 && metaLike ? ' style="width:200px"' : ""}>${inline(metaLike && k === 0 ? plain(c) : c)}</td>`;
                })
                .join("")}</tr>`,
          )
          .join("")}</tbody></table></div></div>`;
      } else if (b.kind === "text") {
        const t = b.text.trim();
        html += notice(inline(t).replace(/\n/g, "<br>"), /not |unverified|cannot|no contract/i.test(t) ? "⚠" : "ℹ");
      }
    }
  }
  return { html: `<section id="sec-${v.mod.key}-api" class="section">${stats}${html}</section>`, drift };
}


// ─────────────────────────── document ───────────────────────────

export function renderReportUi(markdown: string, opts: { title?: string; meta?: RunMeta } = {}): { html: string; md: string } {
  const { preamble, modules } = parseReport(markdown);
  const views = modules.map(buildView);
  const meta = opts.meta ?? {};
  const sprint = meta.branch ? meta.branch.split("/").pop()! : "parity audit";
  const nameList = modules.map((m) => m.name);
  const title = opts.title ?? `${nameList.length <= 3 ? nameList.join(" + ") : `${nameList.length}-module`} Business Logic Audit`;

  const tiles: string[] = [];
  const navs: string[] = [];
  const sections: string[] = [];
  const cfg: Record<string, unknown> = {};
  const hcData: Record<string, HcRow[]> = {};

  for (const v of views) {
    const k = v.mod.key;
    const tabs: { key: string; label: string; count: string; hot: boolean }[] = [];
    const blRows = v.bl?.rows ?? [];
    const high = blRows.filter((r) => /high/i.test(r.severity)).length;
    if (v.bl) {
      tabs.push({ key: "bl", label: "Business Logic", count: String(blRows.length), hot: high > 0 });
      sections.push(blSection(v));
    }
    if (v.ui && v.ui.pairs.length) {
      tabs.push({ key: "ui", label: "UI Differences", count: String(v.ui.pairs.length), hot: v.ui.pairs.length > 0 });
      sections.push(uiSection(v));
    }
    if (v.hc) {
      tabs.push({ key: "hc", label: "Hard-coded Strings", count: String(v.hc.rows.length), hot: v.hc.rows.length > 0 });
      sections.push(hcSection(v));
      hcData[k] = v.hc.rows;
    }
    let drift = 0;
    if (v.api) {
      const a = apiSection(v);
      drift = a.drift;
      tabs.push({ key: "api", label: "API Contract", count: drift ? `${drift} drift` : "–", hot: drift > 0 });
      sections.push(a.html);
    }
    const sum = [`${blRows.length} BL diff${blRows.length === 1 ? "" : "s"}`, v.ui ? `${v.ui.pairs.length} UI pair${v.ui.pairs.length === 1 ? "" : "s"}` : "", v.hc ? `${v.hc.rows.length} strings` : "", v.api ? `${drift} API drift` : ""].filter(Boolean).join(" · ");
    tiles.push(
      `<button class="mod-tile" data-module="${k}" title="${esc(sum)}" aria-label="${esc(`${v.mod.name}: ${sum}`)}" onclick="location.hash='${k}'"><span class="mod-name">${esc(v.mod.name)}</span><span class="mod-status">${blRows.length}</span></button>`,
    );
    navs.push(
      `<div class="nav-tabs-inner" data-module="${k}" hidden>${tabs
        .map((t) => `<button class="tab-btn" data-module="${k}" data-key="${t.key}" onclick="location.hash='${k}-${t.key}'">${esc(t.label)}${t.count ? ` <span class="tab-count${t.hot ? " has-high" : ""}">${esc(t.count)}</span>` : ""}</button>`)
        .join("")}</div>`,
    );
    const sub = blRows.length
      ? `${high ? `${high} high-severity difference${high === 1 ? "" : "s"}` : "No high-severity differences"} out of ${blRows.length} business-logic finding${blRows.length === 1 ? "" : "s"}.`
      : "No business-logic difference found.";
    cfg[k] = {
      tabs: tabs.map((t) => t.key),
      eyebrow: `${v.mod.name} · ${sprint} · Android vs iOS`,
      title: `${v.mod.name} Business Logic Audit.`,
      sub,
      brand: `${v.mod.name} · Business Logic Audit`,
      s: sprint,
      name: v.mod.name,
    };
  }

  const css = readFileSync(path.join(projectRoot, "public/report-ui.css"), "utf8");
  const extraCss = `
  .md-prose { font-size: 14px; line-height: 1.65; color: var(--text-secondary); }
  .md-prose h1,.md-prose h2,.md-prose h3,.md-prose h4 { color: var(--text-primary); margin: 22px 0 10px; font-weight: 600; }
  .md-prose p { margin: 0 0 12px; } .md-prose ul,.md-prose ol { margin: 0 0 12px 22px; }
  .md-prose blockquote { border-left: 3px solid var(--paytm); padding: 8px 14px; margin: 0 0 12px; background: var(--bg-panel); }
  .split-code .path, .impact-bar .path { overflow-wrap: anywhere; word-break: break-word; }
  .impact-bar .path { display: block; margin-top: 6px; font-size: 12px; }
  .split-view { grid-template-columns: minmax(0,1fr) minmax(0,1fr); }
  .split-view.split-merged { grid-template-columns: minmax(0,1fr); }
  @media (max-width: 800px) { .split-view { grid-template-columns: minmax(0,1fr); } }
  .hc-filter-row input[type=search] { flex: 1 1 240px; max-width: 340px; border: 1px solid var(--border); border-radius: 100px; font: 400 15px var(--sans); padding: 9px 18px; color: var(--text-primary); background: #F6FAFD; }
  .hc-filter-row input[type=search]::placeholder { color: var(--text-tertiary); }
  @media print { .site-header,.nav-tabs { position: static; } .section { display: block !important; page-break-before: always; } .diff-body { display: block !important; } .modules,.hc-filter-row,.sev-bar { display: none; } }
`;
  const metaLine = [meta.market, meta.branch, meta.android ? `android @ ${meta.android}` : "", meta.ios ? `ios @ ${meta.ios}` : "", meta.date].filter(Boolean).join(" · ");
  const first = views[0]?.mod.key ?? "";
  const script = `
const MODS = ${JSON.stringify(cfg)};
const HC = ${JSON.stringify(hcData).replace(/</g, "\\u003c")};
const DEFAULT = ${JSON.stringify(first)};
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toggleCard(id) { const c = document.getElementById(id); const open = c.classList.toggle('open'); c.querySelector('.diff-card-head').setAttribute('aria-expanded', open); }
function buildSeverityFilters() {
  const LEVELS = [['all','All'],['high','High'],['medium','Medium'],['low','Low']];
  document.querySelectorAll('section.section[id$="-bl"]').forEach(sec => {
    const cards = [...sec.querySelectorAll('.diff-card[id]')]; if (!cards.length) return;
    cards.forEach(c => { const b = c.querySelector('.badge-high, .badge-medium, .badge-low'); c.dataset.severity = b ? b.className.match(/badge-(high|medium|low)/)[1] : 'none'; });
    const count = k => k === 'all' ? cards.length : cards.filter(c => c.dataset.severity === k).length;
    const bar = document.createElement('div'); bar.className = 'sev-bar';
    bar.innerHTML = '<span class="sev-label">Severity</span><div class="sev-seg" role="group" aria-label="Filter by severity">' + LEVELS.map(([k, l]) => '<button type="button" class="sev-btn' + (k === 'all' ? ' active' : '') + (count(k) ? '' : ' zero') + '" data-sev="' + k + '" aria-pressed="' + (k === 'all') + '">' + l + '<span class="n">' + count(k) + '</span></button>').join('') + '</div>';
    const empty = document.createElement('p'); empty.className = 'sev-empty'; empty.hidden = true;
    sec.querySelector('.stat-bar').after(bar); bar.after(empty);
    bar.addEventListener('click', e => { const btn = e.target.closest('.sev-btn'); if (!btn) return; const k = btn.dataset.sev;
      bar.querySelectorAll('.sev-btn').forEach(x => { const on = x === btn; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on); });
      let shown = 0; cards.forEach(c => { const show = k === 'all' || c.dataset.severity === k; c.hidden = !show; if (show) shown++; });
      empty.hidden = shown > 0; empty.textContent = 'No ' + k + '-severity differences in this module.'; });
  });
}
const hcState = {};
function renderHC(mod) {
  const st = hcState[mod] || (hcState[mod] = { f: 'all', q: '' });
  const tb = document.getElementById('hc-tbody-' + mod); if (!tb) return;
  const rows = (HC[mod] || []).filter(r => {
    if (st.q && !(r.id + ' ' + r.screen + ' ' + r.text + ' ' + r.file).toLowerCase().includes(st.q)) return false;
    if (st.f === 'all') return true; if (st.f === 'android' || st.f === 'ios') return r.platform === st.f || r.platform === 'both'; return r.type === st.f; });
  tb.innerHTML = rows.length ? rows.map(r => '<tr><td style="font-family:var(--mono);font-size:12.5px;font-weight:500;color:#1A3D63;white-space:nowrap">' + esc(r.id) + '</td><td style="color:#0a1931;font-weight:500;font-size:13px">' + esc(r.screen) + '</td><td style="color:#1A3D63;font-size:13px">' + esc(r.el) + '</td><td><span style="display:inline-block;padding:2px 9px;border-radius:100px;font-size:11.5px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;background:#F6FAFD;color:#1A3D63;border:1px solid ' + (r.platform === 'android' ? 'rgba(26,61,99,0.18)' : '#b3cfe5') + ';font-family:var(--sans)">' + (r.platform === 'android' ? 'Android' : r.platform === 'ios' ? 'iOS' : 'Both') + '</span></td><td style="font-family:var(--mono);font-size:13px;color:#1a3d63;background:#F6FAFD;padding:8px 10px;border-radius:4px;white-space:normal;min-width:220px;overflow-wrap:anywhere">' + esc(r.text) + '</td><td style="font-family:var(--mono);font-size:12px;color:#1A3D63;white-space:nowrap">' + esc(r.file) + '</td></tr>').join('')
    : '<tr><td colspan="6" style="text-align:center;padding:28px;color:#1A3D63">No strings match. Clear the search or pick another filter.</td></tr>';
}
function hcFilter(mod, f, btn) { (hcState[mod] || (hcState[mod] = { f: 'all', q: '' })).f = f; btn.parentElement.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active-filter', 'android-filter')); btn.classList.add('active-filter'); if (f === 'android') btn.classList.add('android-filter'); renderHC(mod); }
function hcSearch(mod, q) { (hcState[mod] || (hcState[mod] = { f: 'all', q: '' })).q = q.trim().toLowerCase(); renderHC(mod); }
function route() {
  const h = location.hash.slice(1); let mod = DEFAULT, tab = null;
  if (h) { const m = Object.keys(MODS).sort((a, b) => b.length - a.length).find(k => h === k || h.startsWith(k + '-')); if (m) { mod = m; tab = h.slice(m.length + 1); } }
  const cfg = MODS[mod]; if (!cfg) return;
  if (!cfg.tabs.includes(tab)) tab = cfg.tabs[0] || null;
  document.querySelectorAll('.mod-tile').forEach(t => { const on = t.dataset.module === mod; t.classList.toggle('active', on); if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
  document.querySelector('.nav-tabs').hidden = cfg.tabs.length < 2;
  document.querySelectorAll('.nav-tabs-inner').forEach(g => g.hidden = g.dataset.module !== mod);
  document.querySelectorAll('.tab-btn').forEach(b => { const on = b.dataset.module === mod && b.dataset.key === tab; b.classList.toggle('active', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const target = tab ? 'sec-' + mod + '-' + tab : 'sec-empty';
  document.querySelectorAll('.section').forEach(x => x.classList.toggle('active', x.id === target));
  document.getElementById('hero-title').textContent = cfg.title;
  document.getElementById('hb-text').textContent = cfg.brand;
  document.getElementById('hm-s').textContent = cfg.s;
  if (!tab) document.getElementById('empty-title').textContent = cfg.name + ': no audit yet';
  document.title = cfg.title.replace(/\\.$/, '') + ' · Android vs iOS';
}
buildSeverityFilters();
Object.keys(HC).forEach(renderHC);
window.addEventListener('hashchange', route);
route();
`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#0a1931">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${css}
${extraCss}
</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to Main Content</a>
<header class="site-header">
  <div class="header-inner">
    <p class="header-brand"><span class="brand-dot" aria-hidden="true"></span><span id="hb-text">${esc(title)}</span></p>
    <div class="header-meta"><span id="hm-s">${esc(sprint)}</span></div>
  </div>
</header>
<section class="hero">
  <h1 id="hero-title">${esc(title)}.</h1>
</section>
<section class="modules" aria-label="Audit modules"><div class="modules-inner">${tiles.join("")}</div></section>
<nav class="nav-tabs" aria-label="Audit sections">
${navs.join("\n")}
</nav>
<main class="main" id="main-content" tabindex="-1">
${preamble.length ? "" : ""}
${sections.join("\n")}
<section id="sec-empty" class="section"><div class="empty-state"><h2 id="empty-title">No audit yet</h2><p>This module has no Business Logic, UI Differences, Hard-coded Strings or API Contract section in the report.</p></div></section>
</main>
<script>${script}</script>
</body>
</html>
`;
  return { html, md: renderReportUiMarkdown(views, title, metaLine) };
}

// ─────────────────────────── Markdown twin ───────────────────────────

function mdCell(s: string) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
function mdTable(head: string[], rows: string[][]) {
  return [`| ${head.map(mdCell).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${head.map((_, k) => mdCell(r[k] ?? "")).join(" | ")} |`)].join("\n");
}
function mdBlocks(blocks: Block[]): string {
  return blocks
    .map((b) => (b.kind === "text" ? b.text : b.kind === "heading" ? `#### ${b.text}` : mdTable(b.table.head, b.table.rows)))
    .join("\n\n");
}

function renderReportUiMarkdown(views: ModuleView[], title: string, metaLine: string): string {
  const out: string[] = [`# ${title}`, ""];
  void metaLine;
  out.push(
    mdTable(
      ["Module", "BL diffs", "High", "UI pairs", "Hard-coded strings", "API drift"],
      views.map((v) => {
        const r = v.bl?.rows ?? [];
        return [`[${v.mod.name}](#${v.mod.key})`, String(r.length), String(r.filter((x) => /high/i.test(x.severity)).length), v.ui ? String(v.ui.pairs.length) : "—", v.hc ? String(v.hc.rows.length) : "—", v.api ? String(apiSection(v).drift) : "—"];
      }),
    ),
    "",
  );
  for (const v of views) {
    const rows = v.bl?.rows ?? [];
    const high = rows.filter((r) => /high/i.test(r.severity)).length;
    const med = rows.filter((r) => /medium/i.test(r.severity)).length;
    const low = rows.filter((r) => /low/i.test(r.severity)).length;
    const conf = rows.filter((r) => /^confirmed/i.test(r.confidence)).length;
    out.push("---", "", `<a id="${v.mod.key}"></a>`, "", `# ${v.mod.name} Business Logic Audit.`, "");
    if (v.bl) {
      out.push("## Business Logic", "");
      out.push(mdTable(["Total BL Diffs", "Severity (High · Medium · Low)", "Confirmed", "Status"], [[String(rows.length), `${high} · ${med} · ${low}`, `${conf} / ${rows.length}`, rows.length ? "Open — needs resolution" : "Clean"]]), "");
      for (const r of rows) {
        const a = splitCitations(r.android), i = splitCitations(r.ios);
        out.push(`### ${r.id} · ${plain(r.area)}`, "", `**${r.severity}** · ${r.confidence}`, "");
        if (r.impact) out.push(`**Impact:** ${splitCitations(r.impact).prose}`, "");
        if (r.merged) {
          out.push(`**Android & iOS**`, "", a.prose, ...a.paths.map((p) => `\`${p}\``), "");
          continue;
        }
        out.push(`**Android**`, "", a.prose || "_No counterpart in the audited source._", ...a.paths.map((p) => `\`${p}\``), "");
        out.push(`**iOS**`, "", i.prose || "_No counterpart in the audited source._", ...i.paths.map((p) => `\`${p}\``), "");
      }
      if (v.bl.notes.length) out.push(mdBlocks(v.bl.notes), "");
    }
    if (v.ui) {
      out.push("## UI Differences", "");
      if (v.ui.platforms) out.push(mdTable(v.ui.platforms.head, v.ui.platforms.rows), "");
      for (const p of v.ui.pairs) {
        out.push(`### ${p.id} · ${plain(p.screen)}`, "", `**${p.divergent || 0} divergent** · ${p.pairing}`, "", ...(plain(p.largest) ? [`**Largest difference:** ${p.largest}`, ""] : []));
        if (p.slots) out.push(mdTable(p.slots.head, p.slots.rows), "");
      }
      if (v.ui.notes.length) out.push(mdBlocks(v.ui.notes), "");
    }
    if (v.hc) {
      const h = v.hc.rows;
      const n = (x: string) => h.filter((r) => r.platform === x).length;
      out.push("## Hard-coded Strings", "", mdTable(["Total HC Strings", "Android Only", "iOS Only", "On Both"], [[String(h.length), String(n("android")), String(n("ios")), String(n("both"))]]), "");
      out.push(mdTable(["ID", "Screen", "Element", "Platform", "Text", "File : Line"], h.map((r) => [r.id, r.screen, r.el, r.platform === "android" ? "Android" : r.platform === "ios" ? "iOS" : "Both", r.text, r.file])), "");
    }
    if (v.api) out.push("## API Contract", "", mdBlocks(v.api.blocks), "");
    if (v.summary.length || v.other.length) {
      out.push("## Notes", "", mdBlocks(v.summary), "");
      for (const s of v.other) out.push(`### ${s.title}`, "", mdBlocks(s.blocks), "");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

// ─────────────────────────── CLI ───────────────────────────

function readMeta(dir: string): RunMeta {
  const meta: RunMeta = {};
  try {
    const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
    meta.branch = run.branch ?? run.meta?.branch;
    meta.market = run.market ?? run.app;
    meta.android = (run.androidCommit ?? run.android?.commit ?? "").slice(0, 7) || undefined;
    meta.ios = (run.iosCommit ?? run.ios?.commit ?? "").slice(0, 7) || undefined;
    meta.date = (run.date ?? run.finishedAt ?? run.startedAt ?? "").slice(0, 10) || undefined;
  } catch {}
  return meta;
}

export async function main(argv: string[]): Promise<number> {
  const target = argv.find((a, k) => !a.startsWith("--") && !/^--(out|md|title|pdf)$/.test(argv[k - 1] ?? ""));
  const opt = (name: string) => {
    const k = argv.indexOf(`--${name}`);
    return k >= 0 ? argv[k + 1] : undefined;
  };
  if (!target || !existsSync(target)) {
    console.error("Usage: node src/report-ui.ts <run-dir|parity-report.md> [--out report.html] [--md report.md] [--pdf report.pdf] [--title ...]");
    return 1;
  }
  const mdFile = statSync(target).isDirectory() ? path.join(target, "parity-report.md") : target;
  const dir = path.dirname(mdFile);
  const { html, md } = renderReportUi(readFileSync(mdFile, "utf8"), { title: opt("title"), meta: readMeta(dir) });
  const outHtml = opt("out") ?? path.join(dir, "parity-report.ui.html");
  const outMd = opt("md") ?? path.join(dir, "parity-report.ui.md");
  writeFileSync(outHtml, html);
  writeFileSync(outMd, md);
  console.error(`HTML: ${outHtml}\nMD:   ${outMd}`);
  const outPdf = opt("pdf");
  if (outPdf) {
    // Print the same page, every tab expanded (see the @media print rules), so the PDF matches the HTML.
    try {
      const { findChrome, renderReportPdf } = await import("./pdf.ts");
      const chrome = findChrome();
      if (chrome) {
        writeFileSync(outPdf, await renderReportPdf(chrome, html));
        console.error(`PDF:  ${outPdf}`);
      } else console.error("PDF:  not produced (Chrome is needed to print it)");
    } catch (error) {
      console.error(`PDF:  not produced (${(error as Error).message})`);
    }
  }
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exit(await main(process.argv.slice(2)));
