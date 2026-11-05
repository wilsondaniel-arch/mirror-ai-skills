/**
 * Draws an API contract drift report the way the superapp-workspace workflow's
 * Cursor canvas does (`reference/api-contract-drift.canvas.template.tsx`): the
 * same sections in the same order, the same tables and column sets, the same
 * tint for the same contract value or drift tag everywhere.
 *
 * It takes the canvas's own data shape. The full-market snapshot arrives in it
 * directly; a module's section 3 is read out of its markdown by
 * `parseDriftSection` first.
 */

const DC_CONTRACT_KIND = { same: "Same", drift: "Drift", "android-only": "Android only", "ios-only": "iOS only" };
const DC_CONTRACT_COLOR = { Same: "green", Drift: "orange", "Android only": "blue", "iOS only": "purple", "A only": "blue" };
const DC_TAG_COLOR = { BODY: "orange", HDR: "cyan", ROUTE: "blue", TYPE: "purple", CASE: "red", HOST: "pink" };
const DC_CATEGORY_COLOR = { Auth: "blue", Account: "purple", Storefront: "cyan", Payments: "orange", Loyalty: "yellow", Comms: "green" };
const DC_RISK_TONE = { low: "neutral", medium: "warning", high: "danger" };

function renderDriftCanvas(model) {
  const apis = model.apis || [];
  const modules = model.modules?.length ? model.modules : [...new Set(apis.map((row) => row.category))];
  const stats = new Map(modules.map((name) => [name, dcSummarize(apis.filter((row) => row.category === name))]));
  const hdrTotal = modules.reduce((sum, name) => sum + stats.get(name).hdr, 0);
  const diffTotal = modules.reduce((sum, name) => sum + stats.get(name).totalDiff, 0);
  const count = (contract) => apis.filter((row) => row.contract === contract).length;
  const k = {
    total: model.kpis?.total ?? apis.length,
    same: model.kpis?.same ?? count("same"),
    drift: model.kpis?.drift ?? count("drift"),
    androidOnly: model.kpis?.androidOnly ?? count("android-only"),
    iosOnly: model.kpis?.iosOnly ?? count("ios-only"),
    highRisk: model.kpis?.highRisk ?? (model.highRisk || []).length,
    stale: model.kpis?.stale ?? (model.stale || []).length,
  };
  k.exclusive = model.kpis?.exclusive ?? k.androidOnly + k.iosOnly;
  const baseline = model.baseline || [];
  const b = {
    same: baseline.filter((h) => h.status === "Same").length,
    drift: baseline.filter((h) => h.status === "Drift").length,
    aOnly: baseline.filter((h) => h.status === "A only").length,
    iosOnly: baseline.filter((h) => h.status === "iOS only").length,
  };
  const meta = model.meta || {};
  const wiredBoth = k.same + k.drift;

  const parts = [];
  // 1 · Title block
  parts.push(`<div class="dc-title">
    <h2 class="dc-h1">${dcEscape(model.title || "API Contract Drift")}</h2>
    <p class="dc-meta">${[
      meta.sprint ? `Sprint ${dcCode(meta.sprint)}` : "",
      meta.androidSha ? `Android ${dcCode(meta.androidSha)}` : "",
      meta.iosSha ? `iOS ${dcCode(meta.iosSha)}` : "",
      meta.generated ? `Generated ${dcEscape(meta.generated)}` : "",
    ]
      .filter(Boolean)
      .join(" · ")}</p>
    <div class="dc-row">${(meta.chips || []).map((chip) => dcPlain(chip)).join("")}</div>
  </div>`);

  // 2 · How to read this report
  parts.push(
    dcCollapse({
      title: "How to read this report",
      trailing: `<span class="dc-hint">Contract · Drift tags</span>`,
      open: false,
      body: `<p class="dc-small dc-secondary"><strong>Contract</strong> — cross-platform alignment per BFF path. <strong>Drift</strong> — mismatch type when wired on both. <strong>Android extra / iOS extra</strong> — per-call headers beyond interceptor baseline.</p>
        ${dcTable(["Contract value", "Meaning"], [
          [dcTint("Same"), "Wired on both; request contract matches"],
          [dcTint("Drift"), "Wired on both; body, headers, types, or orchestration differ"],
          [dcTint("Android only"), "Wired on Android, absent on iOS"],
          [dcTint("iOS only"), "Wired on iOS, absent on Android"],
        ])}
        ${dcTable(["Drift tag", "Meaning"], [
          [dcTag("BODY"), "Request body field mismatch"],
          [dcTag("HDR"), "Per-call or baseline header mismatch"],
          [dcTag("ROUTE"), "Path wired on one platform only"],
          [dcTag("TYPE"), "Type / enum mismatch on shared path"],
          [dcTag("CASE"), "Header name casing mismatch (e.g. uid vs UID)"],
          [dcTag("HOST"), "Different base URL / host"],
        ])}
        <p class="dc-small dc-tertiary">Row dot colors reflect severity (high-risk rows use danger tone).</p>`,
    }),
  );

  // 3 · KPI row
  parts.push(`<div class="dc-kpis">
    ${dcStat(k.total, "APIs audited")}
    ${dcStat(k.same, "Contract match", "success")}
    ${dcStat(k.drift, "Drift", "warning")}
    ${dcStat(k.exclusive, "Platform exclusive", "info")}
    ${dcStat(k.highRisk, "High risk", "danger")}
    ${dcStat(k.stale, "Stale constants")}
  </div>`);
  parts.push(`<hr class="dc-divider" />`);

  // 4 · Module drift overview
  parts.push(`<div class="dc-stack">
    <div class="dc-row dc-row-center">
      <h3 class="dc-h3">Header &amp; contract diff by module</h3>
      ${dcStat(hdrTotal, "Endpoint HDR drifts", "", true)}
      ${dcStat(diffTotal, "Total module diffs", "", true)}
    </div>
    <div class="dc-overview">
      <div class="dc-stack">
        ${dcBarChart(modules, [
          { name: "HDR", tone: "info", data: modules.map((name) => stats.get(name).hdr) },
          { name: "Contract drift", tone: "warning", data: modules.map((name) => stats.get(name).drift) },
          { name: "Route exclusive", tone: "neutral", data: modules.map((name) => stats.get(name).exclusive) },
        ])}
        <p class="dc-small dc-tertiary">Module drift breakdown · API count by module · Source: sprint SHA inventory</p>
      </div>
      ${dcTable(
        ["Module", "APIs", "Same", "Drift", "HDR", "Exclusive", "Total diff"],
        modules.map((name) => {
          const s = stats.get(name);
          return [
            `<span class="dc-module"><span class="dc-swatch dc-c-${dcCategoryColor(name)}"></span><span class="dc-dot ${s.drift > 0 ? "dc-dot-warning" : "dc-dot-info"}"></span><strong>${dcEscape(name)}</strong></span>`,
            s.apis,
            s.same,
            dcDash(s.drift),
            s.hdr === 0 ? dcDash(0) : dcPlain(String(s.hdr)),
            s.exclusive,
            dcPlain(String(s.totalDiff)),
          ];
        }),
        { striped: true },
      )}
    </div>
  </div>`);

  // 5 · Contract status + Route coverage
  parts.push(`<div class="dc-two">
    <div class="dc-stack">
      <h3 class="dc-h3">Contract status</h3>
      <div class="dc-row">
        ${dcPlain(`Same · ${k.same} · ${dcPct(k.same, k.total)}%`)}
        ${dcPlain(`Drift · ${k.drift} · ${dcPct(k.drift, k.total)}%`)}
        ${dcPlain(`Android only · ${k.androidOnly} · ${dcPct(k.androidOnly, k.total)}%`)}
        ${dcPlain(`iOS only · ${k.iosOnly} · ${dcPct(k.iosOnly, k.total)}%`)}
        ${dcPlain(`${k.total} paths`)}
      </div>
      <p class="dc-small dc-tertiary">Source: sprint SHA inventory · contract field per API path</p>
    </div>
    <div class="dc-stack">
      <h3 class="dc-h3">Route coverage</h3>
      ${dcUsageBar(k.total, [
        { label: "Same", value: k.same, color: "green" },
        { label: "Drift", value: k.drift, color: "orange" },
        { label: "Android only", value: k.androidOnly, color: "blue" },
        { label: "iOS only", value: k.iosOnly, color: "purple" },
      ])}
      <p class="dc-small dc-tertiary">Wired on both platforms: ${wiredBoth} paths at this SHA</p>
    </div>
  </div>`);
  parts.push(`<hr class="dc-divider" />`);

  // 6 · High-risk findings
  const risks = model.highRisk || [];
  parts.push(`<div class="dc-stack">
    <div class="dc-row dc-row-center"><h3 class="dc-h3">High-risk findings</h3>${dcPlain(`${risks.length} item${risks.length === 1 ? "" : "s"}`)}</div>
    <p class="dc-small dc-secondary">Paths and baseline headers requiring immediate cross-platform review.</p>
    ${
      risks.length
        ? dcTable(
            ["Path", "Contract", "What to check", "Drift"],
            risks.map((r) => [dcCode(r.path), dcTint(r.contract), dcInline(r.check), dcTags(r.drift)]),
            { striped: true, tones: risks.map(() => "danger") },
          )
        : `<p class="dc-small dc-tertiary">None.</p>`
    }
  </div>`);
  parts.push(`<hr class="dc-divider" />`);

  // 7 · Baseline header, then the inventory by module
  const inventory = [
    dcCollapse({
      title: "Baseline header",
      count: baseline.length,
      swatch: "gray",
      open: true,
      body: `<div class="dc-row">${dcPlain(`Same ${b.same}`)}${dcPlain(`Drift ${b.drift}`)}${dcPlain(`Android only ${b.aOnly}`)}${dcPlain(`iOS only ${b.iosOnly}`)}</div>
        ${dcTable(
          ["Header", "Android", "iOS", "Status", "Tag"],
          baseline.map((h) => [
            dcCode(h.header),
            `<span class="dc-small dc-secondary">${dcInline(h.android)}</span>`,
            `<span class="dc-small dc-secondary">${dcInline(h.ios)}</span>`,
            dcTint(h.status),
            !h.tag || h.tag === "—" ? dcDash(0) : dcTags([h.tag]),
          ]),
          { striped: true },
        )}
        ${
          meta.androidBaselineEvidence || meta.iosBaselineEvidence
            ? `<p class="dc-small dc-tertiary">Android: ${dcInline(meta.androidBaselineEvidence || "—")} · iOS: ${dcInline(meta.iosBaselineEvidence || "—")}</p>`
            : ""
        }
        <div class="dc-row">${dcPlain(`Diff ${b.drift + b.aOnly + b.iosOnly}`)}${dcPlain(`Drift ${b.drift}`)}${dcPlain(`Platform-only ${b.aOnly + b.iosOnly}`)}</div>`,
    }),
    ...modules.map((name) => {
      const rows = apis.filter((row) => row.category === name);
      const s = stats.get(name);
      return dcCollapse({
        title: name,
        count: rows.length,
        swatch: dcCategoryColor(name),
        open: modules.length === 1,
        trailing: [s.hdr > 0 ? dcPlain(`HDR ${s.hdr}`) : "", s.drift > 0 ? dcPlain(`Drift ${s.drift}`) : "", s.exclusive > 0 ? dcPlain(`Exclusive ${s.exclusive}`) : ""].join(""),
        body: dcTable(
          ["Path", "Contract", "Drift", "Android extra", "iOS extra", "Android body", "iOS body", "Notes"],
          rows.map((r) => [
            dcCode(r.path),
            dcTint(DC_CONTRACT_KIND[r.contract] || r.contract),
            dcTags(r.drift),
            dcExtra(r.androidExtra),
            dcExtra(r.iosExtra),
            `<span class="dc-small dc-secondary">${dcInline(r.android)}</span>`,
            `<span class="dc-small dc-secondary">${dcInline(r.ios)}</span>`,
            `<span class="dc-small">${dcInline(r.notes || "—")}</span>`,
          ]),
          { striped: true, sticky: true, tones: rows.map((r) => DC_RISK_TONE[r.risk] || "neutral") },
        ),
      });
    }),
  ];
  parts.push(`<div class="dc-stack">${inventory.join("")}</div>`);

  // 8 · Stale constants
  const stale = model.stale || [];
  parts.push(
    dcCollapse({
      title: "Stale constants",
      count: stale.length,
      swatch: "gray",
      open: false,
      body: stale.length
        ? dcTable(
            ["Path", "Android", "iOS", "Notes"],
            stale.map((s) => [dcCode(s.path), dcInline(s.android), dcInline(s.ios), `<span class="dc-small dc-secondary">${dcInline(s.notes || "—")}</span>`]),
            { striped: true },
          )
        : `<p class="dc-small dc-tertiary">None.</p>`,
    }),
  );

  // 9 · Environment base URLs
  const env = model.env || [];
  if (env.length) {
    parts.push(
      dcCollapse({
        title: "Environment base URLs",
        swatch: "blue",
        open: false,
        body: dcTable(["Env", "Android", "iOS", "Match"], env.map((e) => [dcEscape(e.env), dcInline(e.android), dcInline(e.ios), dcInline(e.match)])),
      }),
    );
  }

  if (model.keyPatterns?.length) {
    parts.push(
      dcCollapse({
        title: "Key patterns",
        count: model.keyPatterns.length,
        swatch: "gray",
        open: false,
        body: `<ul class="dc-list">${model.keyPatterns.map((line) => `<li>${dcInline(line)}</li>`).join("")}</ul>`,
      }),
    );
  }

  parts.push(
    `<p class="dc-small dc-tertiary">Generated by API contract drift workflow · docs/10-api-contract-drift.md${
      meta.androidSha ? ` · SHAs ${dcEscape(meta.androidSha)} / ${dcEscape(meta.iosSha || "—")}` : ""
    }</p>`,
  );
  return `<div class="dc">${parts.join("")}</div>`;
}

