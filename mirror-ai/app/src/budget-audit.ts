/**
 * The `budget` runner: a whole-project audit on a hard dollar cap.
 *
 * Two stages, both through the Message Batches API (half price):
 *
 *   1. Scan — Claude Haiku 5.5 reads a ranked, compacted slice of each module's
 *      code (line numbers kept) and lists candidate differences and bugs as JSON.
 *      Each request stays under Haiku's 100K-token price tier.
 *   2. Verify — Claude Sonnet 5.5 sees every candidate next to the real source
 *      lines it cites, drops what the code does not support, and writes the
 *      report sections the specs define.
 *
 * Every dollar is accounted for: a stage is only submitted when its worst case
 * (all input billed as a cache write, every request using its full max_tokens)
 * fits what is left of MIRROR_AI_BUDGET_USD. Actual spend is written to a ledger
 * on disk, batch ids are persisted so a restart resumes instead of paying twice,
 * and scan results are kept so a failed verify never re-buys its scan.
 */
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { codegraphEnabled, rankFilesForKeywords } from "./codegraph.ts";
import { findHardcodedCopy, hardcodedCopySection } from "./hardcoded-copy.ts";
import { miscFileScore } from "./misc-scope.ts";
import { checkoutInfo } from "./report-store.ts";
import { readSources, type RepoSource } from "./scan.ts";
import type { AuditPass, AuditRequest } from "./audit.ts";
import type { ModuleRow } from "./enums.ts";
import type { ModuleDef } from "./types.ts";

// ------------------------------------------------------------------ settings

/** Bump when the prompts below change, so saved sections from older prompts miss. */
const PROMPT_VERSION = "budget-v3";

export function scanModel(): string {
  return process.env.MIRROR_AI_SCAN_MODEL?.trim() || "claude-haiku-5-5";
}

export function verifyModel(): string {
  return process.env.MIRROR_AI_VERIFY_MODEL?.trim() || "claude-sonnet-5-5";
}

/** Bump when only the verify step changes; scans stay reusable. */
const VERIFY_VERSION = "v4";

export function budgetModelLabel(): string {
  return `${scanModel()}+${verifyModel()}@${PROMPT_VERSION}.${VERIFY_VERSION}`;
}

export function budgetLimitUsd(): number {
  const value = Number(process.env.MIRROR_AI_BUDGET_USD);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

/** Scan requests per module. More chunks read more of a large module's code. */
function scanChunks(): number {
  const value = Number(process.env.MIRROR_AI_SCAN_CHUNKS);
  return Number.isInteger(value) && value > 0 ? value : 4;
}

/** Share of the remaining budget the scan stage may use; the rest is kept for verify. */
const SCAN_SHARE = 0.35;

/**
 * Runs `items` in waves. Each wave is the longest prefix whose worst case fits
 * what the stage may still spend; once it settles, actual spend is booked and
 * the next wave is sized from the real remaining budget. Actual cost is usually
 * well under the worst case, so waves let a full-quality run finish under the
 * cap where one up-front worst-case reservation would have had to cut quality.
 * Items that can never fit are returned as skipped.
 */
async function runInWaves<T>(
  items: T[],
  worstOf: (item: T) => number,
  allowance: () => number,
  runWave: (wave: T[], reserve: number) => Promise<void>,
): Promise<T[]> {
  let queue = [...items];
  const skipped: T[] = [];
  while (queue.length > 0) {
    const available = allowance();
    const wave: T[] = [];
    let total = 0;
    for (const item of queue) {
      const cost = worstOf(item);
      if (total + cost > available) break;
      wave.push(item);
      total += cost;
    }
    if (wave.length === 0) {
      skipped.push(...queue);
      break;
    }
    reservedUsd += total;
    try {
      await runWave(wave, total);
    } finally {
      reservedUsd -= total;
    }
    queue = queue.slice(wave.length);
  }
  return skipped;
}

/** Whole scan prompt, in tokens. Haiku 5.5 bills 5x above 100K, so stay below. */
// Read per call, not at import: the CLI and server load .env after this module loads.
const scanPromptTokens = () => Number(process.env.MIRROR_AI_SCAN_PROMPT_TOKENS) || 92_000;
const SCAN_MAX_OUTPUT = 16_000;
/** Source excerpts shown to the verifier, in tokens. */
const verifySnippetTokens = () => Number(process.env.MIRROR_AI_VERIFY_SNIPPET_TOKENS) || 20_000;
const VERIFY_MAX_OUTPUT = 10_000;
/** One file may take at most this share of a chunk; the rest is marked uninspected. */
const MAX_FILE_SHARE = 0.3;
const POLL_FAST_MS = 15_000;
const POLL_SLOW_MS = 60_000;
const BATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;

interface Price {
  input: number;
  output: number;
  /** Prompt length above which the long-context rates apply. */
  tierAbove?: number;
  longInput?: number;
  longOutput?: number;
  /** Cache read multiplier on the input rate. */
  cacheRead: number;
}

/** USD per million tokens, standard (non-batch) rates. Batch halves all of them. */
const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, tierAbove: 100_000, longInput: 0.5, longOutput: 2.5, cacheRead: 0.1 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.05 },
};
const BATCH_DISCOUNT = 0.5;
const CACHE_WRITE = 1.25;

/**
 * How requests are sent. `batch`: Message Batches API with ANTHROPIC_API_KEY —
 * real dollars, half price, hard cap. `cli`: one `claude -p` call per request
 * with no tools, on the user's Claude subscription login — no dollar bill, it
 * counts against the plan's usage limits; costs are logged as API-equivalent.
 */
export type Transport = "batch" | "cli";

export function budgetTransport(): Transport {
  const forced = process.env.MIRROR_AI_BUDGET_TRANSPORT?.trim();
  if (forced === "batch" || forced === "cli") return forced;
  return process.env.ANTHROPIC_API_KEY?.trim() ? "batch" : "cli";
}

function discount(): number {
  return budgetTransport() === "batch" ? BATCH_DISCOUNT : 1;
}

function priceOf(model: string): Price {
  const price = PRICES[model];
  if (!price) {
    throw new Error(
      `The budget runner has no price for model "${model}", so it cannot keep spend under the cap. Use claude-haiku-5-5, claude-sonnet-5-5 or claude-opus-5-5.`,
    );
  }
  return price;
}

function rates(model: string, promptTokens: number): { input: number; output: number; cacheRead: number } {
  const price = priceOf(model);
  const long = price.tierAbove !== undefined && promptTokens > price.tierAbove;
  const input = long ? (price.longInput ?? price.input) : price.input;
  return { input, output: long ? (price.longOutput ?? price.output) : price.output, cacheRead: input * price.cacheRead };
}

/** What a finished request actually cost, from its usage block. */
export function usageCostUsd(model: string, usage: Anthropic.Usage, batch = true): number {
  const uncached = usage.input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const rate = rates(model, uncached + written + read);
  const usd =
    (uncached * rate.input + written * rate.input * CACHE_WRITE + read * rate.cacheRead + (usage.output_tokens ?? 0) * rate.output) /
    1_000_000;
  return usd * (batch ? BATCH_DISCOUNT : 1);
}

/**
 * The most a request can cost: the cached system prefix billed as a cache
 * write (no cache hit assumed), the rest at the input rate, full max_tokens out.
 */
function worstCaseUsd(model: string, systemTokens: number, userTokens: number, maxTokens: number): number {
  const rate = rates(model, systemTokens + userTokens);
  return (
    ((systemTokens * rate.input * CACHE_WRITE + userTokens * rate.input + maxTokens * rate.output) / 1_000_000) * discount()
  );
}

// -------------------------------------------------------------------- ledger

interface LedgerEntry {
  at: string;
  stage: "scan" | "verify";
  model: string;
  module: string;
  usd: number;
  /** `cli` entries are API-equivalent cost on a subscription, not money spent. */
  transport?: Transport;
  usage: Pick<Anthropic.Usage, "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens">;
}

interface Ledger {
  /** Real dollars, from the batch transport. */
  spentUsd: number;
  /** What the subscription (cli) runs would have cost at API prices. */
  cliEquivalentUsd?: number;
  entries: LedgerEntry[];
}

