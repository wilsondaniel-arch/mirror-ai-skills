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
