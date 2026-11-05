import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { apiDriftScopeNote, readApiDriftWorkflow } from "../src/api-drift-workflow.ts";
import { readAuditSpec, readSkills } from "../src/audit.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("every prompts/skills/*.md is loaded as a skill", () => {
  const skills = readSkills(root);
  const names = skills.map((skill) => skill.name);
  assert.ok(names.includes("api-skill"), `expected api-skill, got ${names.join(", ") || "none"}`);
  const api = skills.find((skill) => skill.name === "api-skill");
  assert.ok(api);
  assert.match(api.text, /### 3\. API Contract Drift/);
});

test("a directory with no skills is not an error", () => {
  assert.deepEqual(readSkills(path.join(root, "fixtures")), []);
});

test("the api-skill keeps the drift workflow's fixed column sets", () => {
  const api = readSkills(root).find((skill) => skill.name === "api-skill");
  assert.ok(api);
  // Dropping Android extra / iOS extra is a failed audit in the source workflow.
  for (const header of [
    "| Path | Contract | Drift | Android extra | iOS extra | Android body | iOS body | Notes |",
    "| Path | Contract | What to check | Drift |",
    "| Header | Android | iOS | Status | Tag |",
    "| Path | Android | iOS | Notes |",
    "| Env | Android | iOS | Match |",
  ]) {
    assert.ok(api.text.includes(header), `api-skill should publish ${header}`);
  }
});

test("the api-skill names every contract value and drift tag the page tints", () => {
  const api = readSkills(root).find((skill) => skill.name === "api-skill");
  assert.ok(api);
  for (const value of ["**Same**", "**Drift**", "**Android only**", "**iOS only**", "`A only`"]) {
    assert.ok(api.text.includes(value), `api-skill should define ${value}`);
  }
  for (const tag of ["BODY", "HDR", "ROUTE", "TYPE", "CASE", "HOST"]) {
    assert.ok(api.text.includes(`\`${tag}\``), `api-skill should define the ${tag} tag`);
  }
});

test("the api-skill keeps the discovery gates", () => {
  const api = readSkills(root).find((skill) => skill.name === "api-skill");
  assert.ok(api);
  for (const gate of ["No template paste", "Inventory sourced", "Baseline identified", "Columns explained"]) {
    assert.ok(api.text.includes(gate), `api-skill should keep the ${gate} gate`);
  }
});

test("the main spec still publishes only its own section", () => {
  const spec = readAuditSpec(root);
  assert.match(spec, /### 1\. Business Logic Difference Matrix/);
  assert.doesNotMatch(spec, /Executive Summary/);
  assert.doesNotMatch(spec, /### 2\./);
  assert.doesNotMatch(spec, /### 3\./);
});

test("skills load in the order of the section they publish, so API drift is last", () => {
  const names = readSkills(root).map((skill) => skill.name);
  assert.deepEqual(names, ["ui-skill", "api-skill"]);
});

test("the superapp-workspace drift workflow ships with Mirror AI for api-skill", () => {
  const workflow = readApiDriftWorkflow(root);
  assert.match(workflow, /API contract drift/);
  assert.match(workflow, /outcome-based discovery/);
  assert.match(apiDriftScopeNote("repository"), /full market/i);
  assert.match(apiDriftScopeNote("module"), /this module only/i);
});

test("api-skill forbids pasting a static market snapshot", () => {
  const api = readSkills(root).find((skill) => skill.name === "api-skill");
  assert.ok(api);
  assert.match(api.text, /Never.*paste inventory/i);
});

test("placeholder for table width check on workflow tables", () => {
  const workflow = readApiDriftWorkflow(root);
  let width = 0;
  for (const line of workflow.split("\n")) {
    if (!line.startsWith("|")) {
      width = 0;
      continue;
    }
    const cells = line.split("|").length;
    if (width === 0) width = cells;
    else assert.equal(cells, width, `row width differs: ${line}`);
  }
});

test("the api-skill omits KPIs, key patterns, and same-only baseline/env rows from the published spec", () => {
  const api = readSkills(root).find((skill) => skill.name === "api-skill");
  assert.ok(api);
  assert.doesNotMatch(api.text, /#### KPIs/);
  assert.doesNotMatch(api.text, /#### Key patterns/);
  assert.match(api.text, /where \*\*Status\*\* is not `Same`/);
  assert.match(api.text, /All configured environments match/);
});

test("the ui-skill declares section 2 and the exact columns the page dispatches on", () => {
  const ui = readSkills(root).find((skill) => skill.name === "ui-skill");
  assert.ok(ui);
  assert.match(ui.text, /### 2\. UI Difference/);
  assert.match(
    ui.text,
    /\| ID \| Screen \| Pairing \| Android Elements \| iOS Elements \| Matched \| Divergent \| Join Key \| Largest Difference \|/,
  );
  assert.match(
    ui.text,
    /\| Platform \| Screens in nav registry \| Screens rowed \| Screens with no counterpart \| Elements counted \|/,
  );
  for (const pairing of ["Paired", "Many-to-one", "Android only", "iOS only"]) {
    assert.ok(ui.text.includes(pairing), `ui-skill should define the ${pairing} pairing`);
  }
});

test("the ui-skill forbids writing a percentage, since the page computes it", () => {
  const ui = readSkills(root).find((skill) => skill.name === "ui-skill");
  assert.ok(ui);
  assert.match(ui.text, /\*\*Do not compute, estimate or state any percentage anywhere in this section\.\*\*/);
  const header = ui.text
    .split("\n")
    .find((line) => line.startsWith("| ID | Screen |"));
  assert.ok(header);
  assert.doesNotMatch(header, /%|percent/i);
});

test("the ui-skill keeps the guard rails that stop the count being wrong", () => {
  const ui = readSkills(root).find((skill) => skill.name === "ui-skill");
  assert.ok(ui);
  // Each of these is a trap a well-meaning edit would quietly drop.
  for (const guard of [
    "RootView.swift",
    "optionalAccessibilityIdentifier",
    "NavKey.kt",
    "flows/flowoffers",
    "tenantKey",
    "entry<",
  ]) {
    assert.ok(ui.text.includes(guard), `ui-skill should still name ${guard}`);
  }
});