function cacheDir(projectRoot: string, ...parts: string[]): string {
  const dir = path.join(projectRoot, ".cache", "budget", ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function ledgerFile(projectRoot: string): string {
  return path.join(cacheDir(projectRoot), "ledger.json");
}

export function readLedger(projectRoot: string): Ledger {
  try {
    return JSON.parse(readFileSync(ledgerFile(projectRoot), "utf8")) as Ledger;
  } catch {
    return { spentUsd: 0, entries: [] };
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}

function recordSpend(projectRoot: string, entry: LedgerEntry): void {
  const ledger = readLedger(projectRoot);
  ledger.entries.push(entry);
  if (entry.transport === "cli") {
    ledger.cliEquivalentUsd = Math.round(((ledger.cliEquivalentUsd ?? 0) + entry.usd) * 1e6) / 1e6;
  } else {
    ledger.spentUsd = Math.round((ledger.spentUsd + entry.usd) * 1e6) / 1e6;
  }
  writeJsonAtomic(ledgerFile(projectRoot), ledger);
}

/** Worst-case dollars held by batches that are submitted but not yet settled. */
let reservedUsd = 0;

export interface BudgetStatus {
  transport: Transport;
  /** Batch: the dollar cap. CLI: MIRROR_AI_CLI_USAGE_CAP_USD if set, else Infinity. */
  limitUsd: number;
  /** Batch: dollars spent. CLI: API-equivalent usage so far. */
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
}

export function budgetStatus(projectRoot: string): BudgetStatus {
  const ledger = readLedger(projectRoot);
  const transport = budgetTransport();
  if (transport === "cli") {
    const cap = Number(process.env.MIRROR_AI_CLI_USAGE_CAP_USD);
    const limitUsd = Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY;
    const spentUsd = ledger.cliEquivalentUsd ?? 0;
    return { transport, limitUsd, spentUsd, reservedUsd, remainingUsd: Math.max(0, limitUsd - spentUsd - reservedUsd) };
  }
  const limitUsd = budgetLimitUsd();
  return { transport, limitUsd, spentUsd: ledger.spentUsd, reservedUsd, remainingUsd: Math.max(0, limitUsd - ledger.spentUsd - reservedUsd) };
}

// ------------------------------------------------------------------ evidence

interface RankedFile {
  source: RepoSource;
  /** Compacted, line-numbered text. */
  body: string;
  /** Last original line included, when the file had to be cut. */
  cutAtLine?: number;
  lines: number;
  /** Only the regions around the module's mentions are shown. */
  excerpted?: boolean;
}

interface Side {
  platform: "Android" | "iOS";
  root: string;
  files: RankedFile[];
  matched: number;
}

const TEST_PATH = /(^|\/)(test|tests|androidTest|testDebug|UITests|[A-Za-z]+Tests?)\//;
const TEST_FILE = /(Test|Tests|Spec|Mock|Fake|Stub)\.(kt|java|swift)$/;

function isTestFile(relativePath: string): boolean {
  return TEST_PATH.test(relativePath) || TEST_FILE.test(relativePath);
}

/**
 * Drops lines that carry no behaviour — blanks, imports, package lines and
 * comment-only lines — and prefixes each kept line with its original number,
 * so a citation the model writes still points at the right line on disk.
 */
export function compactSource(text: string): { body: string; lines: number } {
  const out: string[] = [];
  let inBlock = false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (!trimmed) continue;
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
      inBlock = true;
      continue;
    }
    if (/^(\/\/|\/\*.*\*\/$|\*)/.test(trimmed)) continue;
    if (/^(import|package|@file:)\s/.test(trimmed)) continue;
    out.push(`${index + 1}|${lines[index].replace(/\s+$/, "").replace(/^ {4}|\t/g, " ")}`);
  }
  return { body: out.join("\n"), lines: lines.length };
}

/** A file this size or larger that is not named for the module shows only its relevant regions. */
const FOCUS_ABOVE_CHARS = 8_000;
/** Compacted lines of context kept on each side of a mention. */
const FOCUS_CONTEXT = 40;

/**
 * Keeps only the compacted lines within FOCUS_CONTEXT of a line that mentions
 * the module, joined by markers naming the omitted original lines. A shared
 * navigator or constants file then costs a few hundred tokens instead of tens
 * of thousands, and its line numbers still match the file on disk.
 */
export function focusBody(body: string, needles: string[]): { body: string; excerpted: boolean } {
  const lines = body.split("\n");
  const keep = new Uint8Array(lines.length);
  let hits = 0;
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    if (!needles.some((needle) => lower.includes(needle))) return;
    hits++;
    for (let at = Math.max(0, index - FOCUS_CONTEXT); at <= Math.min(lines.length - 1, index + FOCUS_CONTEXT); at++) keep[at] = 1;
  });
  if (hits === 0) return { body, excerpted: false };
  const out: string[] = [];
  let gapStart = -1;
  const lineNo = (index: number) => Number(/^(\d+)\|/.exec(lines[index])?.[1] ?? 0);
  for (let index = 0; index < lines.length; index++) {
    if (keep[index]) {
      if (gapStart >= 0) {
        out.push(`[… original lines ${lineNo(gapStart)}-${lineNo(index - 1)} not shown …]`);
        gapStart = -1;
      }
      out.push(lines[index]);
    } else if (gapStart < 0) {
      gapStart = index;
    }
  }
  if (gapStart >= 0) out.push(`[… original lines ${lineNo(gapStart)}-${lineNo(lines.length - 1)} not shown …]`);
  const focused = out.join("\n");
  return focused.length < body.length ? { body: focused, excerpted: true } : { body, excerpted: false };
}

export function rankSide(platform: Side["platform"], root: string, keywords: string[], only?: string[]): Side {
  if (only) return listedSide(platform, root, only);
  const needles = keywords.map((keyword) => keyword.toLowerCase()).filter(Boolean);
  const sources = readSources(root).filter((source) => !isTestFile(source.relativePath));
  const scored = new Map<string, { source: RepoSource; score: number; named: boolean }>();
  for (const source of sources) {
    const pathLower = source.relativePath.toLowerCase();
    let score = 0;
    let named = false;
    let mentions = 0;
    for (const needle of needles) {
      if (pathLower.includes(needle.replace(/_/g, ""))) {
        named = true;
        score += 10;
      }
      if (source.lower.includes(needle)) {
        mentions += countOccurrences(source.lower, needle);
        score += 1;
      }
    }
    // Density beats raw count: a focused file outranks a big file that names the module in passing.
    if (mentions > 0) score += Math.min(6, (mentions * 4_000) / Math.max(2_000, source.text.length));
    if (score > 0) scored.set(source.relativePath, { source, score, named });
  }
  if (codegraphEnabled() && needles.length > 0) {
    try {
      const ranked = rankFilesForKeywords(root, keywords);
      ranked.forEach((file, index) => {
        const hit = scored.get(file);
        if (hit) hit.score += Math.max(0, 20 - index);
      });
    } catch {
      // Keyword ranking alone is fine.
    }
  }
  const ordered = [...scored.values()].sort(
    (left, right) => right.score - left.score || left.source.relativePath.localeCompare(right.source.relativePath),
  );
  return {
    platform,
    root,
    matched: ordered.length,
    files: ordered.map(({ source, named }) => {
      const compact = compactSource(source.text);
      if (named || compact.body.length < FOCUS_ABOVE_CHARS) return { source, ...compact };
      return { source, lines: compact.lines, ...focusBody(compact.body, needles) };
    }),
  };
}

/**
 * A side made of exactly these files (the Miscellaneous section), business
 * logic and network code first, then by path. There is no module name to
 * focus on, so whole compacted files are kept; what the budget cannot fit is
 * listed as unread in the coverage note.
 */
