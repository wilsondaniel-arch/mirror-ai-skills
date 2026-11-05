/**
 * A small Markdown-to-HTML converter for the reports the audit writes, so a
 * report produced from the CLI can be saved as HTML and PDF without the web
 * page. It covers what the specs use: headings, paragraphs, pipe tables,
 * lists, block quotes, fenced code, rules, and inline code/bold/italic/links.
 * Everything is escaped first; no raw HTML from the report passes through.
 */

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index++;
      continue;
    }
    const fence = /^(```|~~~)/.exec(trimmed);
    if (fence) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      index++;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push("<hr />");
      index++;
      continue;
    }
    if (trimmed.startsWith("|") && index + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[index + 1].trim())) {
      const head = cells(trimmed);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) rows.push(cells(lines[index++].trim()));
      const keys = head.map((cell) => cell.toLowerCase().replace(/[^a-z ]/g, "").trim());
      if (LAYOUT_COLUMNS.every((column) => keys.includes(column))) {
        out.push(renderLayout(keys, rows));
        continue;
      }
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((row) => `<tr>${head.map((_, at) => `<td>${inline(row[at] ?? "")}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (trimmed.startsWith(">")) {
      const body: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) body.push(lines[index++].trim().replace(/^>\s?/, ""));
      out.push(`<blockquote>${markdownToHtml(body.join("\n"))}</blockquote>`);
      continue;
    }
    const bullet = /^([-*+]|\d+[.)])\s+/;
    if (bullet.test(trimmed)) {
      const ordered = /^\d/.test(trimmed);
      const items: string[] = [];
      while (index < lines.length && bullet.test(lines[index].trim())) {
        let item = lines[index++].trim().replace(bullet, "");
        // Continuation lines indented under the item.
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !bullet.test(lines[index].trim())) item += ` ${lines[index++].trim()}`;
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = lines[index].trim();
      if (!next || /^(#{1,6}\s|```|~~~|>|\|)/.test(next) || bullet.test(next) || /^(-{3,}|\*{3,})$/.test(next)) break;
      paragraph.push(next);
      index++;
    }
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }
  return out.join("\n");
}

/** The UI spec's layout view, drawn as the web page draws it (same CSS classes). */
const LAYOUT_COLUMNS = ["slot", "type", "android", "ios", "state"];
const SLOT_GLYPH: Record<string, string> = {
  appbar: "▭", title: "T", text: "¶", button: "▬", link: "↗", input: "▢",
  toggle: "◉", image: "▣", icon: "◆", list: "☰", row: "▭", sheet: "⌃",
  dialog: "▢", state: "◌", spacer: " ",
};

function renderLayout(keys: string[], body: string[][]): string {
  const at = (row: string[], name: string) => (row[keys.indexOf(name)] ?? "").trim();
  const rows = body.map((row) => {
    const state = at(row, "state").toLowerCase().replace(/[^a-z]/g, "");
    return {
      slot: at(row, "slot"),
      type: at(row, "type").toLowerCase(),
      android: at(row, "android"),
      ios: at(row, "ios"),
      state:
        state === "divergent" ? "divergent" : state === "androidonly" ? "android-only" : state === "iosonly" ? "ios-only" : "same",
    };
  });
  const differing = rows.filter((row) => row.state !== "same").length;
  const side = (row: (typeof rows)[number], platform: "android" | "ios") => {
    const text = platform === "android" ? row.android : row.ios;
    const absent = !text || text === "—" || text === "-";
    const missing = (platform === "android" && row.state === "ios-only") || (platform === "ios" && row.state === "android-only");
    return `<div class="slot slot-${row.state}${absent || missing ? " slot-absent" : ""}"><span class="slot-glyph">${escapeHtml(
      SLOT_GLYPH[row.type] ?? "▭",
    )}</span><span class="slot-text">${absent ? "<em>not here</em>" : inline(text)}</span></div>`;
  };
  const labels = rows
    .map((row) => `<div class="slot-label slot-${row.state}"><span>${inline(row.slot)}</span><span class="slot-type">${escapeHtml(row.type)}</span></div>`)
    .join("");
  return `<div class="layout"><header><span>Reconstructed from source — not a screenshot</span><span>${differing} slot${
    differing === 1 ? "" : "s"
  } differ${differing === 1 ? "s" : ""}</span></header><div class="layout-grid"><div class="layout-col layout-labels"><h5>Slot</h5>${labels}</div><div class="layout-col"><h5>Android</h5>${rows
    .map((row) => side(row, "android"))
    .join("")}</div><div class="layout-col"><h5>iOS</h5>${rows.map((row) => side(row, "ios")).join("")}</div></div></div>`;
}

function cells(row: string): string[] {
  const inner = row.replace(/^\|/, "").replace(/\|\s*$/, "");
  // Split on pipes that are not escaped and not inside inline code.
  const parts: string[] = [];
  let current = "";
  let inCode = false;
  for (let at = 0; at < inner.length; at++) {
    const char = inner[at];
    if (char === "`") inCode = !inCode;
    if (char === "\\" && inner[at + 1] === "|") {
      current += "|";
      at++;
      continue;
    }
    if (char === "|" && !inCode) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

function inline(text: string): string {
  const codes: string[] = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, at: string) => codes[Number(at)]);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
