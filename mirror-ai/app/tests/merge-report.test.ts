import assert from "node:assert/strict";
import { test } from "node:test";
import { incompleteModuleKeys, mergeReports, splitModules } from "../src/merge-report.ts";

const failed = (label: string) =>
  `# Business logic audit — ${label}\n\n### 1. Business Logic Difference Matrix\n\n**This section could not be produced.** The verify step failed (limit).`;
const done = (label: string, row: string) =>
  `# Business logic audit — ${label}\n\n### 1. Business Logic Difference Matrix\n\n| ID | Area |\n|---|---|\n| BL-01 | ${row} |\n\n---\n\ninner rule kept`;

const BASE = [done("Awards", "a"), failed("Ussd payg"), done("Topup", "t"), failed("Miscellaneous")].join("\n\n---\n\n") + "\n";

test("modules split on their headings, rules inside a module stay with it", () => {
  const { modules } = splitModules(BASE);
  assert.deepEqual(modules.map((block) => block.label), ["Awards", "Ussd payg", "Topup", "Miscellaneous"]);
  assert.match(modules[0].markdown, /inner rule kept$/);
});

test("redone modules replace the unfinished ones in place, order kept", () => {
  const redone = [done("Ussd payg", "u"), done("Miscellaneous", "m")].join("\n\n---\n\n");
  const merged = mergeReports(BASE, redone);
  assert.deepEqual(merged.replaced, ["Ussd payg", "Miscellaneous"]);
  assert.deepEqual(merged.stillFailed, []);
  assert.deepEqual(splitModules(merged.markdown).modules.map((block) => block.label), ["Awards", "Ussd payg", "Topup", "Miscellaneous"]);
  assert.doesNotMatch(merged.markdown, /could not be produced/);
  assert.match(merged.markdown, /\| BL-01 \| a \|[\s\S]*\| BL-01 \| u \|[\s\S]*\| BL-01 \| t \|[\s\S]*\| BL-01 \| m \|/);
});

test("a redo that failed again never replaces a finished module", () => {
  const merged = mergeReports(BASE, [failed("Awards"), failed("Ussd payg")].join("\n\n---\n\n"));
  assert.match(merged.markdown, /\| BL-01 \| a \|/);
  assert.deepEqual(merged.stillFailed, ["Ussd payg"]);
});

test("incomplete modules are listed by key, Miscellaneous included", () => {
  assert.deepEqual(incompleteModuleKeys(BASE), ["ussdpayg", "miscellaneous"]);
});