function listedSide(platform: Side["platform"], root: string, files: string[]): Side {
  const wanted = new Set(files);
  const ordered = readSources(root)
    .filter((source) => wanted.has(source.relativePath))
    .map((source) => ({ source, score: miscFileScore(source) }))
    .sort((left, right) => right.score - left.score || left.source.relativePath.localeCompare(right.source.relativePath));
  return {
    platform,
    root,
    matched: ordered.length,
    files: ordered.map(({ source }) => ({ source, ...compactSource(source.text), excerpted: false })),
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && count < 50; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

interface Chunk {
  android: RankedFile[];
  ios: RankedFile[];
  text: string;
}

/**
 * Splits both sides into up to `count` chunks of at most `charBudget`
 * characters each, half Android and half iOS, so every chunk can compare the
 * two platforms. A side with less to show gives its share to the other.
 */
export function buildChunks(android: Side, ios: Side, count: number, charBudget: number): { chunks: Chunk[]; uninspected: { android: string[]; ios: string[] } } {
  const queues = { android: [...android.files], ios: [...ios.files] };
  const chunks: Chunk[] = [];
  for (let index = 0; index < count; index++) {
    if (queues.android.length === 0 && queues.ios.length === 0) break;
    const chunk: Chunk = { android: [], ios: [], text: "" };
    let used = { android: 0, ios: 0 };
    const fill = (side: "android" | "ios", cap: number) => {
      const queue = queues[side];
      while (queue.length > 0) {
        const file = queue[0];
        const header = file.source.relativePath.length + 16;
        const room = cap - used[side];
        const limit = Math.floor(charBudget * MAX_FILE_SHARE);
        let body = file.body;
        let cutAtLine: number | undefined;
        if (body.length + header > limit) {
          // Too large for one share: keep its head and say where it stops.
          const cut = body.lastIndexOf("\n", limit - header);
          body = body.slice(0, Math.max(0, cut));
          cutAtLine = Number(/^(\d+)\|/m.exec(body.split("\n").at(-1) ?? "")?.[1]) || undefined;
        }
        if (body.length + header > room) {
          if (used[side] === 0 && room > header + 2000) {
            const cut = body.lastIndexOf("\n", room - header);
            body = body.slice(0, Math.max(0, cut));
            cutAtLine = Number(/^(\d+)\|/m.exec(body.split("\n").at(-1) ?? "")?.[1]) || undefined;
          } else {
            break;
          }
        }
        queue.shift();
        chunk[side].push({ ...file, body, cutAtLine });
        used[side] += body.length + header;
      }
    };
    const half = Math.floor(charBudget / 2);
    fill("android", half);
    fill("ios", half);
    // Give unused room to whichever side still has files.
    fill("android", charBudget - used.ios);
    fill("ios", charBudget - used.android);
    if (chunk.android.length === 0 && chunk.ios.length === 0) break;
    chunk.text = renderChunk(chunk);
    chunks.push(chunk);
  }
  return {
    chunks,
    uninspected: {
      android: queues.android.map((file) => file.source.relativePath),
      ios: queues.ios.map((file) => file.source.relativePath),
    },
  };
}

function renderChunk(chunk: Chunk): string {
  const lines: string[] = [];
  for (const [platform, files] of [["Android", chunk.android], ["iOS", chunk.ios]] as const) {
    lines.push(`# ${platform} source (${files.length} file(s); format is "<original line>|<code>", blank/import/comment lines omitted)`);
    if (files.length === 0) lines.push("(no matching files on this platform in this chunk)");
    for (const file of files) {
      lines.push(`## ${platform}:${file.source.relativePath}${file.excerpted ? " (excerpts around this module's mentions)" : ""}`);
      lines.push(file.body);
      if (file.cutAtLine) lines.push(`[file continues after line ${file.cutAtLine}: lines ${file.cutAtLine + 1}-${file.lines} were NOT shown — treat as uninspected]`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- prompts

const SCAN_RULES = `You are stage 1 of a two-stage Android vs iOS audit: the scanner.
Read the source excerpts in the user message and list every candidate finding:
business-logic differences between the platforms, bugs on either platform,
UI differences, and API contract drift — measured against the audit specs below.

Rules:
- Recall matters most: list anything plausible. A stronger verifier re-checks
  each candidate against the source and discards the ones the code does not support.
- Every candidate must cite at least one location as "path:line" or
  "path:start-end", using the path exactly as written after "## Android:" or
  "## iOS:" and the original line numbers shown before "|". Never invent a path.
- Put Android citations in "android" and iOS citations in "ios". A finding about
  something missing on one platform cites the side where it exists and says so.
- Keep "detail" under 400 characters: what each platform does, and why it matters.
- Excerpts omit blank, import and comment lines; some files are cut short and
  say so. Do not report something as missing just because it is not shown.
- Do not write the report. Output only the JSON object.

The audit specs follow; use them to decide what counts as a finding.`;

const VERIFY_RULES = `You are stage 2 of a two-stage Android vs iOS audit: the verifier and author.
A cheaper scanner read a ranked slice of this module's code and proposed the
candidate findings in the user message. Next to them are the real source lines
each candidate cites, with their original line numbers.

Do this:
1. Check every candidate against the attached source. Keep it only if the code
   shown supports it. Drop it if the code contradicts it, if its cited path was
   not found, or if it rests on code that is not shown. When a candidate is
   plausible but its evidence is not attached, keep it only with Confidence Low
   and say "needs runtime verification".
2. Correct the details the scanner got wrong: lines, behaviour, severity.
3. Write the report sections defined by the specs below, using their headings
   and table columns exactly, in this order:
{HEADINGS}
   Every section heading must appear even when it has no rows; then say what was
   checked and that no difference was confirmed.

Constraints:
- Analysis only. Do not invent requirements, APIs, files or line numbers.
- Cite as \`path/relative/to/that/platform/root.ext:LINE\` or \`...:START-END\`,
  never an absolute path, never "...".
- Coverage is partial by construction: a "Coverage" note in the user message
  lists what was not read. Do not claim full coverage, and do not report the
  absence of something you could not see.
- Counts the UI spec asks for (screens, elements) must come only from the code
  shown; mark them "partial" when coverage is incomplete.
- Layout views (Slot | Type | Android | iOS | State): publish one for each of up
  to 3 paired screens whose view code is attached, most divergent first. The
  first Android and first iOS file under "Main screen code" are the screens this
  module opens on each platform: treat them as a pair and publish their layout
  view even when registry counts cannot be stated; head it
  "**UI-0n — <Android screen> ↔ <iOS screen>**". Rows
  only for slots whose State is not \`same\`, top of screen first, at most 12
  rows, each cell a few words (e.g. "Hidden while loading", "Remote
  _TITLE_KEY", "Hard-coded label"). Skip a screen whose view code is not
  attached rather than guess. Do not publish the separate hard-coded copy
  table; it is added from the source afterwards.
- No preamble and no closing remarks — start at the first heading.

The audit specs follow.`;

const SCAN_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          section: { type: "string", enum: ["logic", "ui", "api"] },
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          android: { type: "array", items: { type: "string" } },
          ios: { type: "array", items: { type: "string" } },
          detail: { type: "string" },
        },
        required: ["section", "title", "severity", "android", "ios", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

interface Candidate {
  section: "logic" | "ui" | "api";
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  android: string[];
  ios: string[];
  detail: string;
}

export interface PassSpec {
  pass: AuditPass;
  /** The full system text the other runners would use for this pass. */
  spec: string;
}

/**
 * The UI spec's "Hard-coded copy" table is produced from the source by code
 * (hardcoded-copy.ts), so the models never see that part of the spec: it would
 * only add tokens for a fact a pattern reads exactly.
 */
const CODE_BUILT_SUBSECTION = /### Hard-coded copy on buttons and labels[\s\S]*?(?=Close with a short note)/;

function specsBlock(specs: PassSpec[]): string {
  return specs
    .map(({ pass, spec }) => `<spec pass="${pass.id}" heading="${pass.firstHeading}">\n${spec.replace(CODE_BUILT_SUBSECTION, "").trim()}\n</spec>`)
    .join("\n\n");
}

/** The pass whose section the code-built copy table joins. */
function uiPassId(specs: PassSpec[]): string | undefined {
  return specs.find(({ pass }) => /UI Difference/i.test(pass.firstHeading))?.pass.id;
}

function copyTable(item: ModulePlan): string {
  return hardcodedCopySection(
    findHardcodedCopy("Android", item.android.files.map((file) => file.source)),
    findHardcodedCopy("iOS", item.ios.files.map((file) => file.source)),
  );
}

/** MIRROR_AI_HARDCODED_COPY=off leaves the hard-coded copy check out of the report. */
export function hardcodedCopyEnabled(): boolean {
  return !/^(off|0|false|no)$/i.test(process.env.MIRROR_AI_HARDCODED_COPY?.trim() ?? "");
}

function appendCopyTable(sections: Record<string, string>, specs: PassSpec[], item: ModulePlan): Record<string, string> {
  if (!hardcodedCopyEnabled()) return sections;
  const ui = uiPassId(specs);
  if (ui && sections[ui] !== undefined) sections[ui] = `${sections[ui]}\n\n${copyTable(item)}`;
  return sections;
}

function moduleBrief(request: AuditRequest, def: ModuleDef, row: ModuleRow | null): string {
  if (def.files) return miscBrief(request, def);
  const lines = [`Module: **${def.label}** (enum constant \`${def.id.toUpperCase()}\`).`];
  for (const [platform, root] of [["Android", request.androidPath], ["iOS", request.iosPath]] as const) {
    const { branch, commit } = checkoutInfo(root);
    if (commit) lines.push(`- ${platform} checkout: branch \`${branch || "detached"}\` @ \`${commit}\`.`);
  }
  lines.push(
    row?.android
      ? `- Android declares it as \`${row.android.enumName}.${row.android.caseName}\` in \`${row.android.file}:${row.android.line}\`.`
      : "- Android does not declare this module in its module enum.",
  );
  lines.push(
    row?.ios
      ? `- iOS declares it as \`${row.ios.enumName}.${row.ios.caseName}\` in \`${row.ios.file}:${row.ios.line}\`.`
      : "- iOS does not declare this module in its module enum.",
  );
  lines.push(`- Search terms used to select files: ${def.keywords.join(", ")}.`);
  return lines.join("\n");
}

/** Brief for the Miscellaneous section, which has no enum constant or search terms. */
function miscBrief(request: AuditRequest, def: ModuleDef): string {
  const lines = [
    `Module: **${def.label}** — the code no common module claims.`,
    "- It holds code of modules only one platform declares, of modules that are missing from or badly defined in the module enum, and code that belongs to no module.",
    "- Pair Android and iOS code by what it does (screen, flow, endpoint, rule), not by name. Report business logic, UI and API differences as for any module; code with no counterpart on the other platform is itself a finding.",
  ];
  for (const [platform, root] of [["Android", request.androidPath], ["iOS", request.iosPath]] as const) {
    const { branch, commit } = checkoutInfo(root);
    if (commit) lines.push(`- ${platform} checkout: branch \`${branch || "detached"}\` @ \`${commit}\`.`);
  }
  lines.push(`- Files: ${def.files?.android.length ?? 0} Android, ${def.files?.ios.length ?? 0} iOS.`);
  return lines.join("\n");
}

// ------------------------------------------------------------ token sizing

const charsPerToken = new Map<string, number>();

/**
 * Characters per token for this model on this kind of text, measured once with
 * the free count_tokens endpoint and shaded 8% low so estimates err high.
 */
async function calibrate(client: Anthropic, model: string, sample: string): Promise<number> {
  const known = charsPerToken.get(model);
  if (known) return known;
  let ratio = 2.6;
  try {
    const text = sample.slice(0, 120_000);
    const counted = await client.messages.countTokens({ model, messages: [{ role: "user", content: text }] });
    if (counted.input_tokens > 100) ratio = (text.length / counted.input_tokens) * 0.92;
  } catch {
    // Keep the conservative default.
  }
  charsPerToken.set(model, ratio);
  return ratio;
}

function estimateTokens(model: string, text: string): number {
  return Math.ceil(text.length / (charsPerToken.get(model) ?? 2.6));
}

// ----------------------------------------------------------------- batches

type BatchRequest = Anthropic.Messages.BatchCreateParams.Request;

interface BatchOutcome {
  text?: string;
  stopReason?: string | null;
  error?: string;
}

/**
 * Submits a batch, or resumes the one already submitted for exactly these
 * requests, and waits for its results. Spend is recorded as each result lands.
 */
async function runBatch(
  client: Anthropic,
  projectRoot: string,
  stage: LedgerEntry["stage"],
  requests: BatchRequest[],
  labels: Map<string, string>,
  onResult: OnResult = () => {},
): Promise<Map<string, BatchOutcome>> {
  const key = createHash("sha256").update(JSON.stringify(requests)).digest("hex").slice(0, 24);
  const pendingFile = path.join(cacheDir(projectRoot, "batches"), `${stage}-${key}.json`);
  let batchId: string | null = null;
  if (existsSync(pendingFile)) {
    try {
      batchId = (JSON.parse(readFileSync(pendingFile, "utf8")) as { id: string }).id;
    } catch {
      batchId = null;
    }
  }
  if (!batchId) {
    let created: Anthropic.Messages.MessageBatch;
    try {
      created = await client.messages.batches.create({ requests });
    } catch (error) {
      if (error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.AuthenticationError) {
        throw new Error(
          "This API key may not use the Batch API. Use a Claude Console key (sk-ant-api03-...) in ANTHROPIC_API_KEY, or remove it so the budget runner uses your `claude` CLI login instead (MIRROR_AI_BUDGET_TRANSPORT=cli). Nothing was spent.",
        );
      }
      throw error;
    }
    batchId = created.id;
    writeJsonAtomic(pendingFile, { id: batchId, createdAt: new Date().toISOString(), stage, count: requests.length });
    console.log(`[budget] ${stage}: submitted batch ${batchId} with ${requests.length} request(s).`);
  } else {
    console.log(`[budget] ${stage}: resuming batch ${batchId}.`);
  }

  const started = Date.now();
  for (;;) {
    const batch = await client.messages.batches.retrieve(batchId);
    if (batch.processing_status === "ended") break;
    if (Date.now() - started > BATCH_TIMEOUT_MS) {
      throw new Error(`Batch ${batchId} did not finish within 24 hours.`);
    }
    await new Promise((resolve) => setTimeout(resolve, Date.now() - started < 5 * 60_000 ? POLL_FAST_MS : POLL_SLOW_MS));
  }

  const outcomes = new Map<string, BatchOutcome>();
  const modelById = new Map(requests.map((request) => [request.custom_id, request.params.model]));
  for await (const entry of await client.messages.batches.results(batchId)) {
    const result = entry.result;
    if (result.type === "succeeded") {
      const model = modelById.get(entry.custom_id) ?? result.message.model;
      const usd = usageCostUsd(model, result.message.usage);
      recordSpend(projectRoot, {
        at: new Date().toISOString(),
        stage,
        transport: "batch",
        model,
        module: labels.get(entry.custom_id) ?? entry.custom_id,
        usd,
        usage: {
          input_tokens: result.message.usage.input_tokens,
          output_tokens: result.message.usage.output_tokens,
          cache_creation_input_tokens: result.message.usage.cache_creation_input_tokens,
          cache_read_input_tokens: result.message.usage.cache_read_input_tokens,
        },
      });
      outcomes.set(entry.custom_id, { text: messageText(result.message), stopReason: result.message.stop_reason });
    } else if (result.type === "errored") {
      outcomes.set(entry.custom_id, { error: `${result.error.error.type}: ${result.error.error.message}` });
    } else {
      outcomes.set(entry.custom_id, { error: `The request was ${result.type} before it ran.` });
    }
  }
  for (const [id, outcome] of outcomes) onResult(id, outcome);
  try {
    unlinkSync(pendingFile);
  } catch {
    // Already gone.
  }
  return outcomes;
}

// --------------------------------------------------------- the CLI transport

const CLI_TIMEOUT_MS = Number(process.env.MIRROR_AI_CLI_TIMEOUT_MS) || 30 * 60_000;
const cliConcurrency = () => Math.max(1, Number(process.env.MIRROR_AI_CLI_CONCURRENCY) || 3);

/** Thrown once the plan's usage limit is hit, so no further request is started. */
class PlanLimitError extends Error {}

/** Sends requests through the transport the environment chose. */
/** Called as each request settles, so its result can be kept before the rest finish. */
type OnResult = (customId: string, outcome: BatchOutcome) => void;

function runRequests(
  client: Anthropic,
  projectRoot: string,
  stage: LedgerEntry["stage"],
  requests: BatchRequest[],
  labels: Map<string, string>,
  onResult: OnResult = () => {},
): Promise<Map<string, BatchOutcome>> {
  return budgetTransport() === "cli"
    ? runViaCli(projectRoot, stage, requests, labels, onResult)
    : runBatch(client, projectRoot, stage, requests, labels, onResult);
}

/**
 * Runs each request as `claude -p` on the user's subscription login: no tools,
 * no MCP servers, no settings, hooks or CLAUDE.md, and our system prompt in
 * place of Claude Code's, so a call costs what the request holds and cannot
 * wander off reading the repositories. A few run at once.
 */
async function runViaCli(
  projectRoot: string,
  stage: LedgerEntry["stage"],
  requests: BatchRequest[],
  labels: Map<string, string>,
  onResult: OnResult,
): Promise<Map<string, BatchOutcome>> {
  const outcomes = new Map<string, BatchOutcome>();
  const emptyDir = cacheDir(projectRoot, "cli", "empty");
  let planLimit: string | null = null;
  let next = 0;
  let done = 0;
  console.log(`[budget] ${stage}: ${requests.length} request(s) through the claude CLI, ${cliConcurrency()} at a time.`);
  const worker = async () => {
    while (next < requests.length) {
      const request = requests[next++];
      if (planLimit) {
        outcomes.set(request.custom_id, { error: planLimit });
        onResult(request.custom_id, { error: planLimit });
        continue;
      }
      try {
        const outcome = await cliRequest(projectRoot, emptyDir, stage, request, labels.get(request.custom_id) ?? request.custom_id);
        outcomes.set(request.custom_id, outcome);
        onResult(request.custom_id, outcome);
      } catch (error) {
        if (error instanceof PlanLimitError) planLimit = error.message;
        const failed = { error: error instanceof Error ? error.message : "The claude CLI call failed." };
        outcomes.set(request.custom_id, failed);
        // Callers record problems as results arrive; a failure must reach them too,
        // or the report says "no result" and the real cause is lost.
        onResult(request.custom_id, failed);
        console.error(`[budget] ${stage}: ${request.custom_id} failed: ${failed.error.slice(0, 400)}`);
      }
      done++;
      if (done % 10 === 0 || done === requests.length) console.log(`[budget] ${stage}: ${done}/${requests.length} done.`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cliConcurrency(), requests.length) }, worker));
  return outcomes;
}

async function cliRequest(
  projectRoot: string,
  cwd: string,
  stage: LedgerEntry["stage"],
  request: BatchRequest,
  label: string,
): Promise<BatchOutcome> {
  const params = request.params;
  const system = (params.system as { text: string }[])[0].text;
  const user = params.messages[0].content as string;
  const systemFile = path.join(cacheDir(projectRoot, "cli"), `system-${createHash("sha256").update(system).digest("hex").slice(0, 16)}.txt`);
  if (!existsSync(systemFile)) writeFileSync(systemFile, system);
  const args = [
    "-p",
    "--model", params.model,
    "--effort", params.output_config?.effort ?? "medium",
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt-file", systemFile,
    "--output-format", "json",
  ];
  const schema = params.output_config?.format?.schema;
  if (schema) args.push("--json-schema", JSON.stringify(schema));

  for (let attempt = 0; ; attempt++) {
    const result = await spawnWithInput("claude", args, user, cwd);
    let payload: {
      is_error?: boolean;
      result?: unknown;
      structured_output?: unknown;
      total_cost_usd?: number;
      stop_reason?: string | null;
      usage?: Anthropic.Usage;
    };
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      const detail = `${result.stderr}\n${result.stdout}`.trim().split("\n").find(Boolean) ?? `exit code ${result.code}`;
      throw cliError(detail);
    }
    const text = typeof payload.result === "string" ? payload.result : "";
    if (payload.is_error) {
      const error = cliError(text || "The claude CLI reported an error with no detail.");
      if (!(error instanceof PlanLimitError) && /rate.?limit|overloaded|429|529/i.test(text) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 60_000 * 2 ** attempt));
        continue;
      }
      throw error;
    }
    if (payload.usage) {
      recordSpend(projectRoot, {
        at: new Date().toISOString(),
        stage,
        transport: "cli",
        model: params.model,
        module: label,
        usd: typeof payload.total_cost_usd === "number" ? payload.total_cost_usd : usageCostUsd(params.model, payload.usage, false),
        usage: {
          input_tokens: payload.usage.input_tokens,
          output_tokens: payload.usage.output_tokens,
          cache_creation_input_tokens: payload.usage.cache_creation_input_tokens,
          cache_read_input_tokens: payload.usage.cache_read_input_tokens,
        },
      });
    }
    const output = payload.structured_output !== undefined && payload.structured_output !== null ? JSON.stringify(payload.structured_output) : text.trim();
    return { text: output, stopReason: payload.stop_reason ?? "end_turn" };
  }
}

function cliError(detail: string): Error {
  if (/usage limit|limit reached|limit will reset|hit your [\w -]*limit|resets \d|out of (extra )?usage|credit balance/i.test(detail)) {
    return new PlanLimitError(
      `Your Claude plan's usage limit was reached (${detail.slice(0, 160)}). Run the audit again after the limit resets — finished modules are saved and are not redone.`,
    );
  }
  if (/not logged in|login|authenticat|invalid api key|oauth/i.test(detail)) {
    return new Error(`The claude CLI is not signed in (${detail.slice(0, 160)}). Run \`claude\` once and sign in, then try again.`);
  }
  return new Error(`The claude CLI call failed: ${detail.slice(0, 300)}`);
}

function spawnWithInput(command: string, args: string[], input: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`A claude CLI call ran past ${Math.round(CLI_TIMEOUT_MS / 60_000)} minutes and was stopped.`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error("The `claude` CLI is not installed or not on PATH.") : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.on("error", () => {
      // The process exited before reading all input; its output says why.
    });
    child.stdin.end(input);
  });
}

