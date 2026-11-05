import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * `public/app.js` is a plain browser script, so it is loaded here against a
 * stub DOM and its renderer pulled out. That keeps the page's own code under
 * test rather than a copy of it.
 */
function loadPage(): { renderMarkdown: (markdown: string) => string; matrixOnly: (markdown: string) => string; uiOnly: (markdown: string) => string; shotScore: (shot: any, card: any) => number; CITATION: RegExp } {
  const source = readFileSync(path.join(root, "public/app.js"), "utf8");
  const element = new Proxy(
    {
      addEventListener() {},
      querySelectorAll: () => [],
      append() {},
      scrollIntoView() {},
      classList: { add() {}, remove() {} },
      dataset: {},
      style: {},
      innerHTML: "",
      textContent: "",
      hidden: false,
    },
    { get: (target: any, key) => (key in target ? target[key] : () => element) },
  );
  const document = { querySelector: () => element, createElement: () => element };
  const factory = new Function(
    "document",
    `${source}\nreturn { renderMarkdown, matrixOnly, uiOnly, shotScore, CITATION };`,
  ) as (document: unknown) => { renderMarkdown: (markdown: string) => string; matrixOnly: (markdown: string) => string; uiOnly: (markdown: string) => string; shotScore: (shot: any, card: any) => number; CITATION: RegExp };
  return factory(document);
}

const { renderMarkdown, matrixOnly, uiOnly, shotScore, CITATION } = loadPage();

test("section 1 keeps only the matrix, dropping prose around it", () => {
  const trimmed = matrixOnly(
    [
      "### 1. Business Logic Difference Matrix",
      "",
      "Here is what differs.",
      "",
      "| ID | Business Area | Android Behavior | iOS Behavior | Business Impact | Severity | Confidence |",
      "|---|---|---|---|---|---|---|",
      "| BL-01 | Bills listed | Keeps all | Drops some | Missing bills | High | Confirmed |",
      "",
      "The fixes need regression tests for:",
      "",
      "- BL-01: a list-builder test.",
    ].join("\n"),
  );
  assert.match(trimmed, /\| BL-01 \|/);
  assert.doesNotMatch(trimmed, /Here is what differs/);
  assert.doesNotMatch(trimmed, /regression tests/);
  assert.doesNotMatch(trimmed, /list-builder/);
});

test("a section 1 with no table is left as written", () => {
  const text = "### 1. Business Logic Difference Matrix\n\nNo differences found.";
  assert.equal(matrixOnly(text), text);
});

function citations(text: string): string[] {
  CITATION.lastIndex = 0;
  return [...text.matchAll(CITATION)].map((match) => match[0]);
}

