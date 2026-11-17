import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReport, renderReportUi, splitCitations } from "../src/report-ui.ts";

const REPORT = `# Business logic audit — Bill payment

### 1. Business Logic Difference Matrix

| ID | Business Area | Android Behavior | iOS Behavior | Business Impact | Severity | Confidence |
|---|---|---|---|---|---|---|
| BL-01 | Retry <b>action</b> | Retries the call (\`app/src/Pay.kt:10-12\`). | Only hides the alert (\`App/Pay.swift:40\`). | No retry on iOS. | High | Confirmed |
| BL-02 | GA item id | Uses \`bill_payment_fixed\`. | — | Analytics differ. | Low | Potential |

### Hard-coded copy on buttons and labels

1 user-visible string(s).

| ID | Screen | Element | Type | Android Text Source | iOS Text Source | Hard-coded On | Citation |
|---|---|---|---|---|---|---|---|
| HC-01 | PayView | Button | button | — | "Pagar" | iOS | \`App/PayView.swift:9\` |

### 3. API Contract Drift

No endpoint resolvable; needs runtime verification.

# Business logic audit — Bill history

### 1. Business Logic Difference Matrix

| ID | Business Area | Android Behavior | iOS Behavior | Business Impact | Severity | Confidence |
|---|---|---|---|---|---|---|
`;

test("parseReport splits modules and sections", () => {
  const { modules } = parseReport(REPORT);
  assert.deepEqual(modules.map((m) => m.name), ["Bill payment", "Bill history"]);
  assert.equal(modules[0].sections.length, 3);
});

test("splitCitations moves source paths out of prose", () => {
  const r = splitCitations("Retries the call (`app/src/Pay.kt:10-12`) and logs `eventName`.");
  assert.deepEqual(r.paths, ["app/src/Pay.kt:10-12"]);
  assert.equal(r.prose, "Retries the call and logs `eventName`.");
});