function messageText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

// ------------------------------------------------------------- the audit

export interface ModuleOutcome {
  /** Markdown per pass id. */
  sections?: Record<string, string>;
  error?: string;
}

interface ModulePlan {
  def: ModuleDef;
  row: ModuleRow | null;
  android: Side;
  ios: Side;
  chunks: Chunk[];
  uninspected: { android: string[]; ios: string[] };
  scanKey: string;
}

/**
 * Each module's outcome, by module + checkouts + prompts. A successful outcome
 * stays for the life of the process: the job queue asks once per (module, pass)
 * and only a few at a time, so a later ask must reuse the finished run rather
 * than pay for a second one. A failed outcome is dropped so a retry can run.
 */
const outcomesByModule = new Map<string, Promise<ModuleOutcome>>();

/**
 * The outcome for `def`. The first ask starts one two-stage batch run covering
 * `def` and every other module in `pending` that is not already running or
 * done, so a whole-project audit is two batches, not one per module.
 */
export function auditModuleOnBudget(
  request: AuditRequest,
  def: ModuleDef,
  pending: ModuleDef[],
  specs: PassSpec[],
): Promise<ModuleOutcome> {
  const specHash = createHash("sha256").update(specs.map((s) => s.spec).join("\u0000")).digest("hex");
  const keyOf = (item: ModuleDef) =>
    createHash("sha256").update(JSON.stringify([request.androidPath, request.iosPath, item.id, specHash, budgetModelLabel()])).digest("hex");
  const existing = outcomesByModule.get(keyOf(def));
  if (existing) return existing;

  const batch = [def, ...pending.filter((item) => item.id !== def.id && !outcomesByModule.has(keyOf(item)))];
  const run = auditOnce(request, batch, specs);
  for (const item of batch) {
    const key = keyOf(item);
    const outcome = run.then(
      (results) => results.get(item.id) ?? { error: "The budget run returned nothing for this module. Run the audit again to retry it." },
      (error: unknown) => ({ error: error instanceof Error ? error.message : "The budget run failed." }),
    );
    outcomesByModule.set(
      key,
      outcome.then((result) => {
        if (result.error) outcomesByModule.delete(key);
        return result;
      }),
    );
  }
  return outcomesByModule.get(keyOf(def))!;
}

