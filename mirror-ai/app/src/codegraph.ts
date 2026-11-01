import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface CodegraphHit {
  filePath: string;
  name: string;
  kind: string;
  startLine: number;
  score: number;
}

const QUERY_LIMIT = Number(process.env.MIRROR_AI_CODEGRAPH_QUERY_LIMIT) || 20;
const INDEX_TIMEOUT_MS = Number(process.env.MIRROR_AI_CODEGRAPH_INDEX_TIMEOUT_MS) || 600_000;
const SYNC_TIMEOUT_MS = Number(process.env.MIRROR_AI_CODEGRAPH_SYNC_TIMEOUT_MS) || 120_000;
const CMD_TIMEOUT_MS = Number(process.env.MIRROR_AI_CODEGRAPH_CMD_TIMEOUT_MS) || 60_000;

let cliPresent: boolean | null = null;

export function resolveCodegraphBin(): string {
  return process.env.MIRROR_AI_CODEGRAPH_BIN?.trim() || "codegraph";
}

export function hasCodegraphCli(): boolean {
  if (cliPresent !== null) return cliPresent;
  const bin = resolveCodegraphBin();
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 });
  cliPresent = probe.status === 0;
  return cliPresent;
}

/** On by default when the CLI exists; set MIRROR_AI_CODEGRAPH=0 to disable. */
export function codegraphEnabled(): boolean {
  if (process.env.MIRROR_AI_CODEGRAPH === "0") return false;
  return hasCodegraphCli();
}

function runCodegraph(args: string[], timeoutMs: number): { ok: boolean; stdout: string; stderr: string } {
  const bin = resolveCodegraphBin();
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Ensures an index exists under `root/.codegraph` (init or sync). */
export function ensureCodegraphIndex(root: string): void {
  const resolved = path.resolve(root);
  if (!codegraphEnabled()) return;
  const indexDir = path.join(resolved, ".codegraph");
  if (!existsSync(indexDir)) {
    const init = runCodegraph(["init", resolved], INDEX_TIMEOUT_MS);
    if (!init.ok) {
      throw new Error(firstLine(init.stderr) || firstLine(init.stdout) || "codegraph init failed");
    }
    return;
  }
  const sync = runCodegraph(["sync", resolved], SYNC_TIMEOUT_MS);
  if (!sync.ok) {
    throw new Error(firstLine(sync.stderr) || firstLine(sync.stdout) || "codegraph sync failed");
  }
}

export function queryCodegraph(root: string, search: string, limit = QUERY_LIMIT): CodegraphHit[] {
  const resolved = path.resolve(root);
  const result = runCodegraph(
    ["query", search, "-p", resolved, "-l", String(limit), "-j"],
    CMD_TIMEOUT_MS,
  );
  if (!result.ok) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const hits: CodegraphHit[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const node = (entry as { node?: Record<string, unknown>; score?: number }).node;
    const score = Number((entry as { score?: number }).score) || 0;
    if (!node || typeof node.filePath !== "string") continue;
    hits.push({
      filePath: node.filePath.replace(/\\/g, "/"),
      name: typeof node.name === "string" ? node.name : "",
      kind: typeof node.kind === "string" ? node.kind : "",
      startLine: typeof node.startLine === "number" ? node.startLine : 0,
      score,
    });
  }
  return hits;
}

/** Merges keyword queries into a de-duplicated file list, highest score first. */
export function rankFilesForKeywords(root: string, keywords: string[]): string[] {
  const byFile = new Map<string, number>();
  const terms = [...new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean))];
  for (const term of terms) {
    for (const hit of queryCodegraph(root, term)) {
      const prev = byFile.get(hit.filePath) ?? 0;
      if (hit.score > prev) byFile.set(hit.filePath, hit.score);
    }
  }
  return [...byFile.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([file]) => file);
}

export function buildGraphEvidenceMarkdown(
  androidPath: string,
  iosPath: string,
  keywords: string[],
): string {
  if (!codegraphEnabled()) return "";
  const androidHits = collectHits(androidPath, keywords);
  const iosHits = collectHits(iosPath, keywords);
  if (androidHits.length === 0 && iosHits.length === 0) return "";

  const lines = [
    "# Codegraph evidence (start here)",
    "",
    "These symbols and files were ranked for this module. Prefer them over broad",
    "Grep/Glob. Use Read only when you need lines not listed below.",
    "",
  ];
  writeHitSection(lines, "Android", androidPath, androidHits);
  writeHitSection(lines, "iOS", iosPath, iosHits);
  return lines.join("\n").trimEnd();
}

function collectHits(root: string, keywords: string[]): CodegraphHit[] {
  const byKey = new Map<string, CodegraphHit>();
  for (const term of [...new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean))]) {
    for (const hit of queryCodegraph(root, term)) {
      const key = `${hit.filePath}:${hit.startLine}:${hit.name}`;
      const prev = byKey.get(key);
      if (!prev || hit.score > prev.score) byKey.set(key, hit);
    }
  }
  return [...byKey.values()].sort((left, right) => right.score - left.score).slice(0, 40);
}

function writeHitSection(lines: string[], label: string, root: string, hits: CodegraphHit[]): void {
  lines.push(`## ${label}`);
  lines.push("");
  if (hits.length === 0) {
    lines.push("(No graph hits for this module's keywords.)");
    lines.push("");
    return;
  }
  lines.push(`Root: \`${path.resolve(root)}\``);
  lines.push("");
  const byFile = new Map<string, CodegraphHit[]>();
  for (const hit of hits) {
    const list = byFile.get(hit.filePath) ?? [];
    list.push(hit);
    byFile.set(hit.filePath, list);
  }
  for (const file of [...byFile.keys()].sort()) {
    const symbols = byFile.get(file) ?? [];
    const summary = symbols
      .slice(0, 6)
      .map((symbol) => `${symbol.name} (${symbol.kind}) L${symbol.startLine}`)
      .join(", ");
    lines.push(`- \`${file}\` — ${summary}`);
  }
  lines.push("");
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
