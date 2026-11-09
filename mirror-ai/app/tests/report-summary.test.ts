import assert from "node:assert/strict";
import { test } from "node:test";
import { coverageOf, fingerprint, statusOf, summarizeReport } from "../src/report-summary.ts";
import { REPORT_A } from "./fixtures/parity-report.ts";


test("business-logic rows, UI, hard-coded copy and API drift are counted per module", () => {
  const summary = summarizeReport(REPORT_A);
  assert.deepEqual(summary.modules.map((module) => module.label), ["Awards", "Bill payment", "Miscellaneous"]);
  const awards = summary.modules[0];
  assert.equal(awards.findings.filter((item) => item.kind === "business-logic").length, 3);
  assert.deepEqual(awards.counts, { high: 2, highConfirmed: 1, medium: 2, low: 2, apiDrift: 2, uiDivergent: 1, hardcodedCopy: 3 });
  assert.equal(awards.coverage, 1);
  assert.deepEqual(awards.incompleteSections, []);
  // High potential 5 + Medium confirmed 4 + Low req-gap 0.3 + UI Low potential 0.5 + API high-risk 10 + API drift Medium potential 2 + 3×0.25
  assert.equal(awards.score, Math.round((100 - (5 + 4 + 0.3 + 0.5 + 10 + 2 + 0.75)) * 10) / 10);
  assert.equal(awards.status, "red", "a confirmed High (the API high-risk row) makes the module red");
});

test("a module whose sections could not be produced is unscored and grey, not 100", () => {
  const bill = summarizeReport(REPORT_A).modules[1];
  assert.equal(bill.score, null);
  assert.equal(bill.status, "grey");
  assert.deepEqual(bill.incompleteSections, ["bl", "ui"]);
});

test("Miscellaneous is listed but kept out of the app score", () => {
  const summary = summarizeReport(REPORT_A);
  const misc = summary.modules[2];
  assert.equal(misc.miscellaneous, true);
  assert.equal(misc.counts.highConfirmed, 1);
  assert.equal(summary.score, summary.modules[0].score, "only Awards is scored: Bill payment failed, Miscellaneous is separate");
});

test("fingerprints follow the cited files, not the renumbered id or reworded area", () => {
  const first = summarizeReport(REPORT_A).modules[0].findings[0];
  const reworded = summarizeReport(
    REPORT_A.replace("| BL-01 | B2B user AWARDS entry |", "| BL-04 | B2B user loyalty entry gating |"),
  ).modules[0].findings.find((item) => item.id === "BL-04")!;
  assert.equal(reworded.fingerprint, first.fingerprint);
  assert.notEqual(fingerprint("awards", "business-logic", "x", ["a.kt"]), fingerprint("awards", "business-logic", "x", ["b.kt"]));
  assert.equal(fingerprint("awards", "business-logic", "Same Area!", []), fingerprint("awards", "business-logic", "same area", []));
});

test("coverage and status thresholds", () => {
  assert.equal(coverageOf(["> **Budget audit coverage** — x scanned 99/102 matching Android and 36/54 matching iOS source files"]), 0.865);
  assert.equal(coverageOf(["no note"]), null);
  const counts = { high: 0, highConfirmed: 0, medium: 0, low: 0, apiDrift: 0, uiDivergent: 0, hardcodedCopy: 0 };
  assert.equal(statusOf({ score: 95, counts, coverage: 1, incomplete: false }), "green");
  assert.equal(statusOf({ score: 75, counts, coverage: 1, incomplete: false }), "amber");
  assert.equal(statusOf({ score: 55, counts, coverage: 1, incomplete: false }), "red");
  assert.equal(statusOf({ score: 95, counts: { ...counts, high: 1 }, coverage: 1, incomplete: false }), "amber");
  assert.equal(statusOf({ score: 95, counts, coverage: 0.5, incomplete: false }), "grey");
});
