import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  REPORTS_DIR,
  fingerprint,
  listSavedReports,
  readSavedReport,
  reportKey,
  saveReport,
  type ReportIdentity,
} from "../src/report-store.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const android = path.join(root, "fixtures/android-app");
const ios = path.join(root, "fixtures/ios-app");

function identity(overrides: Partial<ReportIdentity> = {}): ReportIdentity {
  return {
    projectRoot: mkdtempSync(path.join(tmpdir(), "mirror-reports-")),
    androidPath: android,
    iosPath: ios,
    moduleKey: "catalog",
    label: "Catalog",
    prompts: "prompts-v1",
    runner: "cli",
    effort: "high",
    model: "claude-opus-5",
    ...overrides,
  };
}

test("a saved report comes back for the same module, repos and prompts", () => {
  const id = identity();
  try {
    assert.equal(readSavedReport(id), null);
    const file = saveReport(id, "# Business logic audit — Catalog\n\n### 1. Executive Summary", 1234);
    assert.ok(file.includes(REPORTS_DIR), "reports live in the named folder");
    assert.match(path.basename(file), /^catalog--[0-9a-f]{16}\.md$/);

    const saved = readSavedReport(id);
    assert.ok(saved);
    assert.match(saved.markdown, /### 1\. Executive Summary/);
    assert.equal(saved.meta.label, "Catalog");
    assert.equal(saved.meta.durationMs, 1234);
    assert.ok(saved.meta.createdAt);
  } finally {
    rmSync(id.projectRoot, { recursive: true, force: true });
  }
});

test("anything that would change the report changes the key", () => {
  const base = identity();
  const keyOf = (overrides: Partial<ReportIdentity>) => reportKey({ ...base, ...overrides });
  const original = reportKey(base);
  assert.equal(keyOf({}), original, "the same inputs are the same key");
  assert.notEqual(keyOf({ moduleKey: "shop" }), original, "a different module");
  assert.notEqual(keyOf({ prompts: "prompts-v2" }), original, "an edited prompt");
  assert.notEqual(keyOf({ runner: "api" }), original, "a different runner");
  assert.notEqual(keyOf({ effort: "max" }), original, "a different effort");
  assert.notEqual(keyOf({ model: "claude-opus-5-5" }), original, "a different model");
  assert.notEqual(keyOf({ androidPath: ios }), original, "a different checkout");
  rmSync(base.projectRoot, { recursive: true, force: true });
});

test("an edited prompt does not serve the old report", () => {
  const id = identity();
  try {
    saveReport(id, "# old report", 10);
    assert.ok(readSavedReport(id));
    assert.equal(readSavedReport({ ...id, prompts: "prompts-v2" }), null);
  } finally {
    rmSync(id.projectRoot, { recursive: true, force: true });
  }
});

test("the listing shows what was saved, newest first", () => {
  const id = identity();
  try {
    saveReport({ ...id, moduleKey: "catalog", label: "Catalog" }, "# a", 10);
    saveReport({ ...id, moduleKey: "shop", label: "Shop" }, "# b", 20);
    const saved = listSavedReports(id.projectRoot);
    assert.equal(saved.length, 2);
    assert.deepEqual(new Set(saved.map((report) => report.label)), new Set(["Catalog", "Shop"]));
    assert.ok(saved[0].createdAt >= saved[1].createdAt);
  } finally {
    rmSync(id.projectRoot, { recursive: true, force: true });
  }
});

test("a project with no reports folder lists nothing rather than failing", () => {
  assert.deepEqual(listSavedReports(path.join(root, "fixtures")), []);
});

test("a checkout is fingerprinted, and two different ones do not collide", () => {
  const left = fingerprint(android);
  assert.match(left, /^[0-9a-f+]{8,}$/);
  assert.equal(fingerprint(android), left, "stable across calls");
  assert.notEqual(fingerprint(ios), left);
});

test("a hand-mangled sidecar is skipped, not fatal", () => {
  const id = identity();
  try {
    const file = saveReport(id, "# a", 10);
    writeFileSync(file.replace(/\.md$/, ".json"), "{ not json");
    assert.deepEqual(listSavedReports(id.projectRoot), []);
    assert.equal(readSavedReport(id), null);
  } finally {
    rmSync(id.projectRoot, { recursive: true, force: true });
  }
});
