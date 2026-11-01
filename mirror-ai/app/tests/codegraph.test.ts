import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildGraphEvidenceMarkdown,
  ensureCodegraphIndex,
  hasCodegraphCli,
  queryCodegraph,
  rankFilesForKeywords,
} from "../src/codegraph.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const android = path.join(root, "fixtures/android-app");

test("codegraph ranks catalog-related files on the Android fixture", { skip: !hasCodegraphCli() }, () => {
  ensureCodegraphIndex(android);
  const ranked = rankFilesForKeywords(android, ["catalog", "CATALOG"]);
  assert.ok(ranked.length > 0, "expected graph-ranked files");
  assert.ok(
    ranked.some((file) => file.includes("Catalog") || file.includes("catalog")),
    "expected a catalog-related path",
  );
  const hits = queryCodegraph(android, "CatalogApi", 5);
  assert.ok(hits.some((hit) => hit.name === "CatalogApi"));
  const markdown = buildGraphEvidenceMarkdown(android, android, ["catalog"]);
  assert.match(markdown, /Codegraph evidence/);
  assert.match(markdown, /CatalogApi/);
});