/**
 * Reads a module's "3. API Contract Drift" markdown into the canvas's data
 * shape. Returns null when the section has no inventory table, so the page can
 * fall back to the markdown as written.
 */
function parseDriftSection(markdown, options = {}) {
  const sections = new Map();
  let current = "";
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^\s*####\s+(.*)$/.exec(line);
    if (heading) {
      current = heading[1].trim().toLowerCase();
      sections.set(current, []);
    } else if (current) {
      sections.get(current).push(line);
    }
  }
  const find = (name) => [...sections.entries()].find(([key]) => key.startsWith(name))?.[1] || [];
  const inventory = dcTables(find("api inventory"))[0];
  if (!inventory) return null;
  const label = options.label || "Module";

  const metaRows = new Map(
    (dcTables(find("meta"))[0]?.rows || []).map((cells) => [dcPlainText(cells[0]).toLowerCase(), cells[1] || ""]),
  );
  const side = (value) => {
    const [branch, sha] = dcPlainText(value || "").split("@").map((part) => part.trim());
    return { branch: branch || "", sha: sha || "" };
  };
  const android = side(metaRows.get("android"));
  const ios = side(metaRows.get("ios"));
  const market = metaRows.get("market") || "";
  const tenant = /tenant\W+`?([A-Z]{2,})`?/i.exec(market)?.[1] || "";
  const bff = dcPlainText(metaRows.get("bff prefix") || "").split(/\s+/)[0];
  const hosts = dcPlainText(metaRows.get("hosts") || "").split(/[\s;:,(]/)[0];
  const evidence = (metaRows.get("baseline evidence") || "").split(" · ");

  const kpiRows = new Map((dcTables(find("kpis"))[0]?.rows || []).map((cells) => [dcPlainText(cells[0]).toLowerCase(), Number(dcPlainText(cells[1]))]));
  const risky = dcTables(find("high-risk"))[0]?.rows || [];
  const highRisk = risky.map((cells) => ({
    path: dcPlainText(cells[0]),
    contract: dcPlainText(cells[1]),
    check: cells[2] || "",
    drift: dcTagList(cells[3]),
  }));
  const riskyPaths = new Set(highRisk.map((r) => r.path));
  const contractOf = (value) => {
    const text = dcPlainText(value).toLowerCase();
    if (text.startsWith("same")) return "same";
    if (text.startsWith("android")) return "android-only";
    if (text.startsWith("ios")) return "ios-only";
    return "drift";
  };
  const column = (name) => inventory.header.findIndex((cell) => dcPlainText(cell).toLowerCase() === name);
  const at = (cells, name) => cells[column(name)] ?? "";
  const apis = inventory.rows.map((cells) => {
    const contract = contractOf(at(cells, "contract"));
    const path = dcPlainText(at(cells, "path"));
    return {
      path,
      category: label,
      contract,
      drift: dcTagList(at(cells, "drift")),
      risk: riskyPaths.has(path) ? "high" : contract === "same" ? "low" : "medium",
      android: at(cells, "android body"),
      ios: at(cells, "ios body"),
      notes: at(cells, "notes"),
      androidExtra: dcExtraValue(at(cells, "android extra")),
      iosExtra: dcExtraValue(at(cells, "ios extra")),
    };
  });
  const baselineLines = find("baseline");
  const baseline = (dcTables(baselineLines)[0]?.rows || []).map((cells) => ({
    header: dcPlainText(cells[0]),
    android: cells[1] || "",
    ios: cells[2] || "",
    status: dcPlainText(cells[3]),
    tag: dcTagList(cells[4])[0] || "—",
  }));
  const stale = (dcTables(find("stale"))[0]?.rows || []).map((cells) => ({
    path: dcPlainText(cells[0]),
    android: cells[1] || "",
    ios: cells[2] || "",
    notes: cells[3] || "",
  }));
  const env = (dcTables(find("environment"))[0]?.rows || []).map((cells) => ({
    env: dcPlainText(cells[0]),
    android: cells[1] || "",
    ios: cells[2] || "",
    match: dcPlainText(cells[3]),
  }));
  const keyPatterns = find("key patterns")
    .map((line) => /^\s*[-*]\s+(.*)$/.exec(line)?.[1])
    .filter(Boolean);
  const number = (key) => (Number.isFinite(kpiRows.get(key)) ? kpiRows.get(key) : undefined);
  return {
    title: `${label} — API Contract Drift`,
    meta: {
      sprint: android.branch === ios.branch ? android.branch : [android.branch, ios.branch].filter(Boolean).join(" / "),
      androidSha: android.sha,
      iosSha: ios.sha,
      generated: options.generated || "",
      chips: [bff ? `BFF ${bff}` : "", dcPlainText(metaRows.get("method") || "") || "POST JSON", hosts ? `Hosts ${hosts}` : "", tenant ? `Tenant ${tenant}` : ""].filter(Boolean),
      androidBaselineEvidence: evidence[0] || "",
      iosBaselineEvidence: evidence[1] || "",
    },
    kpis: {
      total: number("apis audited"),
      same: number("contract match"),
      drift: number("drift"),
      exclusive: number("platform exclusive"),
      highRisk: number("high risk"),
      stale: number("stale constants"),
    },
    modules: [label],
    apis,
    baseline,
    highRisk,
    stale,
    env,
    keyPatterns,
  };
}