test("the difference matrix becomes one card per finding", () => {
  const html = renderMarkdown(
    [
      "### 1. Business Logic Difference Matrix",
      "",
      "| ID | Business Area | Android Behavior | iOS Behavior | Business Impact | Severity | Confidence |",
      "|---|---|---|---|---|---|---|",
      "| BL-01 | Account eligibility | Keeps errored accounts (`A.kt:12`) | Drops them (`B.swift:34`) | Different accounts offered | High | Confirmed |",
      "| BL-02 | Sort order | Sorts by popularity | Sorts by relevance | Different first result | Medium | Potential |",
    ].join("\n"),
  );
  // Only High findings are shown; the Medium one is counted, not drawn.
  assert.equal(html.match(/<article class="finding/g)?.length, 1);
  assert.doesNotMatch(html, /<table>/);
  assert.match(html, /<span class="finding-id">BL-01<\/span>/);
  assert.match(html, /<h3>Account eligibility<\/h3>/);
  assert.match(html, /class="finding sev-high"/);
  assert.match(html, /class="badge sev-high">High</);
  assert.match(html, /class="badge confidence">Confirmed</);
  assert.match(html, /<h4>Android<\/h4><p>Keeps errored accounts/);
  assert.match(html, /<h4>iOS<\/h4><p>Drops them/);
  assert.match(html, /<strong>Impact<\/strong> Different accounts offered/);
  assert.doesNotMatch(html, /class="finding sev-medium"/);
  assert.doesNotMatch(html, /BL-02/);
  assert.doesNotMatch(html, /not shown/);
});

test("a matrix with no High finding says so", () => {
  const html = renderMarkdown(
    [
      "| ID | Business Area | Android Behavior | iOS Behavior | Business Impact | Severity | Confidence |",
      "|---|---|---|---|---|---|---|",
      "| BL-01 | Sort order | Popularity | Relevance | Different first result | Low | Potential |",
      "| BL-02 | Copy | Says Buy | Says Get | Wording differs | Medium | Confirmed |",
    ].join("\n"),
  );
  assert.doesNotMatch(html, /<article class="finding/);
  assert.match(html, /class="matrix-hidden">No High differences\.<\/p>/);
});

test("an empty side reads as nothing rather than a blank cell", () => {
  const html = renderMarkdown(
    [
      "| ID | Business Area | Android Behavior | iOS Behavior | Business Impact | Severity | Confidence |",
      "|---|---|---|---|---|---|---|",
      "| BL-03 | Retry | Retries twice | - | No recovery on iOS | High | Missing Implementation |",
    ].join("\n"),
  );
  assert.match(html, /<h4>iOS<\/h4><p><em>Nothing on this side\.<\/em><\/p>/);
  assert.match(html, /class="badge confidence">Missing Implementation</);
});

test("any other table still renders as a table", () => {
  const html = renderMarkdown(
    ["| Scenario | Verdict |", "|---|---|", "| Empty result | Equivalent |"].join("\n"),
  );
  assert.match(html, /<table>/);
  assert.match(html, /<th>Scenario<\/th>/);
  assert.match(html, /<td>Equivalent<\/td>/);
  assert.doesNotMatch(html, /<article class="finding/);
});

test("renders headings, lists, emphasis, code and rules", () => {
  const html = renderMarkdown(
    [
      "# Business logic audit — Catalog",
      "",
      "A **Confirmed Mismatch** in `CatalogApi`.",
      "",
      "- Android sends `sort=popularity`",
      "- iOS sends `sort=relevance`",
      "",
      "1. Align the default",
      "2. Add a regression test",
      "",
      "---",
      "",
      "> Coverage is partial.",
    ].join("\n"),
  );
  assert.match(html, /<h1>Business logic audit — Catalog<\/h1>/);
  assert.match(html, /<strong>Confirmed Mismatch<\/strong>/);
  assert.match(html, /<code>CatalogApi<\/code>/);
  assert.match(html, /<ul><li>Android sends <code>sort=popularity<\/code><\/li>/);
  assert.match(html, /<ol><li>Align the default<\/li>/);
  assert.match(html, /<hr \/>/);
  assert.match(html, /<blockquote><p>Coverage is partial\.<\/p><\/blockquote>/);
});

test("renders a fenced code block and keeps its language", () => {
  const html = renderMarkdown(['```kotlin', 'val sort = "popularity"', "```"].join("\n"));
  assert.match(html, /class="code-block"/);
  assert.match(html, /<span>kotlin<\/span>/);
  assert.match(html, /popularity/);
});

test("finds every citation shape a report uses", () => {
  // The row the audit produced for Flow offers, verbatim.
  const row =
    "AccountStore.getValidAccounts() → FlowOffersAccountFilter → eligibleFlowOffersAccounts " +
    "(feature/common/.../AccountData.kt:124-129)    GlobalDataStore.linkedAccountCards() → " +
    "flowOffersReadyAccounts (LOB resolved) (GlobalDataStore.swift:358-365; FlowOffersViewModel.swift:418-420)";
  assert.deepEqual(citations(row), [
    "feature/common/.../AccountData.kt:124-129",
    "GlobalDataStore.swift:358-365",
    "FlowOffersViewModel.swift:418-420",
  ]);
});

test("a citation can be a single line, and prose is left alone", () => {
  assert.deepEqual(citations("see `src/main/java/com/core/Api.kt:91` for the guard"), [
    "src/main/java/com/core/Api.kt:91",
  ]);
  assert.deepEqual(citations("AccountData.kt and CatalogApi.kt differ"), []);
  assert.deepEqual(citations("version 1.2:30 of the spec"), []);
});

test("model output cannot inject markup", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script&gt;/);
});

// The call-analysis skill is archived, but reports saved while it ran still render.
test("saved API Call Analysis rows become API cards, flagged by verdict", () => {
  const html = renderMarkdown(
    [
      "### 3. API Call Analysis",
      "",
      "| ID | API | Android Calls | iOS Calls | Trigger | Worst Case | Verdict | Risk |",
      "|---|---|---|---|---|---|---|---|",
      "| API-01 | GET /v1/accounts | 1× on open (`A.kt:12`) | 1× per body eval (`B.swift:40`) | Screen opens | unbounded — every state change | Re-entrant Render | Retries forever while the screen is up |",
      "| API-02 | GET /v1/offers | 1× on open (`C.kt:20`) | Not called | Screen opens | 1 | Necessary | Guarded by an in-flight flag |",
    ].join("\n"),
  );
  assert.equal(html.match(/<article class="finding api-call/g)?.length, 2);
  assert.doesNotMatch(html, /<table>/);
  assert.match(html, /<span class="finding-id">API-01<\/span>/);
  assert.match(html, /<code>GET \/v1\/accounts<\/code>/);
  assert.match(html, /api-call api-problem/);
  assert.match(html, /class="badge verdict-problem">Re-entrant Render</);
  assert.match(html, /<strong>Trigger<\/strong> Screen opens/);
  assert.match(html, /class="worst unbounded">unbounded — every state change</);
  assert.match(html, /<strong>Risk<\/strong> Retries forever/);
  // A sound call is marked as such, and its risk cell reads as what bounds it.
  assert.match(html, /api-call api-ok/);
  assert.match(html, /class="badge verdict-ok">Necessary</);
  assert.match(html, /<strong>Bounded by<\/strong> Guarded by an in-flight flag/);
  assert.match(html, /side side-none"><h4>iOS<\/h4><p>Not called/);
  assert.doesNotMatch(html, /class="worst unbounded">1</);
});

test("a saved API Call Analysis summary table stays a table", () => {
  const html = renderMarkdown(
    [
      "| Platform | Distinct endpoints | Calls in a typical pass | Worst case | Unnecessary | Unpredictable |",
      "|---|---|---|---|---|---|",
      "| Android | 3 | 4 | 6 | 1 | 0 |",
      "| iOS | 2 | 2 | unbounded | 0 | 1 |",
    ].join("\n"),
  );
  assert.match(html, /<table>/);
  assert.match(html, /<th>Distinct endpoints<\/th>/);
  assert.doesNotMatch(html, /<article class="finding/);
});

test("api-skill drift tables tint contract values and drift tags", () => {
  const html = renderMarkdown(
    [
      "| Path | Contract | Drift | Android extra | iOS extra | Android body | iOS body | Notes |",
      "|------|----------|-------|---------------|-----------|--------------|----------|-------|",
      "| `topup` | **Drift** | `BODY`, `TYPE`, `HDR` | `+ lob` | `+ lob` | msisdn Long | msisdn optional | — |",
      "| `plan-catalog` | **Same** | — | *baseline* | *baseline* | msisdn, zone | msisdn, zone | — |",
      "| `PA/sigma/widget-url` | **Android only** | `ROUTE` | `+ lob` | — | SigmaSessionRequest | — | — |",
      "",
      "| Header | Android | iOS | Status | Tag |",
      "|--------|---------|-----|--------|-----|",
      "| `uid` | uid | UID | Drift | `CASE` |",
      "| `OSNAME` | Android | iOS | A only | — |",
    ].join("\n"),
  );
  assert.equal(html.match(/<table>/g)?.length, 2);
  assert.match(html, /class="badge contract-drift">Drift</);
  assert.match(html, /class="badge contract-same">Same</);
  assert.match(html, /class="badge contract-android">Android only</);
  assert.match(html, /class="badge contract-android">A only</);
  assert.match(html, /class="badge drift-body">BODY<\/span> <span class="badge drift-type">TYPE<\/span> <span class="badge drift-hdr">HDR</);
  assert.match(html, /class="badge drift-case">CASE</);
  assert.match(html, /<em>baseline<\/em>/);
  // A cell that is not a known value is left as written.
  assert.match(html, /<td>msisdn Long<\/td>/);
});

const UI_HEADER = [
  "| ID | Screen | Pairing | Android Elements | iOS Elements | Matched | Divergent | Join Key | Largest Difference |",
  "|---|---|---|---|---|---|---|---|---|",
];

function uiTable(...rows: string[]): string {
  return [...UI_HEADER, ...rows].join("\n");
}

test("only screens that differ are shown, each as its name and biggest difference", () => {
  const html = renderMarkdown(
    uiTable(
      "| UI-01 | Big ↔ Big | Paired | 40 | 40 | 38 | 2 | Figma 15248:80432 | Copy differs (`A.kt:12`) |",
      "| UI-02 | Same ↔ Same | Paired | 10 | 10 | 10 | 0 | a11y ids | Nothing differs |",
      "| UI-03 | Orphan | Android only | 12 | 0 | 0 | 0 | — | iOS has no counterpart (`C.kt:9`) |",
    ),
  );
  assert.equal(html.match(/<article class="ui-diff"/g)?.length, 2);
  assert.match(html, /<h3>Big ↔ Big<\/h3>/);
  assert.match(html, /<strong>Biggest<\/strong> Copy differs/);
  assert.match(html, /<h3>Orphan<\/h3>/, "a screen on one platform only differs too");
  assert.doesNotMatch(html, /Same ↔ Same/, "a screen that agrees is left out");
  // No visible id, percentage, counts or join key.
  assert.doesNotMatch(html.replace(/<[^>]+>/g, " "), /UI-01|%|element slot|Join key|Slots/);
  assert.doesNotMatch(html, /ui-total|ui-pct/);
  assert.match(html, /<div class="ui-shots" hidden><\/div>/);
});

test("a row without four whole numbers is left out, not coerced", () => {
  const html = renderMarkdown(
    uiTable(
      "| UI-01 | A ↔ B | Paired | 20 | 20 | 10 | 0 | a11y ids | Half the slots are one-sided |",
      "| UI-02 | Guessy | Paired | ~12 | 12 | 6 | 0 | control shape | Counts not settled |",
      "| UI-03 | Impossible | Paired | 5 | 5 | 9 | 0 | a11y ids | Matched exceeds both sides |",
    ),
  );
  assert.equal(html.match(/<article class="ui-diff"/g)?.length, 1);
  assert.doesNotMatch(html, /Guessy|Impossible/);
});

test("a section where every screen agrees says so", () => {
  const html = renderMarkdown(uiTable("| UI-01 | A ↔ B | Paired | 4 | 4 | 4 | 0 | a11y ids | None |"));
  assert.match(html, /No screen differs\./);
  assert.doesNotMatch(html, /<article/);
});

test("pairing is read from the counts, so an odd label cannot drop a screen", () => {
  const html = renderMarkdown(
    uiTable(
      "| UI-01 | A + B ↔ C | Many to one | 20 | 10 | 10 | 0 | Figma 1:2 | Android splits the flow |",
      "| UI-02 | D ↔ E |  | 10 | 10 | 10 | 5 | a11y ids | Copy differs |",
    ),
  );
  assert.equal(html.match(/<article class="ui-diff"/g)?.length, 2);
});

test("section 2 keeps only its heading and the per-screen table", () => {
  const trimmed = uiOnly(
    [
      "### 2. UI Difference",
      "",
      "These counts show how many slots each team tagged.",
      "",
      "| Platform | Screens in nav registry | Screens rowed | Screens with no counterpart | Elements counted |",
      "|---|---|---|---|---|",
      "| Android | 2 | 3 | 0 | 102 |",
      "",
      ...UI_HEADER,
      "| UI-01 | A ↔ B | Paired | 20 | 20 | 10 | 2 | a11y ids | Differs |",
      "",
      "**UI-01 — Bill history list (A ↔ B)**",
      "",
      "| Slot | Type | Android | iOS | State |",
      "|---|---|---|---|---|",
      "| Title | title | Bill history | Bill history | same |",
      "",
      "Notes on what was excluded:",
      "- HistoryRoute was left out.",
    ].join("\n"),
  );
  assert.match(trimmed, /^### 2\. UI Difference/);
  assert.match(trimmed, /\| UI-01 \| A ↔ B \|/);
  for (const gone of ["These counts", "Screens in nav registry", "Bill history list", "| Slot |", "Notes on what", "HistoryRoute"]) {
    assert.ok(!trimmed.includes(gone), `should drop ${gone}`);
  }
});

test("each screen's layout comes back with only its divergent rows", () => {
  const trimmed = uiOnly(
    [
      "### 2. UI Difference",
      "",
      ...UI_HEADER,
      "| UI-01 | A ↔ B | Paired | 20 | 20 | 10 | 2 | a11y ids | Differs |",
      "| UI-02 | C ↔ D | Paired | 5 | 5 | 5 | 1 | a11y ids | Differs |",
      "",
      "**UI-01 — Bill history list (A ↔ B)**",
      "",
      "| Slot | Type | Android | iOS | State |",
      "|---|---|---|---|---|",
      "| Screen title | title | Bill history | Bill history | same |",
      "| Back icon | icon | Back arrow | — | android-only |",
      "| Subtitle | text | Hub copy | CTA copy | divergent |",
      "| Account header | button | Always shown | Only when >1 | divergent |",
      "",
      "**UI-02 — Picker (C ↔ D)**",
      "",
      "| Slot | Type | Android | iOS | State |",
      "|---|---|---|---|---|",
      "| Title | title | Pick | Pick | same |",
    ].join("\n"),
  );
  assert.match(trimmed, /^#### UI-01 — Bill history list \(A ↔ B\)$/m);
  assert.match(trimmed, /\| Subtitle \|/);
  assert.match(trimmed, /\| Account header \|/);
  assert.doesNotMatch(trimmed, /Screen title|Back icon/, "same and one-sided rows are dropped");
  assert.doesNotMatch(trimmed, /UI-02 — Picker/, "a layout with nothing divergent is dropped");
  const html = renderMarkdown(trimmed);
  assert.match(html, /<h4>UI-01 — Bill history list/);
  assert.match(html, /2 slots differ/);
  assert.match(html, /data-id="UI-01"/);
});

test("a screen name cannot inject markup", () => {
  const html = renderMarkdown(
    uiTable('| UI-01 | <script>alert(1)</script> | Paired | 4 | 4 | 4 | 2 | a11y ids | None |'),
  );
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script&gt;/);
});

test("a frame lands on the screen it was rendered from, on its own platform's side", () => {
  const card = (screen: string, biggest: string) => ({ dataset: { screen, biggest } });
  const list = card(
    "BillHistoryRoute ↔ billHistoryInvoiceList (BillHistoryInvoiceListView)",
    "Android shows an empty state (`LLA-SuperApp-iOS/Modules/BillHistory/Views/BillHistoryInvoiceListView.swift:430`), `feature/bill/component/HistoryFlowContent.kt:141`",
  );
  const sheet = card("InvoiceDetailsRoute ↔ BillHistoryInvoiceDetailSheet (billHistoryInvoiceDetail)", "Download control differs");
  const picker = card("BillHistoryAccountPickerBottomSheet ↔ BillHistoryAccountPickerSheet", "Row order differs");
  const shot = (file: string, source: string, platform = "android") => ({ file, source, platform });
  const best = (frame: ReturnType<typeof shot>) => {
    const scores = [list, sheet, picker].map((target) => shotScore(frame, target));
    const top = Math.max(...scores);
    return top > 0 ? ["list", "sheet", "picker"][scores.indexOf(top)] : "none";
  };
  const billScreen = "feature/bill/history/presentation/BillHistoryScreen.kt";
  assert.equal(best(shot("bill_history_list.png", billScreen)), "list");
  assert.equal(best(shot("bill_history_loading.png", billScreen)), "list");
  assert.equal(best(shot("bill_history_empty.png", billScreen)), "list");
  // A frame of another module's screen matches none of these.
  assert.equal(best(shot("payment_history_list.png", "feature/bill/history/presentation/PaymentHistoryScreen.kt")), "none");
  // iOS frames are matched against the iOS side.
  assert.equal(best(shot("invoice_list.png", "LLA-SuperApp-iOS/Modules/BillHistory/Views/BillHistoryInvoiceListView.swift", "ios")), "list");
  // With no known source, a frame needs most of its name on the right side.
  assert.equal(best(shot("bill_history_account_picker.png", "")), "picker");
  assert.equal(best(shot("receipt.png", "")), "none");
});

test("the layout view draws slots as aligned columns, not a table", () => {
  const html = renderMarkdown(
    [
      "| Slot | Type | Android | iOS | State |",
      "|---|---|---|---|---|",
      "| Screen title | title | Flow Offers | Flow Offers | same |",
      "| Mascot message | text | Listing description | Intro line 1 | divergent |",
      "| Account chevron | icon | Chevron right | Chevron down | divergent |",
      "| Offer row — Explore | link | Always tappable | Disabled when unroutable | divergent |",
      "| Close button | button | — | Navigation close | iOS-only |",
    ].join("\n"),
  );
  assert.doesNotMatch(html, /<table>/);
  assert.match(html, /class="layout"/);
  assert.match(html, /Reconstructed from source — not a screenshot/);
  assert.match(html, /4 slots differ/);
  assert.match(html, /<h5>Android<\/h5>/);
  assert.match(html, /<h5>iOS<\/h5>/);
  assert.equal(html.match(/class="slot slot-divergent"/g)?.length, 6);
  // An em dash on one side reads as absent, in place, rather than blank.
  assert.match(html, /slot slot-ios-only slot-absent">\s*<span class="slot-glyph">▬<\/span>\s*<span class="slot-text"><em>not here<\/em>/);
});

test("the layout view is not confused with the scored ui table", () => {
  const layout = renderMarkdown(
    ["| Slot | Type | Android | iOS | State |", "|---|---|---|---|---|", "| Title | title | A | B | same |"].join("\n"),
  );
  assert.doesNotMatch(layout, /ui-total/);
  assert.doesNotMatch(layout, /<article class="finding/);

  const scored = renderMarkdown(uiTable("| UI-01 | A ↔ B | Paired | 4 | 4 | 4 | 0 | a11y ids | None |"));
  assert.doesNotMatch(scored, /class="layout"/);
});

test("a layout cell cannot inject markup", () => {
  const html = renderMarkdown(
    ["| Slot | Type | Android | iOS | State |", "|---|---|---|---|---|", "| X | text | <script>alert(1)</script> | B | same |"].join("\n"),
  );
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script&gt;/);
});