test("renderReportUi builds tiles, tabs, cards and escapes report text", () => {
  const { html, md } = renderReportUi(REPORT, { meta: { branch: "caribbean/release/sprint-20" } });
  assert.match(html, /data-module="billpayment"/);
  assert.match(html, /data-module="billhistory"/);
  assert.match(html, /id="sec-billpayment-bl"/);
  assert.match(html, /id="sec-billpayment-hc"/);
  assert.match(html, /id="sec-billpayment-api"/);
  assert.match(html, /badge badge-high">High/);
  assert.match(html, /<span class="path" translate="no">app\/src\/Pay.kt:10-12<\/span>/);
  assert.ok(!html.includes("<b>action</b>"), "raw HTML from the report must be escaped");
  assert.match(html, /No iOS counterpart/);
  assert.match(md, /### BL-01 · Retry/);
  assert.match(md, /\| HC-01 \| PayView \| Button \| iOS \| "Pagar" \| PayView.swift:9 \|/);
});

test("a BL row with Android and iOS in one cell keeps severity and confidence", () => {
  const md = `# Business logic audit — Flow offers

### 1. Business Logic Difference Matrix

| ID | Business Area | Android Behavior | iOS Behavior | Business Impact | Severity | Confidence |
|---|---|---|---|---|---|---|
| BL-01 | Offers | Android does X (\`a/A.kt:1\`). iOS does Y (\`b/B.swift:2\`). | Offers differ. | High | Potential |
`;
  const { html, md: out } = renderReportUi(md);
  assert.match(html, /badge badge-high">High/);
  assert.match(html, /Android &amp; iOS/);
  assert.match(html, /<strong>Impact:<\/strong> Offers differ\./);
  assert.match(out, /\*\*High\*\* · Potential/);
});

test("modules render as one dropdown (trigger + flyout), not a scrolling row", () => {
  const md = ["# Business logic audit — Alpha", "", "### 1. Business Logic Difference Matrix", "", "| ID | Area | Android | iOS | Impact | Severity | Confidence |", "|---|---|---|---|---|---|---|", "| BL-01 | A | a | b | c | High | Confirmed |", "", "# Business logic audit — Beta", "", "### 1. Business Logic Difference Matrix", "", "None."].join("\n");
  const { html } = renderReportUi(md);
  assert.match(html, /<button type="button" class="mod-dd-btn" id="mod-dd-btn" aria-haspopup="true" aria-expanded="false"/);
  assert.match(html, /<div class="mod-dd-panel" id="mod-dd-panel" hidden>/);
  assert.match(html, /Modules · 2/);
  // Every module is an item in the flyout, and picking one routes and closes it.
  assert.equal((html.match(/class="mod-tile"/g) ?? []).length, 2);
  assert.match(html, /onclick="pickModule\('alpha'\)"/);
  assert.match(html, /function closeModMenu/);
  assert.match(html, /e\.key === 'Escape'/);
});

test("header: brand left, linked Android/iOS branches, date and ticket right", async () => {
  const { headerMetaHtml } = await import("../src/report-ui.ts");
  const html = headerMetaHtml({
    app: "caribbean",
    androidBranch: "caribbean/release/sprint-20",
    iosBranch: "caribbean/release/sprint-20",
    android: "eab41f7",
    androidCommit: "eab41f748523f14b87e9fa6699cd478fc304670c",
    ios: "0305924",
    date: "2026-11-17",
    jiraKey: "TER-2201",
    jiraUrl: "https://mypaytm.atlassian.net/browse/TER-2201",
  });
  assert.match(html, /href="https:\/\/bitbucket\.org\/paytmteam\/lla-superapp-android\/branch\/caribbean\/release\/sprint-20"/);
  // No commit in the header: branch names only.
  assert.doesNotMatch(html, /eab41f7|0305924|\/commits\/|hm-at/);
  assert.match(html, /href="https:\/\/bitbucket\.org\/paytmteam\/lla-superapp-ios\/branch\/caribbean\/release\/sprint-20"/);
  assert.match(html, />17 Nov 2026</);
  assert.match(html, /<a class="hm-ticket" href="https:\/\/mypaytm\.atlassian\.net\/browse\/TER-2201"[^>]*>TER-2201<\/a>/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  // An explicit repo URL wins; an unknown app with no repo shows plain text, never a guessed link.
  const plain = headerMetaHtml({ app: "unknown", androidBranch: "x/y", jiraKey: "ABC-1", jiraUrl: "javascript:alert(1)" });
  assert.doesNotMatch(plain, /href=/);
  assert.match(plain, /<span class="hm-branch"[^>]*>x\/y<\/span>/);
});

test("run.json repo URLs come from the git remote, credentials dropped", async () => {
  const { repoWebUrl } = await import("../src/run-meta.ts");
  assert.equal(repoWebUrl("git@bitbucket.org:paytmteam/lla_panama_android.git"), "https://bitbucket.org/paytmteam/lla_panama_android");
  assert.equal(repoWebUrl("https://user:tok@bitbucket.org/paytmteam/lla-superapp-ios.git"), "https://bitbucket.org/paytmteam/lla-superapp-ios");
  assert.equal(repoWebUrl("ssh://git@bitbucket.org/paytmteam/networkqoe_ios"), "https://bitbucket.org/paytmteam/networkqoe_ios");
  assert.equal(repoWebUrl(""), undefined);
});

test("the ticket is read from jira-summary.md when run.json has none (publish re-render)", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const { main } = await import("../src/report-ui.ts");
  const dir = mkdtempSync(pathMod.join(tmpdir(), "hdr-"));
  writeFileSync(pathMod.join(dir, "parity-report.md"), "# Business logic audit — Alpha\n\n### 1. Business Logic Difference Matrix\n\nNone.\n");
  writeFileSync(pathMod.join(dir, "run.json"), JSON.stringify({ app: "panama", date: "2026-11-16T11:23:52.961Z", android: { branch: "bug/TER-2187-ai-api-scanning", commit: "ced95f9efb81" }, ios: { branch: "bug/TER-2187-ai-api-scanning", commit: "315b07090ef5" } }));
  writeFileSync(pathMod.join(dir, "jira-summary.md"), "# TER-2198\nhttps://mypaytm.atlassian.net/browse/TER-2198\n");
  await main([dir, "--out", pathMod.join(dir, "r.html"), "--md", pathMod.join(dir, "r.md")]);
  const html = readFileSync(pathMod.join(dir, "r.html"), "utf8");
  assert.match(html, /href="https:\/\/mypaytm\.atlassian\.net\/browse\/TER-2198"/);
  assert.match(html, /lla_panama_android\/branch\/bug\/TER-2187-ai-api-scanning/);
  assert.match(html, />16 Nov 2026</);
});