// ------------------------------------------------------------------ pieces

function dcSummarize(items) {
  return {
    apis: items.length,
    same: items.filter((r) => r.contract === "same").length,
    drift: items.filter((r) => r.contract === "drift").length,
    hdr: items.filter((r) => (r.drift || []).includes("HDR")).length,
    exclusive: items.filter((r) => r.contract === "android-only" || r.contract === "ios-only").length,
    totalDiff: items.filter((r) => r.contract !== "same" || (r.drift || []).includes("HDR")).length,
  };
}

function dcCollapse({ title, count, swatch, trailing = "", open = false, body }) {
  return `<details class="dc-collapse"${open ? " open" : ""}>
    <summary>
      <span class="dc-chevron" aria-hidden="true"></span>
      ${swatch ? `<span class="dc-swatch dc-c-${swatch}"></span>` : ""}
      <span class="dc-collapse-title">${dcEscape(title)}</span>
      ${count !== undefined ? `<span class="dc-count">${count}</span>` : ""}
      <span class="dc-trailing">${trailing}</span>
    </summary>
    <div class="dc-collapse-body">${body}</div>
  </details>`;
}

function dcTable(headers, rows, { striped = false, sticky = false, tones = [] } = {}) {
  const head = headers.map((cell) => `<th>${dcEscape(cell)}</th>`).join("");
  const body = rows
    .map((cells, index) => {
      const tone = tones[index] && tones[index] !== "neutral" ? ` class="dc-tone-${tones[index]}"` : "";
      return `<tr${tone}>${cells.map((cell) => `<td>${typeof cell === "number" ? cell : cell ?? ""}</td>`).join("")}</tr>`;
    })
    .join("");
  return `<div class="dc-table-wrap"><table class="dc-table${striped ? " dc-striped" : ""}${sticky ? " dc-sticky" : ""}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function dcStat(value, label, tone = "", compact = false) {
  return `<div class="dc-stat${tone ? ` dc-stat-${tone}` : ""}${compact ? " dc-stat-compact" : ""}"><div class="dc-stat-value">${dcEscape(String(value ?? "—"))}</div><div class="dc-stat-label">${dcEscape(label)}</div></div>`;
}

function dcBarChart(categories, series) {
  const max = Math.max(1, ...series.flatMap((s) => s.data));
  const legend = series.map((s) => `<span class="dc-legend"><span class="dc-legend-swatch dc-bar-${s.tone}"></span>${dcEscape(s.name)}</span>`).join("");
  const rows = categories
    .map(
      (name, index) => `<div class="dc-bar-row">
        <span class="dc-bar-label">${dcEscape(name)}</span>
        <span class="dc-bar-group">${series
          .map((s) => {
            const value = s.data[index];
            return `<span class="dc-bar-line"><span class="dc-bar dc-bar-${s.tone}" style="width:${(100 * value) / max}%"></span><span class="dc-bar-value">${value}</span></span>`;
          })
          .join("")}</span>
      </div>`,
    )
    .join("");
  return `<div class="dc-chart"><div class="dc-row">${legend}</div>${rows}</div>`;
}

function dcUsageBar(total, segments) {
  const bar = segments
    .filter((s) => s.value > 0)
    .map((s) => `<span class="dc-usage-seg dc-c-${s.color}" style="width:${(100 * s.value) / Math.max(1, total)}%" title="${dcEscape(`${s.label} ${s.value}`)}"></span>`)
    .join("");
  const legend = segments
    .map((s) => `<span class="dc-legend"><span class="dc-legend-swatch dc-c-${s.color}"></span>${dcEscape(s.label)} <strong>${s.value}</strong></span>`)
    .join("");
  return `<div class="dc-usage">${bar}</div><div class="dc-row">${legend}</div>`;
}

function dcTint(label) {
  const text = dcPlainText(label || "");
  return `<span class="dc-chip dc-tint dc-tint-${DC_CONTRACT_COLOR[text] || "gray"}">${dcEscape(text || "—")}</span>`;
}

function dcTag(tag) {
  return `<span class="dc-chip dc-tag dc-tint-${DC_TAG_COLOR[tag] || "gray"}">${dcEscape(tag)}</span>`;
}

function dcTags(tags) {
  if (!tags || tags.length === 0) return `<span class="dc-small dc-quaternary">—</span>`;
  return `<span class="dc-row dc-row-tight">${tags.map(dcTag).join("")}</span>`;
}

function dcPlain(label) {
  return `<span class="dc-chip dc-plain">${dcEscape(label)}</span>`;
}

function dcExtra(value) {
  if (value === "baseline") return `<span class="dc-small dc-secondary"><em>baseline</em></span>`;
  return `<span class="dc-small dc-secondary">${dcInline(value || "—")}</span>`;
}

function dcDash(value) {
  return value === 0 ? `<span class="dc-small dc-quaternary">—</span>` : String(value);
}

function dcCode(value) {
  return `<code class="dc-code">${dcEscape(dcPlainText(value || ""))}</code>`;
}

function dcPct(count, total) {
  return total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
}

function dcCategoryColor(name) {
  return DC_CATEGORY_COLOR[name] || "teal";
}

/** `` `HDR`, `TYPE` `` → ["HDR", "TYPE"]; a dash or blank → []. */
function dcTagList(cell) {
  return (cell || "")
    .split(",")
    .map((tag) => dcPlainText(tag).toUpperCase())
    .filter((tag) => Object.hasOwn(DC_TAG_COLOR, tag));
}

function dcExtraValue(cell) {
  const text = dcPlainText(cell || "");
  return /^baseline$/i.test(text) ? "baseline" : text || "—";
}

/** A markdown cell's text with backticks, bold and italic markers removed. */
function dcPlainText(cell) {
  return String(cell || "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1$2")
    .trim();
}

function dcTables(lines) {
  const tables = [];
  const row = (line) => /^\s*\|.*\|\s*$/.test(line || "");
  const divider = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line || "") && (line || "").includes("-");
  const split = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  for (let at = 0; at < lines.length; at++) {
    if (!row(lines[at]) || !divider(lines[at + 1])) continue;
    const header = split(lines[at]);
    const rows = [];
    at += 2;
    while (at < lines.length && row(lines[at])) rows.push(split(lines[at++]));
    tables.push({ header, rows });
  }
  return tables;
}

function dcInline(text) {
  return dcEscape(String(text ?? ""))
    .replace(/`([^`]+)`/g, (_, code) => `<code class="dc-code">${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*(\w[^*\n]*)\*/g, "$1<em>$2</em>");
}

function dcEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