export interface BudgetEstimate {
  transport: Transport;
  modules: number;
  scanRequests: number;
  scanInputTokens: number;
  /** Most the scan stage can cost: no cache hits, every request at max_tokens. */
  scanWorstUsd: number;
  /** Likely scan cost: system prompt cached after the first request, ~5K tokens out. */
  scanLikelyUsd: number;
  verifyWorstUsd: number;
  verifyLikelyUsd: number;
  limitUsd: number;
  spentUsd: number;
  perModule: { label: string; android: string; ios: string; chunks: number; unread: number }[];
}

/**
 * Plans a whole budget audit without spending anything — token counts come
 * from the free count_tokens endpoint — and reports what it should cost.
 */
export async function estimateBudgetAudit(request: AuditRequest, defs: ModuleDef[], specs: PassSpec[]): Promise<BudgetEstimate> {
  let estimate: BudgetEstimate | null = null;
  await auditOnce(request, defs, specs, (value) => {
    estimate = value;
  });
  if (!estimate) throw new Error("The estimate could not be produced.");
  return estimate;
}

async function auditOnce(
  request: AuditRequest,
  defs: ModuleDef[],
  specs: PassSpec[],
  onEstimate?: (estimate: BudgetEstimate) => void,
): Promise<Map<string, ModuleOutcome>> {
  if (request.mode === "repository") {
    throw new Error("The budget runner audits module by module. Tick every module instead of using full-repository mode.");
  }
  const client = new Anthropic();
  const outcomes = new Map<string, ModuleOutcome>();
  const scanSystem = `${SCAN_RULES}\n\n${specsBlock(specs)}`;
  const headings = specs.map(({ pass }) => `   - ${pass.firstHeading}`).join("\n");
  const verifySystem = `${VERIFY_RULES.replace("{HEADINGS}", headings)}\n\n${specsBlock(specs)}`;

  // ---- plan the scan
  const sides = defs.map((def) => ({
    def,
    row: request.rows.find((item) => item.key === def.id) ?? null,
    android: rankSide("Android", request.androidPath, def.keywords, def.files?.android),
    ios: rankSide("iOS", request.iosPath, def.keywords, def.files?.ios),
  }));
  const sample = sides.flatMap((side) => [...side.android.files, ...side.ios.files]).slice(0, 40).map((file) => file.body).join("\n");
  await calibrate(client, scanModel(), sample || scanSystem);
  await calibrate(client, verifyModel(), sample || verifySystem);

  const systemTokens = estimateTokens(scanModel(), scanSystem);
  const evidenceTokens = scanPromptTokens() - systemTokens - 1_500;
  if (evidenceTokens < 10_000) {
    throw new Error(`The audit specs alone take ~${systemTokens} tokens, leaving no room for code under the ${scanPromptTokens()}-token scan limit.`);
  }
  const charBudget = Math.floor(evidenceTokens * (charsPerToken.get(scanModel()) ?? 2.6));

  let chunksPerModule = scanChunks();
  let plans: ModulePlan[] = [];
  const plan = () => {
    plans = sides.map((side) => {
      const { chunks, uninspected } = buildChunks(side.android, side.ios, chunksPerModule, charBudget);
      const scanKey = createHash("sha256")
        .update(JSON.stringify([PROMPT_VERSION, scanModel(), scanSystem, moduleBrief(request, side.def, side.row), chunks.map((c) => c.text)]))
        .digest("hex")
        .slice(0, 24);
      return { ...side, chunks, uninspected, scanKey };
    });
  };
  plan();

  for (const item of plans) {
    if (item.android.matched === 0 && item.ios.matched === 0) {
      outcomes.set(item.def.id, {
        sections: Object.fromEntries(
          specs.map(({ pass }) => [
            pass.id,
            `${pass.firstHeading}\n\nNo source file on either platform mentions ${item.def.keywords.join(", ")}, so there is nothing to audit for this module.`,
          ]),
        ),
      });
    }
  }
  const active = () => plans.filter((item) => !outcomes.has(item.def.id));

  // ---- stage 1: scan
  const scanFile = (item: ModulePlan) => path.join(cacheDir(request.projectRoot, "scans"), `${item.scanKey}.json`);
  // Each chunk's findings are kept the moment that request finishes, so an
  // interrupted run (a usage limit, a restart) re-sends only the missing chunks.
  const chunkFile = (item: ModulePlan, index: number) => path.join(cacheDir(request.projectRoot, "scans"), `${item.scanKey}-c${index}.json`);
  const scanId = (item: ModulePlan, index: number) => `scan-${item.def.id}-${index}`.slice(0, 64);
  const scanRequests = (items: ModulePlan[]): BatchRequest[] =>
    items.flatMap((item) =>
      existsSync(scanFile(item))
        ? []
        : item.chunks.flatMap((chunk, index) => {
            if (existsSync(chunkFile(item, index))) return [];
            const user = `${moduleBrief(request, item.def, item.row)}\n\nChunk ${index + 1} of ${item.chunks.length} for this module.\n\n${chunk.text}`;
            return [{
              custom_id: scanId(item, index),
              params: {
                model: scanModel(),
                max_tokens: SCAN_MAX_OUTPUT,
                thinking: { type: "adaptive" as const },
                output_config: { effort: "medium" as const, format: { type: "json_schema" as const, schema: SCAN_SCHEMA as unknown as Record<string, unknown> } },
                system: [{ type: "text" as const, text: scanSystem, cache_control: { type: "ephemeral" as const } }],
                messages: [{ role: "user" as const, content: user }],
              },
            }];
          }),
    );
  const worstScan = (requests: BatchRequest[]) =>
    requests.reduce((total, item) => {
      const params = item.params;
      const system = (params.system as { text: string }[])[0].text;
      const user = params.messages[0].content as string;
      return total + worstCaseUsd(params.model, estimateTokens(params.model, system), estimateTokens(params.model, user), params.max_tokens);
    }, 0);

  let pendingScans = scanRequests(active());
  if (onEstimate) {
    const scanSystemTokens = estimateTokens(scanModel(), scanSystem);
    const scanUserTokens = pendingScans.reduce((total, req) => total + estimateTokens(scanModel(), req.params.messages[0].content as string), 0);
    const scanRate = rates(scanModel(), scanPromptTokens());
    const verifySystemTokens = estimateTokens(verifyModel(), verifySystem);
    const verifyRate = rates(verifyModel(), 50_000);
    const verifyCount = active().length;
    const verifyUserTokens = verifySnippetTokens() + 4_000;
    const half = discount() / 1_000_000;
    const status = budgetStatus(request.projectRoot);
    onEstimate({
      transport: budgetTransport(),
      modules: plans.length,
      scanRequests: pendingScans.length,
      scanInputTokens: scanUserTokens + scanSystemTokens * pendingScans.length,
      scanWorstUsd: worstScan(pendingScans),
      scanLikelyUsd:
        (scanSystemTokens * scanRate.input * CACHE_WRITE +
          scanSystemTokens * Math.max(0, pendingScans.length - 1) * scanRate.cacheRead +
          scanUserTokens * scanRate.input +
          pendingScans.length * 5_000 * scanRate.output) *
        half,
      verifyWorstUsd:
        verifyCount * worstCaseUsd(verifyModel(), verifySystemTokens, verifyUserTokens, VERIFY_MAX_OUTPUT),
      verifyLikelyUsd:
        (verifySystemTokens * verifyRate.input * CACHE_WRITE +
          verifySystemTokens * Math.max(0, verifyCount - 1) * verifyRate.cacheRead +
          verifyCount * (verifyUserTokens * 0.7 * verifyRate.input + 5_000 * verifyRate.output)) *
        half,
      limitUsd: status.limitUsd,
      spentUsd: status.spentUsd,
      perModule: plans.map((item) => {
        const counts = coverageCounts(item);
        return {
          label: item.def.label,
          android: counts.android,
          ios: counts.ios,
          chunks: item.chunks.length,
          unread: item.uninspected.android.length + item.uninspected.ios.length,
        };
      }),
    });
    return outcomes;
  }
  const spentAtStart = readLedger(request.projectRoot).spentUsd;
  const scanAllowance = budgetStatus(request.projectRoot).remainingUsd * SCAN_SHARE;
  // Far over even allowing for actual spend: read fewer chunks per module.
  while (pendingScans.length > 0 && worstScan(pendingScans) > scanAllowance * 2 && chunksPerModule > 1) {
    chunksPerModule -= 1;
    plan();
    pendingScans = scanRequests(active());
  }

  const toScan = active().filter((item) => !existsSync(scanFile(item)));
  const skippedScans = await runInWaves(
    toScan,
    (item) => worstScan(scanRequests([item])),
    () => scanAllowance - (readLedger(request.projectRoot).spentUsd - spentAtStart),
    async (wave) => {
      const requests = scanRequests(wave);
      const labels = new Map(requests.map((req) => [req.custom_id, req.custom_id.replace(/^scan-/, "")]));
      const byId = new Map(wave.flatMap((item) => item.chunks.map((_, index) => [scanId(item, index), { item, index }] as const)));
      const problems = new Map<string, string[]>();
      const problem = (item: ModulePlan, text: string) => problems.set(item.def.id, [...(problems.get(item.def.id) ?? []), text]);
      await runRequests(client, request.projectRoot, "scan", requests, labels, (id, outcome) => {
        const target = byId.get(id);
        if (!target) return;
        if (outcome.error || outcome.text === undefined) return problem(target.item, outcome.error ?? "no result");
        if (outcome.stopReason === "refusal") return problem(target.item, "the scan model declined this chunk");
        try {
          const findings = (JSON.parse(outcome.text) as { findings: Candidate[] }).findings;
          writeJsonAtomic(chunkFile(target.item, target.index), { findings });
        } catch {
          problem(target.item, outcome.stopReason === "max_tokens" ? "the scan output was cut off" : "the scan output was not valid JSON");
        }
      });
      for (const item of wave) {
        const files = item.chunks.map((_, index) => chunkFile(item, index));
        if (files.every((file) => existsSync(file))) {
          const candidates = files.flatMap((file) => (JSON.parse(readFileSync(file, "utf8")) as { findings: Candidate[] }).findings);
          writeJsonAtomic(scanFile(item), { candidates });
        } else {
          const done = files.filter((file) => existsSync(file)).length;
          outcomes.set(item.def.id, {
            error: `The scan failed (${(problems.get(item.def.id) ?? ["no result"]).join("; ")}). ${done}/${files.length} chunk(s) are kept; run the audit again to finish this module.`,
          });
        }
      }
    },
  );
  for (const item of skippedScans) outcomes.set(item.def.id, { error: budgetExhausted(request.projectRoot) });

  // ---- stage 2: verify
  const verifyItems: { item: ModulePlan; candidates: Candidate[]; user: string; maxTokens: number }[] = [];
  for (const item of active()) {
    if (!existsSync(scanFile(item))) {
      outcomes.set(item.def.id, { error: "The scan result is missing. Run the audit again to retry this module." });
      continue;
    }
    const candidates = dedupe((JSON.parse(readFileSync(scanFile(item), "utf8")) as { candidates: Candidate[] }).candidates);
    if (candidates.length === 0) {
      outcomes.set(item.def.id, { sections: appendCopyTable(emptySections(specs, item), specs, item) });
      continue;
    }
    verifyItems.push({ item, candidates, user: verifyUserMessage(request, item, candidates), maxTokens: VERIFY_MAX_OUTPUT });
  }

  const verifyRequest = (entry: (typeof verifyItems)[number]): BatchRequest => ({
    custom_id: `verify-${entry.item.def.id}`.slice(0, 64),
    params: {
      model: verifyModel(),
      max_tokens: entry.maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: [{ type: "text", text: verifySystem, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: entry.user }],
    },
  });
  const worstVerify = (entries: typeof verifyItems) =>
    entries.reduce(
      (total, entry) =>
        total +
        worstCaseUsd(verifyModel(), estimateTokens(verifyModel(), verifySystem), estimateTokens(verifyModel(), entry.user), entry.maxTokens),
      0,
    );

  // Each verified report is kept the moment it finishes, keyed by exactly what
  // was asked, so an interrupted run never pays for the same verify twice.
  const verifyFile = (entry: (typeof verifyItems)[number]) =>
    path.join(
      cacheDir(request.projectRoot, "verified"),
      `${createHash("sha256").update(JSON.stringify([verifyModel(), verifySystem, entry.user])).digest("hex").slice(0, 24)}.json`,
    );
  const publish = (entry: (typeof verifyItems)[number], outcome: BatchOutcome) => {
    let text = outcome.text ?? "";
    if (outcome.stopReason === "max_tokens") text += "\n\n> This report hit the output limit and is cut short.";
    outcomes.set(entry.item.def.id, {
      sections: appendCopyTable(splitSections(text, specs, entry.item, entry.candidates.length), specs, entry.item),
    });
  };
  const pendingVerify = verifyItems.filter((entry) => {
    if (!existsSync(verifyFile(entry))) return true;
    publish(entry, JSON.parse(readFileSync(verifyFile(entry), "utf8")) as BatchOutcome);
    return false;
  });

  const skippedVerify = await runInWaves(
    pendingVerify,
    (entry) => worstVerify([entry]),
    () => budgetStatus(request.projectRoot).remainingUsd,
    async (wave) => {
      const labels = new Map(wave.map((entry) => [`verify-${entry.item.def.id}`.slice(0, 64), entry.item.def.id]));
      const entryById = new Map(wave.map((entry) => [`verify-${entry.item.def.id}`.slice(0, 64), entry]));
      const results = await runRequests(client, request.projectRoot, "verify", wave.map(verifyRequest), labels, (id, outcome) => {
        const entry = entryById.get(id);
        if (entry && !outcome.error && outcome.text !== undefined && outcome.stopReason !== "refusal") {
          writeJsonAtomic(verifyFile(entry), { text: outcome.text, stopReason: outcome.stopReason });
        }
      });
      for (const entry of wave) {
        const outcome = results.get(`verify-${entry.item.def.id}`.slice(0, 64));
        if (!outcome || outcome.error || outcome.text === undefined) {
          outcomes.set(entry.item.def.id, { error: `The verify step failed (${outcome?.error ?? "no result"}). Run the audit again to retry; the scan is kept.` });
          continue;
        }
        if (outcome.stopReason === "refusal") {
          outcomes.set(entry.item.def.id, { error: "The verify model declined this module." });
          continue;
        }
        publish(entry, outcome);
      }
    },
  );
  for (const entry of skippedVerify) outcomes.set(entry.item.def.id, { error: budgetExhausted(request.projectRoot) });
  return outcomes;
}

