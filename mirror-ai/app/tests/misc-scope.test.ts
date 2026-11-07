import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rankSide } from "../src/budget-audit.ts";
import { buildModuleCatalog, moduleDefs } from "../src/enums.ts";
import { claims, isTestPath, miscellaneousDef, unclaimedFiles } from "../src/misc-scope.ts";
import { readSources } from "../src/scan.ts";
import { MISC_MODULE_ID } from "../src/types.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const android = path.join(root, "fixtures/android-app");
const ios = path.join(root, "fixtures/ios-app");
const catalog = buildModuleCatalog(android, ios);
const common = moduleDefs(catalog.common);

test("Miscellaneous holds every production file no common module claims", () => {
  const misc = miscellaneousDef(android, ios, common);
  assert.ok(misc, "the fixtures have code outside the common modules");
  assert.equal(misc.id, MISC_MODULE_ID);
  assert.equal(misc.label, "Miscellaneous");
  const needleSets = common.map((def) => def.keywords.map((keyword) => keyword.toLowerCase()));
  for (const [side, rootDir] of [["android", android], ["ios", ios]] as const) {
    const listed: string[] = misc.files?.[side] ?? [];
    const files: Set<string> = new Set(listed);
    // Every production file lands in exactly one place: a common module or Miscellaneous.
    for (const source of readSources(rootDir)) {
      if (isTestPath(source.relativePath)) {
        assert.ok(!files.has(source.relativePath), `${source.relativePath} is a test file`);
        continue;
      }
      const claimed = needleSets.some((needles) => claims(source, needles));
      assert.equal(files.has(source.relativePath), !claimed, source.relativePath);
    }
  }
});

test("platform-only module code no common module mentions falls into Miscellaneous", () => {
  const misc = miscellaneousDef(android, ios, common)!;
  // SHELF is iOS-only in the fixtures and its code names no common module.
  // (Android's CHECKOUT code mentions Shop, so the Shop module already reads it.)
  assert.ok(misc.files!.ios.some((file) => /shelf/i.test(file)), "iOS shelf code is miscellaneous");
});

test("with every module claimed there is no Miscellaneous section", () => {
  const all = moduleDefs([...catalog.common, ...catalog.androidOnly, ...catalog.iosOnly]);
  const everything = [...all, { id: "x", label: "x", keywords: readSources(android).concat(readSources(ios)).map((s) => s.relativePath.toLowerCase()) }];
  assert.equal(unclaimedFiles(android, everything).length, 0);
  assert.equal(miscellaneousDef(android, ios, everything), null);
});

test("the budget runner reads exactly the listed files for Miscellaneous", () => {
  const misc = miscellaneousDef(android, ios, common)!;
  assert.ok(misc.files!.ios.length > 0);
  const side = rankSide("iOS", ios, [], misc.files!.ios);
  assert.deepEqual(side.files.map((file) => file.source.relativePath).sort(), [...misc.files!.ios].sort());
  assert.equal(side.matched, misc.files!.ios.length);
});

/** Runs the CLI against the stub `claude`, reports kept out of the real folder. */
function cli(args: string[]) {
  const reports = mkdtempSync(path.join(tmpdir(), "mirror-ai-reports-"));
  return spawnSync("node", ["--experimental-strip-types", "src/audit-cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(root, "tests/bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      MIRROR_AI_RUNNER: "cli",
      // Its own stub log: audit-cli.test.ts reads tests/.claude-args.log and runs alongside.
      MIRROR_AI_CLI_LOG: path.join(reports, "claude-args.log"),
      MIRROR_AI_REPORTS_DIR: reports,
    },
  });
}

function headings(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("# Business logic audit — "))
    .map((line) => line.replace("# Business logic audit — ", ""));
}

test("--all audits the common modules and ends with Miscellaneous", () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "mirror-ai-out-")), "all.md");
  const result = cli(["--android", android, "--ios", ios, "--all", "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  const names = headings(out);
  assert.deepEqual(names, [...catalog.common.map((row) => row.label), "Miscellaneous"]);
  assert.match(result.stderr, /Miscellaneous: \d+ Android and \d+ iOS file\(s\)/);
});

test("--module with a comma list audits only those modules, with no Miscellaneous", () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "mirror-ai-out-")), "two.md");
  const result = cli(["--android", android, "--ios", ios, "--module", "CATALOG,feed", "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(headings(out).sort(), ["Catalog", "Feed"]);
});
