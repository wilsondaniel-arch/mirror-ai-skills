import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildChunks,
  compactSource,
  focusBody,
  splitSections,
  usageCostUsd,
  type PassSpec,
} from "../src/budget-audit.ts";
import type { RepoSource } from "../src/scan.ts";

test("compactSource drops blanks, imports and comments but keeps original line numbers", () => {
  const text = [
    "package com.example", // 1
    "import foo.Bar", // 2
    "", // 3
    "/* licence", // 4
    " * header */", // 5
    "// a comment", // 6
    "class Pay {", // 7
    "    fun total() = 1 // trailing comment stays", // 8
    "}", // 9
  ].join("\n");
  const { body, lines } = compactSource(text);
  assert.equal(lines, 9);
  assert.deepEqual(body.split("\n").map((line) => line.split("|")[0]), ["7", "8", "9"]);
  assert.match(body, /^8\| fun total\(\)/m);
});

test("focusBody keeps only regions around mentions and names the omitted lines", () => {
  const body = Array.from({ length: 300 }, (_, index) => `${index + 1}|line ${index + 1}${index === 149 ? " AutoPay" : ""}`).join("\n");
  const { body: focused, excerpted } = focusBody(body, ["autopay"]);
  assert.equal(excerpted, true);
  assert.match(focused, /^150\|line 150 AutoPay$/m);
  assert.match(focused, /original lines 1-109 not shown/);
  assert.match(focused, /original lines 191-300 not shown/);
  assert.ok(focused.length < body.length / 2);
});

test("focusBody leaves a file without mentions untouched", () => {
  const body = "1|a\n2|b";
  assert.deepEqual(focusBody(body, ["autopay"]), { body, excerpted: false });
});

function side(platform: "Android" | "iOS", sizes: number[]) {
  const files = sizes.map((size, index) => {
    const source: RepoSource = { relativePath: `${platform}/F${index}.kt`, text: "", lower: "" };
    const body = Array.from({ length: Math.ceil(size / 20) }, (_, line) => `${line + 1}|${"x".repeat(16)}`).join("\n").slice(0, size);
    return { source, body, lines: Math.ceil(size / 20) };
  });
  return { platform, root: "/r", files, matched: files.length };
}

test("buildChunks never exceeds the character budget and reports what it left out", () => {
  const budget = 10_000;
  const { chunks, uninspected } = buildChunks(side("Android", [3000, 3000, 3000, 3000]), side("iOS", [2000, 9000, 1000]), 2, budget);
  assert.ok(chunks.length >= 1 && chunks.length <= 2);
  for (const chunk of chunks) {
    const used = [...chunk.android, ...chunk.ios].reduce((total, file) => total + file.body.length + file.source.relativePath.length + 16, 0);
    assert.ok(used <= budget, `chunk used ${used} > ${budget}`);
    assert.ok(chunk.android.length > 0 || chunk.ios.length > 0);
  }
  const shown = chunks.flatMap((chunk) => [...chunk.android, ...chunk.ios].map((file) => file.source.relativePath));
  const all = [...shown, ...uninspected.android, ...uninspected.ios].sort();
  assert.deepEqual(all, ["Android/F0.kt", "Android/F1.kt", "Android/F2.kt", "Android/F3.kt", "iOS/F0.kt", "iOS/F1.kt", "iOS/F2.kt"]);
  // The 9000-char iOS file is larger than one share of a chunk, so it is cut and says so.
  const big = chunks.flatMap((chunk) => chunk.ios).find((file) => file.source.relativePath === "iOS/F1.kt");
  if (big) assert.ok(big.cutAtLine && big.cutAtLine > 0);
});

test("usageCostUsd prices batch usage with cache reads and writes", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as never;
  // Sonnet 5.5: ($2 + 0.1 * $10) * 50% batch discount.
  assert.equal(usageCostUsd("claude-sonnet-5-5", usage).toFixed(4), "1.5000");
  const cached = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 80_000 } as never;
  // Haiku 5.5 cache read under the 100K tier: 80K * $0.10 * 0.1 * 50%.
  assert.equal(usageCostUsd("claude-haiku-5-5", cached).toFixed(6), "0.000400");
  // Haiku 5.5 above 100K prompt tokens bills the long-context rate.
  const long = { input_tokens: 200_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as never;
  assert.equal(usageCostUsd("claude-haiku-5-5", long).toFixed(4), "0.0500");
  assert.throws(() => usageCostUsd("some-unknown-model", usage), /no price/);
});

const specs: PassSpec[] = [
  { pass: { id: "logic", title: "Business logic", spec: "", firstHeading: "### 1. Business Logic Difference Matrix", publishes: "" }, spec: "" },
  { pass: { id: "ui-skill", title: "UI Difference", spec: "", firstHeading: "### 2. UI Difference", publishes: "" }, spec: "" },
  { pass: { id: "api-skill", title: "API Contract Drift", spec: "", firstHeading: "### 3. API Contract Drift", publishes: "" }, spec: "" },
];

test("splitSections cuts the verifier's report into one section per pass", () => {
  const text = "### 1. Business Logic Difference Matrix\nA\n\n### 2. UI Difference\nB\n\n#### 3. API Contract Drift (partial)\nC";
  const sections = splitSections(text, specs, null, 3);
  assert.equal(sections.logic, "### 1. Business Logic Difference Matrix\nA");
  assert.equal(sections["ui-skill"], "### 2. UI Difference\nB");
  assert.equal(sections["api-skill"], "#### 3. API Contract Drift (partial)\nC");
});

test("splitSections still publishes a heading for a section the verifier left out", () => {
  const sections = splitSections("### 1. Business Logic Difference Matrix\nA", specs, null, 1);
  assert.match(sections["ui-skill"], /^### 2\. UI Difference\n\nThe verifier confirmed no differences/);
  assert.match(sections["api-skill"], /^### 3\. API Contract Drift/);
});
