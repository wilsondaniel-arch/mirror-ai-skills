import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildIndex, writeDashboard, type RunMeta } from "../src/dashboard.ts";
import { summarizeReport } from "../src/report-summary.ts";
import { REPORT_A } from "./fixtures/parity-report.ts";

const NOW = new Date("2026-11-09T12:00:00Z");

function tree(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "mirror-dash-")), "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "apps.json"),
    JSON.stringify([
      { id: "panama", name: "Panama", market: "panama" },
      { id: "caribbean", name: "Caribbean SuperApp", market: "superapp-caribbean" },
    ]),
  );
  return dir;
}

function addRun(dir: string, app: string, folder: string, markdown: string, meta: Partial<RunMeta>): void {
  const run = path.join(dir, app, folder);
  mkdirSync(run, { recursive: true });
  writeFileSync(path.join(run, "parity-report.md"), markdown);
  writeFileSync(path.join(run, "summary.json"), JSON.stringify(summarizeReport(markdown)));
  writeFileSync(path.join(run, "run.json"), JSON.stringify({ app, scope: "modules", ...meta }));
}

const awardsOnly = REPORT_A.split("\n---\n")[0];
const awardsFixed = awardsOnly.replace(/\| BL-01 \|.*\n/, ""); // the High finding is gone

test("apps are listed alphabetically, including apps with no runs yet", () => {
  const dir = tree();
  addRun(dir, "caribbean", "2026-11-07_0800_awards", awardsOnly, { date: "2026-11-07T08:00:00Z", modules: ["AWARDS"] });
  const index = buildIndex(dir, NOW);
  assert.deepEqual(index.apps.map((app) => app.id), ["caribbean", "panama"]);
  assert.equal(index.apps[1].runs.length, 0);
  assert.equal(index.apps[1].status, "grey");
});

test("later runs replace module state, failed runs never do, and diffs count resolved findings", () => {
  const dir = tree();
  addRun(dir, "caribbean", "2026-11-05_0700_project", REPORT_A, { date: "2026-11-05T07:00:00Z", scope: "project" });
  addRun(dir, "caribbean", "2026-11-06_0700_failed", REPORT_A.replace(/### 1\. Business Logic Difference Matrix\n\n\| ID[\s\S]*?(?=\n> \*\*Budget)/, "### 1. Business Logic Difference Matrix\n\n**This section could not be produced.** limit"), { date: "2026-11-06T07:00:00Z", modules: ["AWARDS"] });
  addRun(dir, "caribbean", "2026-11-07_0700_fixed", awardsFixed, { date: "2026-11-07T07:00:00Z", modules: ["AWARDS"] });
  const app = buildIndex(dir, NOW).apps[0];
  assert.equal(app.runs.length, 3);
  assert.deepEqual(app.runs[1].failedModules, ["awards", "billpayment"], "the failed run is recorded");
  const awards = app.modules.find((state) => state.key === "awards")!;
  assert.equal(awards.run, "2026-11-07_0700_fixed");
  assert.equal(app.runs[2].resolved, 1, "BL-01 was fixed");
  assert.equal(app.runs[2].new, 0);
  assert.ok(app.miscellaneous, "Miscellaneous from the project run is kept");
  assert.equal(app.modules.some((state) => state.key === "billpayment"), false, "a module never produced has no state");
  assert.ok(app.score! > app.runs[0].appScore!, "fixing a High raises the app score");
  assert.equal(app.previousScore, app.runs[1].appScore);
});

test("an app with no run in 14 days is grey (stale)", () => {
  const dir = tree();
  addRun(dir, "caribbean", "2026-10-01_0800_awards", awardsFixed, { date: "2026-10-01T08:00:00Z" });
  assert.equal(buildIndex(dir, NOW).apps[0].stale, true);
  assert.equal(buildIndex(dir, NOW).apps[0].status, "grey");
});

test("writeDashboard writes the top-level files, and --app-only touches only that app's README", () => {
  const dir = tree();
  addRun(dir, "caribbean", "2026-11-07_0800_awards", awardsOnly, { date: "2026-11-07T08:00:00Z", jiraKey: "TER-1", jiraUrl: "https://x/browse/TER-1" });
  writeDashboard(dir, { app: "caribbean", appOnly: true, now: NOW });
  assert.match(readFileSync(path.join(dir, "caribbean", "README.md"), "utf8"), /# Caribbean SuperApp — Mirror AI parity/);
  assert.throws(() => readFileSync(path.join(dir, "README.md")), "top-level files are left to the main-branch job");
  writeDashboard(dir, { now: NOW });
  const readme = readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /\| \[Caribbean SuperApp\]\(caribbean\/README.md\) \| 🔴 At risk \|/);
  assert.match(readme, /\| Panama \| ⚪ Incomplete \/ stale \|/);
  assert.match(readme, /\[TER-1\]\(https:\/\/x\/browse\/TER-1\)/);
  const html = readFileSync(path.join(dir, "dashboard.html"), "utf8");
  assert.match(html, /<title>Mirror AI Parity Dashboard<\/title>/);
  assert.match(html, /const D=\{"version":1/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")).apps.length, 2);
});