function budgetExhausted(projectRoot: string): string {
  const status = budgetStatus(projectRoot);
  if (status.transport === "cli") {
    return `Skipped: the API-equivalent usage cap of $${status.limitUsd.toFixed(2)} (MIRROR_AI_CLI_USAGE_CAP_USD) was reached at $${status.spentUsd.toFixed(2)}. Raise or unset it to continue.`;
  }
  return `Skipped to stay within the $${status.limitUsd.toFixed(2)} budget ($${status.spentUsd.toFixed(2)} spent so far). Raise MIRROR_AI_BUDGET_USD, or delete .cache/budget/ledger.json to start a new budget.`;
}

function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  for (const candidate of [...candidates].sort((left, right) => rank[left.severity] - rank[right.severity])) {
    const key = `${candidate.section}|${candidate.title.toLowerCase().replace(/\W+/g, " ").trim()}|${[...candidate.android, ...candidate.ios].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

// --------------------------------------------------------- verify evidence

interface Ref {
  file: string;
  start: number;
  end: number;
}

function parseRef(ref: string): Ref | null {
  const match = /^\s*`?([^`:\s]+\.(?:kt|kts|java|swift)):(\d+)(?:\s*-\s*(\d+))?`?/.exec(ref);
  if (!match) return null;
  const start = Number(match[2]);
  return { file: match[1].replace(/^(Android|iOS):/, ""), start, end: Math.max(start, Number(match[3] ?? start)) };
}

function verifyUserMessage(request: AuditRequest, item: ModulePlan, candidates: Candidate[]): string {
  const byPath = {
    android: new Map(readSources(request.androidPath).map((source) => [source.relativePath, source])),
    ios: new Map(readSources(request.iosPath).map((source) => [source.relativePath, source])),
  };
  // Windows per file, merged where they touch.
  const windows = { android: new Map<string, [number, number][]>(), ios: new Map<string, [number, number][]>() };
  const missing = new Set<string>();
  const charBudget = Math.floor(verifySnippetTokens() * (charsPerToken.get(verifyModel()) ?? 2.6));
  let used = 0;
  const lines = new Map<string, string[]>();
  const notAttached = new Set<number>();

  candidates.forEach((candidate, index) => {
    let attached = false;
    for (const side of ["android", "ios"] as const) {
      for (const raw of candidate[side]) {
        const ref = parseRef(raw);
        if (!ref) continue;
        const source = byPath[side].get(ref.file) ?? findBySuffix(byPath[side], ref.file);
        if (!source) {
          missing.add(`${side === "android" ? "Android" : "iOS"}:${ref.file}`);
          continue;
        }
        const fileLines = lines.get(`${side}:${source.relativePath}`) ?? source.text.split(/\r?\n/);
        lines.set(`${side}:${source.relativePath}`, fileLines);
        const from = Math.max(1, ref.start - 15);
        const to = Math.min(fileLines.length, ref.end + 25);
        const cost = fileLines.slice(from - 1, to).reduce((sum, line) => sum + line.length + 6, 0);
        if (used + cost > charBudget) continue;
        used += cost;
        const list = windows[side].get(source.relativePath) ?? [];
        list.push([from, to]);
        windows[side].set(source.relativePath, list);
        attached = true;
      }
    }
    if (!attached) notAttached.add(index);
  });

  const out = [
    moduleBrief(request, item.def, item.row),
    "",
    `Android repository root: \`${request.androidPath}\`. iOS repository root: \`${request.iosPath}\`.`,
    "",
    "# Candidate findings from the scanner (unverified)",
    "",
    ...candidates.map((candidate, index) => {
      const flags = [
        notAttached.has(index) ? "EVIDENCE NOT ATTACHED" : "",
        [...candidate.android, ...candidate.ios].some((raw) => {
          const ref = parseRef(raw);
          return ref && [...missing].some((miss) => miss.endsWith(ref.file));
        })
          ? "CITED PATH NOT FOUND"
          : "",
      ].filter(Boolean);
      return `${index + 1}. [${candidate.section}] [${candidate.severity}] ${candidate.title}${flags.length ? ` — ${flags.join(", ")}` : ""}\n   Android: ${candidate.android.join(", ") || "—"} | iOS: ${candidate.ios.join(", ") || "—"}\n   ${candidate.detail}`;
    }),
    "",
    "# Source at the cited locations (original line numbers)",
    "",
  ];
  for (const side of ["android", "ios"] as const) {
    for (const [file, ranges] of windows[side]) {
      const fileLines = lines.get(`${side}:${file}`)!;
      out.push(`## ${side === "android" ? "Android" : "iOS"}: ${file}`);
      for (const [from, to] of mergeRanges(ranges)) {
        out.push("```");
        for (let line = from; line <= to; line++) out.push(`${line}| ${fileLines[line - 1]}`);
        out.push("```");
      }
      out.push("");
    }
  }
  // Screen code for the layout views, from room the snippets left unused —
  // the snippet cap is unchanged, so this never raises the planned budget.
  const screens = screenSection(item, Math.min(charBudget - used, Math.floor(charBudget * SCREEN_SHARE)));
  if (screens) out.push(screens, "");
  out.push(coverageNote(item));
  return out.join("\n");
}

/** Most of the verifier's code allowance a module's main screens may use. */
const SCREEN_SHARE = 0.3;

const ANDROID_SCREEN_NAME = /(Screen|Route|Page|Sheet|Dialog|Fragment|Content)\.kt$/;
const IOS_SCREEN_NAME = /(View|ViewController|Screen|Sheet)\.swift$/;

function isScreenFile(platform: "android" | "ios", file: RankedFile): boolean {
  const { relativePath, text } = file.source;
  if (platform === "android") return ANDROID_SCREEN_NAME.test(relativePath) && /@Composable|Fragment\(|: Fragment|setContentView/.test(text);
  return IOS_SCREEN_NAME.test(relativePath) && /:\s*(some\s+)?View\b|UIViewController|UIView\b/.test(text);
}

/**
 * The highest-ranked screen file on each platform, compacted with original line
 * numbers, so the verifier can reconstruct the layout views the UI spec asks
 * for. The scanner rarely cites view code, and without it the verifier rightly
 * publishes no layout at all.
 */
function screenSection(item: ModulePlan, room: number): string {
  if (room < 2_000) return "";
  const picked = (["android", "ios"] as const).flatMap((platform) =>
    moduleScreens(platform === "android" ? item.android : item.ios, platform, item.def.keywords).map((file) => ({ platform, file })),
  );
  if (picked.length === 0) return "";
  const share = Math.floor(room / picked.length);
  const out = ["# Main screen code for the layout views (compacted; \"<original line>|<code>\")", ""];
  for (const { platform, file } of picked) {
    let body = file.body;
    let note = "";
    if (body.length > share) {
      body = body.slice(0, Math.max(0, body.lastIndexOf("\n", share)));
      const last = Number(/^(\d+)\|/.exec(body.split("\n").at(-1) ?? "")?.[1]) || 0;
      note = `[file continues after line ${last}; not shown]`;
    }
    out.push(`## ${platform === "android" ? "Android" : "iOS"}: ${file.source.relativePath}`, "```", body, "```");
    if (note) out.push(note);
    out.push("");
  }
  return out.join("\n");
}

const SCREEN_REF = /\b([A-Z][A-Za-z0-9]+?)(Route|NavKey|Destination|Screen|ViewController|View)\b/g;
const SCREENS_PER_PLATFORM = 2;

/**
 * The screens a module opens. A module's keyword usually appears only in
 * navigation glue (`SHOP_PLAN -> BuyPostpaidLineRoute`), not in the screen, so
 * the screen names written on the keyword's lines are resolved to their files
 * (`BuyPostpaidLineRoute` -> `BuyPostpaidLineScreen.kt`). Screens that mention
 * the keyword themselves count too. Most-referenced first.
 */
export function moduleScreens(side: Side, platform: "android" | "ios", keywords: string[]): RankedFile[] {
  const needles = keywords.map((keyword) => keyword.toLowerCase());
  const votes = new Map<string, number>();
  for (const file of side.files.slice(0, 40)) {
    for (const line of file.source.text.split("\n")) {
      const lower = line.toLowerCase();
      if (!needles.some((needle) => lower.includes(needle))) continue;
      for (const match of line.matchAll(SCREEN_REF)) votes.set(match[1], (votes.get(match[1]) ?? 0) + 1);
    }
  }
  const all = readSources(side.root);
  const screens: { file: RankedFile; score: number }[] = [];
  const seen = new Set<string>();
  const consider = (source: RepoSource, score: number) => {
    if (seen.has(source.relativePath) || isTestFile(source.relativePath)) return;
    const file = side.files.find((candidate) => candidate.source.relativePath === source.relativePath) ?? { source, ...compactSource(source.text) };
    if (!isScreenFile(platform, file)) return;
    seen.add(source.relativePath);
    screens.push({ file, score });
  };
  for (const [base, count] of votes) {
    for (const source of all) {
      const name = source.relativePath.split("/").pop() ?? "";
      if (name.startsWith(base) && (platform === "android" ? ANDROID_SCREEN_NAME : IOS_SCREEN_NAME).test(name)) consider(source, count * 2);
    }
  }
  side.files.forEach((file, index) => consider(file.source, Math.max(0, 1 - index / 100)));
  return screens
    .sort((left, right) => right.score - left.score || left.file.body.length - right.file.body.length)
    .slice(0, SCREENS_PER_PLATFORM)
    .map((entry) => entry.file);
}

function findBySuffix(map: Map<string, RepoSource>, file: string): RepoSource | undefined {
  const hits = [...map.keys()].filter((key) => key.endsWith(`/${file}`) || key === file);
  return hits.length === 1 ? map.get(hits[0]) : undefined;
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const out: [number, number][] = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range[0] <= last[1] + 3) last[1] = Math.max(last[1], range[1]);
    else out.push([...range]);
  }
  return out;
}

function coverageCounts(item: ModulePlan): { android: string; ios: string; cut: number; excerpted: number } {
  const seen = (side: "android" | "ios") => item.chunks.reduce((total, chunk) => total + chunk[side].length, 0);
  const all = item.chunks.flatMap((chunk) => [...chunk.android, ...chunk.ios]);
  const cut = all.filter((file) => file.cutAtLine).length;
  const excerpted = all.filter((file) => file.excerpted).length;
  return { android: `${seen("android")}/${item.android.matched}`, ios: `${seen("ios")}/${item.ios.matched}`, cut, excerpted };
}

function coverageNote(item: ModulePlan): string {
  const counts = coverageCounts(item);
  const list = (files: string[]) =>
    files.length === 0 ? "none" : `${files.slice(0, 15).map((file) => `\`${file}\``).join(", ")}${files.length > 15 ? ` and ${files.length - 15} more` : ""}`;
  return [
    "# Coverage",
    "",
    `The scanner read ${counts.android} matching Android files and ${counts.ios} matching iOS files (tests excluded; ${counts.excerpted} large shared file(s) shown only around this module's mentions; ${counts.cut} file(s) cut short).`,
    `Not read on Android: ${list(item.uninspected.android)}.`,
    `Not read on iOS: ${list(item.uninspected.ios)}.`,
  ].join("\n");
}

