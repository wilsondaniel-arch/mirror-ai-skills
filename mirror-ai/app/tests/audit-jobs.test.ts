import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AuditJobs, type AuditJob } from "../src/audit-jobs.ts";
import type { AuditPass, AuditRequest, PassResult } from "../src/audit.ts";
import type { ModuleDef } from "../src/types.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function request(labels: string[]): AuditRequest {
  return {
    androidPath: path.join(root, "fixtures/android-app"),
    iosPath: path.join(root, "fixtures/ios-app"),
    rows: [],
    defs: labels.map((label) => ({ id: label.toLowerCase(), label, keywords: [label] })),
    projectRoot: root,
    leads: "",
    mode: "module",
  };
}

/** A runner whose passes finish only when the test says so. */
function controlled() {
  const order: string[] = [];
  const pending = new Map<string, (result: PassResult) => void>();
  const run = (_: AuditRequest, def: ModuleDef, pass: AuditPass) =>
    new Promise<PassResult>((resolve) => {
      const key = `${def.label}:${pass.id}`;
      order.push(key);
      pending.set(key, resolve);
    });
  const finish = (key: string, failed = false) => {
    const resolve = pending.get(key);
    assert.ok(resolve, `${key} is not running`);
    pending.delete(key);
    resolve({ markdown: `### ${key}`, cached: false, failed });
  };
  return { run, order, finish };
}

const tick = () => new Promise((done) => setImmediate(done));

function pass(job: AuditJob, module: number, id: string) {
  const found = job.modules[module].passes.find((item) => item.id === id);
  assert.ok(found, `no ${id} pass`);
  return found;
}

test("every module's business logic is queued before any skill", async () => {
  const runner = controlled();
  const jobs = new AuditJobs(runner.run, 1, () => null);
  const job = jobs.start(request(["Catalog", "Feed"]));
  for (let step = 0; step < 6; step++) {
    await tick();
    runner.finish(runner.order[step]);
  }
  await tick();
  assert.deepEqual(runner.order, [
    "Catalog:logic",
    "Feed:logic",
    "Catalog:ui-skill",
    "Feed:ui-skill",
    "Catalog:api-skill",
    "Feed:api-skill",
  ]);
  assert.equal(jobs.status(job.id)?.done, true);
});

test("a section is published the moment it finishes, while the others still run", async () => {
  const runner = controlled();
  const jobs = new AuditJobs(runner.run, 3, () => null);
  const job = jobs.start(request(["Catalog"]));
  await tick();
  assert.equal(pass(job, 0, "logic").state, "running");
  assert.equal(pass(job, 0, "ui-skill").state, "running");
  assert.equal(pass(job, 0, "api-skill").state, "running");

  runner.finish("Catalog:logic");
  await tick();
  assert.equal(pass(job, 0, "logic").state, "done");
  assert.equal(pass(job, 0, "logic").markdown, "### Catalog:logic");
  assert.equal(pass(job, 0, "ui-skill").markdown, undefined, "an unfinished section has nothing to show");
  assert.equal(job.done, false);

  runner.finish("Catalog:api-skill", true);
  runner.finish("Catalog:ui-skill");
  await tick();
  assert.equal(pass(job, 0, "api-skill").state, "failed");
  assert.equal(job.done, true);
});

test("a runner that throws fails its section, not the job", async () => {
  const jobs = new AuditJobs(async (_, __, item) => {
    if (item.id === "ui-skill") throw new Error("boom");
    return { markdown: `### ${item.id}`, cached: true, failed: false };
  }, 3, () => null);
  const job = jobs.start(request(["Catalog"]));
  while (!job.done) await tick();
  assert.equal(pass(job, 0, "ui-skill").state, "failed");
  assert.match(pass(job, 0, "ui-skill").markdown ?? "", /### 2\. UI Difference\n\n\*\*This section could not be produced\.\*\* boom/);
  assert.equal(pass(job, 0, "logic").state, "done");
  assert.equal(job.reference, "");
});

test("saved sections are in the first response, and only the rest run", async () => {
  const runner = controlled();
  const jobs = new AuditJobs(runner.run, 3, (_, __, item) =>
    item.id === "ui-skill" ? null : { markdown: `### saved ${item.id}`, cached: true, at: "2026-10-22T10:00:00Z", failed: false },
  );
  const job = jobs.start(request(["Catalog"]));
  assert.equal(pass(job, 0, "logic").state, "done");
  assert.equal(pass(job, 0, "logic").markdown, "### saved logic");
  assert.equal(pass(job, 0, "logic").cached, true);
  assert.equal(pass(job, 0, "api-skill").state, "done");
  assert.equal(pass(job, 0, "ui-skill").markdown, undefined);
  await tick();
  assert.deepEqual(runner.order, ["Catalog:ui-skill"], "only the unsaved section runs");
  runner.finish("Catalog:ui-skill");
  await tick();
  assert.equal(job.done, true);
});

test("a fully saved audit is done before it starts", () => {
  const jobs = new AuditJobs(
    () => Promise.reject(new Error("nothing should run")),
    3,
    () => ({ markdown: "### saved", cached: true, failed: false }),
  );
  const job = jobs.start(request(["Catalog", "Feed"]));
  assert.equal(job.done, true);
  assert.ok(job.modules.every((module) => module.passes.every((item) => item.state === "done")));
});

test("an unknown job is not found", () => {
  assert.equal(new AuditJobs().status("missing"), null);
});
