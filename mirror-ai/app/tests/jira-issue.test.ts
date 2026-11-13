import assert from "node:assert/strict";
import { test } from "node:test";
import { buildJiraIssue, type RunMeta, type Summary } from "../src/jira-issue.ts";

const counts = (h: number, m: number, l: number) => ({ high: h, highConfirmed: h, medium: m, low: l, apiDrift: 1, uiDivergent: 0, hardcodedCopy: 3 });
const summary: Summary = {
  totals: { ...counts(2, 3, 1), modules: 2, incompleteModules: 0 },
  score: 55,
  status: "red",
  modules: [
    { key: "topup", label: "Topup", counts: counts(2, 1, 0), score: 10, status: "red", findings: [{ kind: "business-logic", id: "BL-01", area: "Return detail failure", severity: "High", confidence: "Confirmed", files: ["a/Nav.swift"] }] },
    { key: "misc", label: "Miscellaneous", miscellaneous: true, counts: counts(0, 2, 1), score: 80, status: "green", findings: [] },
  ],
};
const run: RunMeta = {
  app: "caribbean", market: "superapp-caribbean", date: "2026-11-13T08:36:03Z", scope: "project", branch: "caribbean/feature/dev",
  android: { branch: "caribbean/feature/dev", commit: "5645efbaf06c" }, ios: { branch: "caribbean/feature/dev", commit: "162a5ff37c16" },
  sessionId: "s-pk1ncqo7nw", reportUrl: "https://example/parity-report.html", reportMdUrl: "https://example/parity-report.md",
};

test("issue says what was audited, where, and links the report", () => {
  const { fields } = buildJiraIssue(summary, run, { project: "TER" });
  const s = JSON.stringify(fields);
  assert.match(String(fields.summary), /^\[superapp-caribbean\] Mirror AI — whole-project parity audit \(2 modules\) @ caribbean\/feature\/dev \(2026-11-13\)$/);
  for (const needle of ["Whole project", "caribbean/feature/dev", "5645efb", "162a5ff", "s-pk1ncqo7nw", "High 2 (2 confirmed)", "Topup BL-01", "https://example/parity-report.html", "\"type\":\"table\""]) assert.ok(s.includes(needle), needle);
  assert.deepEqual((fields.project as { key: string }).key, "TER");
});

test("module scope lists the modules and uses the run's market, not an environment guess", () => {
  const { fields } = buildJiraIssue(summary, { ...run, scope: "modules", modules: ["TOPUP"] });
  assert.match(String(fields.summary), /Topup parity audit/);
  assert.ok(JSON.stringify(fields).includes("Selected modules — Topup"));
  assert.deepEqual(fields.labels, ["mirror-ai", "android-ios-parity", "superapp-caribbean"]);
});