function coverageFooter(item: ModulePlan, candidates: number): string {
  const counts = coverageCounts(item);
  const unread = item.uninspected.android.length + item.uninspected.ios.length;
  return `> **Budget audit coverage** — ${scanModel()} scanned ${counts.android} matching Android and ${counts.ios} matching iOS source files (tests excluded${counts.excerpted ? `; ${counts.excerpted} large shared files excerpted around module mentions` : ""}${counts.cut ? `; ${counts.cut} cut short` : ""}) and proposed ${candidates} candidate(s); ${verifyModel()} verified them against the cited source. ${unread ? `${unread} lower-ranked matching file(s) were not read, so findings there are not covered.` : "Every matching file was read."}`;
}

function emptySections(specs: PassSpec[], item: ModulePlan): Record<string, string> {
  return Object.fromEntries(
    specs.map(({ pass }, index) => [
      pass.id,
      `${pass.firstHeading}\n\nThe scan found no candidate differences in the code it read for this module.${index === 0 ? `\n\n${coverageFooter(item, 0)}` : ""}`,
    ]),
  );
}

/** Cuts the verifier's single report into one section per pass, by heading. */
export function splitSections(text: string, specs: PassSpec[], item: ModulePlan | null, candidates: number): Record<string, string> {
  const positions = specs.map(({ pass }) => ({ pass, at: findHeading(text, pass.firstHeading) }));
  const found = positions.filter((entry) => entry.at >= 0).sort((left, right) => left.at - right.at);
  const sections: Record<string, string> = {};
  for (const { pass } of positions) {
    const index = found.findIndex((entry) => entry.pass.id === pass.id);
    if (index === -1) {
      sections[pass.id] = `${pass.firstHeading}\n\nThe verifier confirmed no differences for this section.`;
      continue;
    }
    const end = index + 1 < found.length ? found[index + 1].at : text.length;
    sections[pass.id] = text.slice(found[index].at, end).trim();
  }
  if (item && specs[0]) sections[specs[0].pass.id] += `\n\n${coverageFooter(item, candidates)}`;
  return sections;
}

function findHeading(text: string, heading: string): number {
  // Anchored at a line start: "### 3." also occurs inside "#### 3.", one character late.
  const match = /^#+\s+(\d+)\.\s+(.+)$/.exec(heading.trim());
  if (!match) {
    const plain = new RegExp(`^${heading.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").exec(text);
    return plain?.index ?? -1;
  }
  const name = match[2].trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^#{1,4}\\s+${match[1]}\\.\\s+${name}`, "mi");
  return pattern.exec(text)?.index ?? -1;
}
