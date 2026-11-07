import Anthropic from "@anthropic-ai/sdk";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  checkoutInfo,
  promptsFingerprint,
  readSavedReport,
  reportKey,
  saveReport,
  type ReportIdentity,
} from "./report-store.ts";
import { apiDriftScopeNote, readApiDriftWorkflow } from "./api-drift-workflow.ts";
import { miscFileScore } from "./misc-scope.ts";
import { readSources, type RepoSource } from "./scan.ts";
import type { ModuleRow } from "./enums.ts";
import type { ComparisonMode, ModuleDef } from "./types.ts";
import { resolveApiModel, resolveCliModel, type AuditRunner } from "./audit-models.ts";
import {
  auditRunSettings,
  resolveAuditModelForRun,
  type AuditEffort,
  type AuditRunSettings,
} from "./audit-settings.ts";
import {
  canUseCursorRunner,
  hasCursorAgentCli,
  preferCursorRunner,
  runCursorAgent,
} from "./cursor-agent.ts";
import {
  buildGraphEvidenceMarkdown,
  codegraphEnabled,
  ensureCodegraphIndex,
  rankFilesForKeywords,
} from "./codegraph.ts";
import { auditModuleOnBudget, estimateBudgetAudit, type BudgetEstimate } from "./budget-audit.ts";
const MAX_FILES_PER_SIDE = 40;
/** Characters of source per platform, for the bundled fallback. ~4 chars a token. */
const EVIDENCE_BUDGET = Number(process.env.MIRROR_AI_EVIDENCE_BUDGET) || 200_000;
/** Runs at once, counted in sections: three is one module's logic, UI and API together. */
export const CONCURRENCY = Number(process.env.MIRROR_AI_CONCURRENCY) || 3;
const TIMEOUT_MS = Number(process.env.MIRROR_AI_TIMEOUT_MS) || 2_700_000;

export type Runner = AuditRunner;

function runSettings(request: AuditRequest): AuditRunSettings {
  return auditRunSettings(request);
}

function resolveAuditModel(runner: Runner, request: AuditRequest): string {
  return resolveAuditModelForRun(runner, runSettings(request));
}

function effortFor(request: AuditRequest): AuditEffort {
  return runSettings(request).effort;
}

/** The budget runner fixes its own effort per stage, so the UI's setting must not split its saved reports. */
function identityEffort(runner: Runner, request: AuditRequest): string {
  return runner === "budget" ? "budget" : effortFor(request);
}

export interface AuditRequest {
  androidPath: string;
  iosPath: string;
  rows: ModuleRow[];
  defs: ModuleDef[];
  projectRoot: string;
  /** @deprecated Prefer moduleLeads — one compact leads blob per module. */
  leads?: string;
  /** Static matcher notes per module id (no @@compare blocks). */
  moduleLeads?: Record<string, string>;
  mode: ComparisonMode;
  /** Ignore any saved report and audit again. */
  refresh?: boolean;
  /** Per-run effort (overrides MIRROR_AI_EFFORT from the UI). */
  effort?: string;
  /** Explicit Cursor agent model id from the UI (`--model`). */
  cursorModel?: string;
}

export interface AuditResult {
  markdown: string;
  /** One entry per module, in the order they were asked for. */
  modules: { label: string; cached: boolean; at?: string; file?: string }[];
}

interface Evidence {
  included: RepoSource[];
  skipped: string[];
  matched: number;
}

/**
 * The audit spec lives on disk so it can be edited without touching code.
 * It is read per run, so a change needs no restart.
 */
export function readAuditSpec(projectRoot: string): string {
  return readFileSync(path.join(projectRoot, "prompts/business-logic-audit.md"), "utf8");
}

/**
 * Every `prompts/skills/*.md` is a skill: an extra pass over the same module
 * and the same evidence that publishes its own numbered section after the
 * matrix. Dropping a file in adds one; deleting it takes it away.
 */
export function readSkills(projectRoot: string): { name: string; text: string }[] {
  const dir = path.join(projectRoot, "prompts/skills");
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const skills = entries.map((file) => ({
    name: path.basename(file, ".md"),
    text: readFileSync(path.join(dir, file), "utf8"),
  }));
  // The section number a skill publishes decides its place, so a filename
  // never has to be chosen to make the numbering come out right.
  return skills.sort((left, right) => sectionNumber(left.text) - sectionNumber(right.text));
}

function sectionNumber(text: string): number {
  const match = /^###\s+(\d+)\.\s/m.exec(text);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

const SKILL_PASS_RULES = `You are running one **skill section** of an Android vs iOS audit.

- Analysis only: do not modify files, run shell, or edit configuration.
- Cite paths relative to each platform's repository root with line numbers (\`path/File.kt:12\`).
- Do not invent requirements, APIs, or file paths. Say what you could not verify.
- Section 1 of the business-logic spec is produced in a separate run; publish only the skill section below.`;

function skillPassSpec(skill: { name: string; text: string }): string {
  return [SKILL_PASS_RULES, "", "---", "", skill.text].join("\n");
}

/**
 * One run of the model over one module. The business logic audit is one pass
 * and every skill is another, so each section reaches the page the moment its
 * own run finishes instead of waiting for the slowest.
 */
export interface AuditPass {
  /** `logic`, or the skill's file name. */
  id: string;
  /** What the page shows while it runs, e.g. "UI Difference". */
  title: string;
  /** The system prompt: the main spec, plus the skill for a skill pass. */
  spec: string;
  /** The heading the published text must start at. */
  firstHeading: string;
  /** Which sections this run publishes, as told to the model. */
  publishes: string;
}

export function auditPasses(projectRoot: string): AuditPass[] {
  const main = readAuditSpec(projectRoot);
  const passes: AuditPass[] = [
    {
      id: "logic",
      title: "Business logic",
      spec: main,
      firstHeading: "### 1. Business Logic Difference Matrix",
      publishes: "section 1 of the main spec (Business Logic Difference Matrix), and nothing else",
    },
  ];
  for (const skill of readSkills(projectRoot)) {
    const heading = /^###\s+\d+\.\s.*$/m.exec(skill.text)?.[0].trim() ?? `### ${skill.name}`;
    passes.push({
      id: skill.name,
      title: heading.replace(/^###\s+\d+\.\s+/, ""),
      spec: skillPassSpec(skill),
      firstHeading: heading,
      publishes: `only the skill's section, "${heading.replace(/^###\s+/, "")}"`,
    });
  }
  return passes;
}

/**
 * The Claude Code CLI signs in the way the user already does and lets the audit
 * read the repositories for itself, so it is the default wherever it is
 * installed. The API runner is the fallback and has to bundle the source up
 * front, which caps how much of a feature it can see.
 */
export function pickRunner(): Runner {
  const forced = process.env.MIRROR_AI_RUNNER;
  if (forced === "cli" || forced === "api" || forced === "budget") return forced;
  if (forced === "cursor") {
    if (canUseCursorRunner()) return "cursor";
    if (hasClaudeCli()) return "cli";
    if (process.env.ANTHROPIC_API_KEY?.trim()) return "api";
    return "cursor";
  }
  if (preferCursorRunner()) return "cursor";
  if (hasClaudeCli()) return "cli";
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "api";
  if (canUseCursorRunner()) return "cursor";
  return "api";
}

let claudeCli: boolean | null = null;

function hasClaudeCli(): boolean {
  if (claudeCli === null) {
    const probe = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000 });
    claudeCli = probe.status === 0;
  }
  return claudeCli;
}

export interface PassResult {
  markdown: string;
  cached: boolean;
  /** When a saved section was first written. */
  at?: string;
  file?: string;
  failed: boolean;
}

/**
 * Runs every pass for every module and joins them, for callers that want the
 * whole report at once. The page uses `AuditJobs` instead, which shows each
 * section as it arrives.
 */
export async function auditModules(request: AuditRequest): Promise<AuditResult> {
  const passes = auditPasses(request.projectRoot);
  const tasks = request.defs.flatMap((def) => passes.map((pass) => ({ def, pass })));
  const results = await mapWithLimit(tasks, CONCURRENCY, ({ def, pass }) => runPass(request, def, pass));
  const modules = request.defs.map((def, index) => {
    const mine = results.slice(index * passes.length, (index + 1) * passes.length);
    const fresh = mine.filter((result) => !result.cached);
    return {
      markdown: [moduleHeading(def, request.mode), ...mine.map((result) => result.markdown)].join("\n\n"),
      entry: {
        label: def.label,
        cached: fresh.length === 0,
        at: mine.map((result) => result.at).filter(Boolean).sort()[0],
        file: mine.find((result) => result.file)?.file,
      },
    };
  });
  return {
    markdown: modules.map((module) => module.markdown).join("\n\n---\n\n"),
    modules: modules.map((module) => module.entry),
  };
}

export function moduleHeading(def: ModuleDef, mode: ComparisonMode = "module"): string {
  if (mode === "repository") return "# Android vs iOS — full repository comparison";
  return `# Business logic audit — ${def.label}`;
}

/** Runs still in progress, by report key, so a second ask joins the first. */
const inFlight = new Map<string, Promise<PassResult>>();

/**
 * One pass over one module: served from a saved section when one matches, or
 * joined to the identical run already going — clicking Find differences again
 * mid-run must not start the same minutes-long audit twice.
 */
export function runPass(request: AuditRequest, def: ModuleDef, pass: AuditPass): Promise<PassResult> {
  const identity = reportIdentity(request, def, pass, pickRunner());
  const key = reportKey(identity);
  const running = inFlight.get(key);
  if (running) return running;
  const run = runPassOnce(request, def, pass, identity).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/**
 * The saved section for this pass, if there is one. A saved section is the
 * same section: same module, same commits, same prompt, same runner, so
 * returning it is free and takes no minutes. Synchronous, so a job can show
 * saved sections in its very first response.
 */
export function savedPass(request: AuditRequest, def: ModuleDef, pass: AuditPass): PassResult | null {
  if (request.refresh) return null;
  const saved = readSavedReport(reportIdentity(request, def, pass, pickRunner()));
  if (!saved) return null;
  return { markdown: saved.markdown.trimEnd(), cached: true, at: saved.meta.createdAt, file: saved.file, failed: false };
}

async function runPassOnce(
  request: AuditRequest,
  def: ModuleDef,
  pass: AuditPass,
  identity: ReportIdentity,
): Promise<PassResult> {
  const runner = identity.runner as Runner;
  const saved = savedPass(request, def, pass);
  if (saved) return saved;
  const row = request.rows.find((item) => item.key === def.id) ?? null;
  const graphEvidence = prepareGraphEvidence(request, def);
  const started = Date.now();
  try {
    const markdown =
      runner === "budget"
        ? await runBudget(pass, request, def)
        : runner === "cli"
        ? await runCli(pass, request, def, row, graphEvidence)
        : runner === "cursor"
          ? await runCursor(pass, request, def, row, graphEvidence)
          : await runApi(apiClient(), pass, request, def, row, graphEvidence);
    const file = saveReport(identity, markdown, Date.now() - started);
    return { markdown, cached: false, file, failed: false };
  } catch (error) {
    // A failed run is not worth keeping — the next attempt should try again.
    return {
      markdown: `${pass.firstHeading}\n\n**This section could not be produced.** ${describeError(error)}`,
      cached: false,
      failed: true,
    };
  }
}

let client: Anthropic | null = null;

function apiClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** System prompt for a pass; api-skill includes the superapp-workspace workflow. */
export function passSpec(request: AuditRequest, pass: AuditPass): string {
  if (pass.id !== "api-skill") return pass.spec;
  const workflow = readApiDriftWorkflow(request.projectRoot);
  const parts = [
    pass.spec,
    "---",
    "# Canonical API contract drift workflow (superapp-workspace)",
    workflow,
    "---",
    apiDriftScopeNote(request.mode),
  ].filter((part) => part.trim().length > 0);
  return parts.join("\n\n");
}

function reportIdentity(request: AuditRequest, def: ModuleDef, pass: AuditPass, runner: Runner): ReportIdentity {
  const spec = passSpec(request, pass);
  return {
    projectRoot: request.projectRoot,
    androidPath: request.androidPath,
    iosPath: request.iosPath,
    moduleKey: def.id,
    label: pass.id === "logic" ? def.label : `${def.label} · ${pass.title}`,
    prompts: promptsFingerprint(`${pass.id}\u0000${spec}`),
    runner,
    effort: identityEffort(runner, request),
    model: resolveAuditModel(runner, request),
  };
}

// ---------------------------------------------------------- the budget path

/**
 * Two batch stages over every module still missing a section, shared by all of
 * this request's passes: the first ask pays, the rest reuse its outcome.
 */
/** What a budget audit of these modules should cost, without spending anything. */
export function estimateBudget(request: AuditRequest): Promise<BudgetEstimate> {
  const passes = auditPasses(request.projectRoot);
  const specs = passes.map((item) => ({ pass: item, spec: passSpec(request, item) }));
  const pending = request.defs.filter((item) => passes.some((candidate) => !savedPass(request, item, candidate)));
  return estimateBudgetAudit(request, pending, specs);
}

async function runBudget(pass: AuditPass, request: AuditRequest, def: ModuleDef): Promise<string> {
  const passes = auditPasses(request.projectRoot);
  const specs = passes.map((item) => ({ pass: item, spec: passSpec(request, item) }));
  const pending = request.defs.filter((item) => passes.some((candidate) => !savedPass(request, item, candidate)));
  const outcome = await auditModuleOnBudget(request, def, pending, specs);
  if (outcome.error) throw new Error(outcome.error);
  const markdown = outcome.sections?.[pass.id];
  if (!markdown) throw new Error("The budget run produced no text for this section.");
  return markdown;
}

// ---------------------------------------------------------------- the brief

function featureBrief(request: AuditRequest, def: ModuleDef, row: ModuleRow | null): string {
  if (request.mode === "repository") {
    const lines = [
      "Audit **both entire applications** — every feature, flow, screen, and API surface you can trace in the checkouts below.",
      "",
      "There is no single module enum to anchor on. Explore each repository broadly with Read, Grep and Glob; follow navigation, DI, routes and network layers until you understand how the apps are structured on each platform.",
      "",
    ];
    for (const [platform, root] of [["Android", request.androidPath], ["iOS", request.iosPath]]) {
      const { branch, commit } = checkoutInfo(root);
      if (commit) lines.push(`- ${platform} checkout: branch \`${branch || "detached"}\` @ \`${commit}\`.`);
    }
    return lines.join("\n");
  }
  if (def.files) {
    const cap = 300;
    const list = (files: string[]) => [...files.slice(0, cap).map((file) => `  - \`${file}\``), ...(files.length > cap ? [`  - …and ${files.length - cap} more`] : [])];
    const lines = [
      `Audit the **${def.label}** section: the code no common module claims.`,
      "",
      "It holds code of modules only one platform declares, of modules missing from or badly defined in the module enum, and code that belongs to no module. Pair Android and iOS code by what it does, not by name; code with no counterpart on the other platform is itself a finding.",
      "",
    ];
    for (const [platform, root] of [["Android", request.androidPath], ["iOS", request.iosPath]]) {
      const { branch, commit } = checkoutInfo(root);
      if (commit) lines.push(`- ${platform} checkout: branch \`${branch || "detached"}\` @ \`${commit}\`.`);
    }
    lines.push(`- Android files (${def.files.android.length}):`, ...list(def.files.android));
    lines.push(`- iOS files (${def.files.ios.length}):`, ...list(def.files.ios));
    return lines.join("\n");
  }
  const lines = [`Audit this module: **${def.label}** (enum constant \`${def.id.toUpperCase()}\`).`, ""];
  for (const [platform, root] of [["Android", request.androidPath], ["iOS", request.iosPath]]) {
    const { branch, commit } = checkoutInfo(root);
    if (commit) lines.push(`- ${platform} checkout: branch \`${branch || "detached"}\` @ \`${commit}\`.`);
  }
  if (row?.android) {
    lines.push(`- Android declares it as \`${row.android.enumName}.${row.android.caseName}\` in \`${row.android.file}:${row.android.line}\`.`);
  } else {
    lines.push("- Android does not declare this module in its module enum.");
  }
  if (row?.ios) {
    lines.push(`- iOS declares it as \`${row.ios.enumName}.${row.ios.caseName}\` in \`${row.ios.file}:${row.ios.line}\`.`);
  } else {
    lines.push("- iOS does not declare this module in its module enum.");
  }
  lines.push(`- Names worth searching for: ${def.keywords.join(", ")}.`);
  return lines.join("\n");
}

function reportShape(pass: AuditPass): string {
  return `Write only the report, in GitHub-flavored Markdown, starting at the line
"${pass.firstHeading}". This run publishes ${pass.publishes}. Use the section
headings and table columns that define it. No preamble, no description of what
you did, no closing remarks.

Cite code as the path relative to **that platform's own repository root**, plus
the line: \`path/to/File.kt:124\`, or \`path/to/File.kt:124-129\` for a range. An
iOS file is cited relative to the iOS root even though the working directory is
the Android checkout — write \`LLA-SuperApp-iOS/Core/Foo.swift:12\`, never an
absolute path beginning with a slash. Do not abbreviate with "..." or shorten to
a bare filename either. The reader's page turns each citation into a code
preview by looking the path up, and anything else may not resolve.`;
}

// ------------------------------------------------------------- the CLI path

const CLI_NOTE = `---

## How this audit runs

You are auditing two checked-out repositories. Read them yourself with Read,
Grep and Glob — follow imports, call sites and navigation until you understand
the whole flow on each platform. You cannot run code or edit anything, and
there is nobody to answer a question, so the feature to audit is given to you
and Phase 1 never needs to ask which one it is.`;

function cliNote(graphEvidence: string): string {
  if (!graphEvidence.trim()) return CLI_NOTE;
  return `${CLI_NOTE}

When **Codegraph evidence** is present in the user message, start there and use
Read/Grep only to fill gaps — do not re-scan the whole repository.`;
}

function prepareGraphEvidence(request: AuditRequest, def: ModuleDef): string {
  if (!codegraphEnabled() || request.mode === "repository") return "";
  try {
    ensureCodegraphIndex(request.androidPath);
    ensureCodegraphIndex(request.iosPath);
    return buildGraphEvidenceMarkdown(request.androidPath, request.iosPath, def.keywords);
  } catch {
    return "";
  }
}

function resolveLeads(request: AuditRequest, def: ModuleDef): string {
  return request.moduleLeads?.[def.id] ?? request.leads ?? "";
}

function userPromptParts(
  request: AuditRequest,
  def: ModuleDef,
  row: ModuleRow | null,
  graphEvidence: string,
): string[] {
  const parts = [
    featureBrief(request, def, row),
    "",
    `Android repository root: \`${request.androidPath}\` (your working directory).`,
    `iOS repository root: \`${request.iosPath}\`.`,
  ];
  if (graphEvidence.trim()) {
    parts.push("", graphEvidence);
  }
  const leads = leadsSection(resolveLeads(request, def));
  if (leads) parts.push("", leads);
  return parts;
}

async function runCursor(
  pass: AuditPass,
  request: AuditRequest,
  def: ModuleDef,
  row: ModuleRow | null,
  graphEvidence: string,
): Promise<string> {
  const prompt = userPromptParts(request, def, row, graphEvidence).join("\n");
  const systemAppend = `${passSpec(request, pass)}\n\n${cliNote(graphEvidence)}\n\n${reportShape(pass)}`;
  const settings = runSettings(request);
  return runCursorAgent({
    prompt,
    systemAppend,
    cwd: request.androidPath,
    addDir: request.iosPath,
    effort: settings.effort,
    model: settings.cursorModel ?? undefined,
    timeoutMs: TIMEOUT_MS,
  });
}

async function runCli(
  pass: AuditPass,
  request: AuditRequest,
  def: ModuleDef,
  row: ModuleRow | null,
  graphEvidence: string,
): Promise<string> {
  const prompt = userPromptParts(request, def, row, graphEvidence).join("\n");
  const args = [
    "-p",
    prompt,
    "--model",
    resolveCliModel(),
    "--effort",
    effortFor(request),
    "--output-format",
    "json",
    // Analysis only, per the spec's constraints: no shell, no writes.
    "--restricted",
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "--disallowedTools",
    "Write",
    "Edit",
    "WebFetch",
    "WebSearch",
    // A pending wakeup or cron keeps `claude -p` alive after the report is
    // written, so the run sits idle until the timer fires or TIMEOUT_MS hits.
    "ScheduleWakeup",
    "CronCreate",
    "--permission-mode",
    "dontAsk",
    "--add-dir",
    request.iosPath,
    "--append-system-prompt",
    `${passSpec(request, pass)}\n\n${cliNote(graphEvidence)}\n\n${reportShape(pass)}`,
  ];
  const result = await run("claude", args, request.androidPath);
  let payload: { result?: unknown; is_error?: boolean };
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    if (result.code !== 0) {
      throw new Error(cliFailureMessage(result));
    }
    throw new Error(`The \`claude\` CLI returned output that was not JSON: ${firstLine(result.stdout)}`);
  }
  if (result.code !== 0) {
    throw new Error(cliFailureMessage(result, payload));
  }
  const text = typeof payload.result === "string" ? payload.result.trim() : "";
  if (payload.is_error) throw new Error(text || "The CLI reported an error with no detail.");
  if (!text) throw new Error("The CLI returned an empty report.");
  return text;
}

function cliFailureMessage(
  result: { code: number; stdout: string; stderr: string },
  payload?: { result?: unknown; is_error?: boolean },
): string {
  const fromJson =
    payload && typeof payload.result === "string" && payload.result.trim()
      ? payload.result.trim()
      : "";
  const detail = fromJson || meaningfulCliOutput(result.stderr) || meaningfulCliOutput(result.stdout) || "No output.";
  if (/not logged in/i.test(detail)) {
    return `The \`claude\` CLI is not signed in. Run \`claude login\` once, or set MIRROR_AI_RUNNER=cursor and run \`agent login\`, or use MIRROR_AI_RUNNER=api with ANTHROPIC_API_KEY. (${detail})`;
  }
  return `The \`claude\` CLI exited with ${result.code}. ${detail}`;
}

/** Skip Claude's stdin idle warning when choosing a user-visible error line. */
function meaningfulCliOutput(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/no stdin data received/i.test(line));
  return lines[0] ?? "";
}

function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Claude -p waits briefly for stdin when inherited; ignore avoids the warning and delay.
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The audit ran past ${Math.round(TIMEOUT_MS / 60000)} minutes and was stopped.`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

// ------------------------------------------------------------- the API path

function apiNote(mode: ComparisonMode): string {
  const scope =
    mode === "repository"
      ? `Files were selected across the whole repository up to a size budget, so coverage
is partial by construction. Each repository section lists files that matched
but were left out for size. Honour the spec's constraint about not claiming full
coverage: say plainly which parts of each app you could not see, and classify a
finding as Runtime Verification Required rather than guessing.`
      : `Files were selected by keyword match on the module's enum constant, so coverage
is partial by construction. Each repository section lists the files that matched
but were left out for size. Honour the spec's constraint about not claiming full
coverage: say plainly which parts of the flow you could not see, and classify a
finding as Runtime Verification Required rather than guessing.`;
  return `---

## How this audit runs

You are auditing two repositories that have already been checked out. The
source files below are the complete evidence available to you — you cannot run
code, open other files, or ask a question. The feature to audit is named in the
user message, so Phase 1 never needs to ask which one it is.

${scope}

Every file path and line number you cite must come from the evidence below.`;
}

async function runApi(
  client: Anthropic,
  pass: AuditPass,
  request: AuditRequest,
  def: ModuleDef,
  row: ModuleRow | null,
  graphEvidence: string,
): Promise<string> {
  const repositoryWide = request.mode === "repository";
  const needles = def.keywords.map((keyword) => keyword.toLowerCase());
  const android = gatherEvidence(request.androidPath, needles, repositoryWide, def.files?.android);
  const ios = gatherEvidence(request.iosPath, needles, repositoryWide, def.files?.ios);
  if (android.included.length === 0 && ios.included.length === 0) {
    const reason =
      repositoryWide
        ? "No source files were available in either checkout."
        : `No source file on either platform mentions ${def.keywords.join(", ")}, so there is nothing to audit for this module.`;
    return `${pass.firstHeading}\n\n${reason}`;
  }
  const stream = client.messages.stream({
    model: resolveApiModel(),
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: { effort: effortFor(request) },
    system: [
      {
        type: "text",
        text: `${passSpec(request, pass)}\n\n${apiNote(request.mode)}\n\n${reportShape(pass)}`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: buildEvidence(request, def, row, android, ios, graphEvidence) }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error(`The model declined this module (${message.stop_details?.explanation ?? "no explanation given"}).`);
  }
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (message.stop_reason === "max_tokens") {
    return `${text}\n\n> This report hit the output limit and is cut short. Audit fewer modules at a time.`;
  }
  return text;
}

function buildEvidence(
  request: AuditRequest,
  def: ModuleDef,
  row: ModuleRow | null,
  android: Evidence,
  ios: Evidence,
  graphEvidence: string,
): string {
  const title =
    request.mode === "repository" ? "# Scope: full repository (both platforms)" : `# Feature to audit: ${def.label}`;
  const lines = [title, "", featureBrief(request, def, row), ""];
  if (graphEvidence.trim()) {
    lines.push(graphEvidence, "");
  }
  writeRepo(lines, "Android", request.androidPath, android);
  writeRepo(lines, "iOS", request.iosPath, ios);
  const leads = leadsSection(resolveLeads(request, def));
  if (leads) lines.push(leads);
  return lines.join("\n");
}

function writeRepo(lines: string[], platform: string, root: string, evidence: Evidence): void {
  lines.push(`# ${platform} repository`);
  lines.push("");
  lines.push(`Root: \`${path.resolve(root)}\``);
  lines.push(`${evidence.matched} file(s) matched; ${evidence.included.length} included in full below.`);
  if (evidence.skipped.length > 0) {
    lines.push("");
    lines.push("Matched but not included (size budget) — treat as uninspected:");
    for (const file of evidence.skipped) lines.push(`- \`${file}\``);
  }
  lines.push("");
  for (const source of evidence.included) {
    lines.push(`## \`${source.relativePath}\``);
    lines.push("");
    lines.push("```" + fenceLanguage(source.relativePath));
    lines.push(source.text);
    lines.push("```");
    lines.push("");
  }
}

/** Ranks matched files by keyword hits, or by path when auditing the whole repo. */
function gatherEvidence(root: string, needles: string[], repositoryWide = false, only?: string[]): Evidence {
  const matched: { source: RepoSource; hits: number }[] = [];
  const wanted = only ? new Set(only) : null;
  const sources = wanted ? readSources(root).filter((source) => wanted.has(source.relativePath)) : readSources(root);
  const sourceByPath = new Map(sources.map((source) => [source.relativePath, source]));

  if (codegraphEnabled() && !repositoryWide && !wanted && needles.length > 0) {
    const ranked = rankFilesForKeywords(root, needles);
    for (let index = 0; index < ranked.length; index++) {
      const source = sourceByPath.get(ranked[index]);
      if (source) matched.push({ source, hits: ranked.length - index });
    }
  }

  if (matched.length === 0) {
    for (const source of sources) {
      if (repositoryWide || wanted) {
        matched.push({ source, hits: wanted ? miscFileScore(source) : 1 });
        continue;
      }
      let hits = 0;
      for (const needle of needles) {
        if (source.lower.includes(needle.toLowerCase())) hits += 1;
      }
      if (hits > 0) matched.push({ source, hits });
    }
  }
  matched.sort(
    (left, right) =>
      right.hits - left.hits ||
      left.source.relativePath.localeCompare(right.source.relativePath),
  );
  const ranked = matched.slice(0, MAX_FILES_PER_SIDE);
  const included: RepoSource[] = [];
  const skipped: string[] = [];
  let used = 0;
  for (const entry of ranked) {
    // Whole files only — a half-read file reads as a complete one and invites
    // conclusions about code the model never saw.
    if (used + entry.source.text.length > EVIDENCE_BUDGET && included.length > 0) {
      skipped.push(entry.source.relativePath);
      continue;
    }
    included.push(entry.source);
    used += entry.source.text.length;
  }
  for (const entry of matched.slice(MAX_FILES_PER_SIDE)) skipped.push(entry.source.relativePath);
  return { included, skipped: skipped.sort(), matched: matched.length };
}

// ------------------------------------------------------------------ shared

function leadsSection(leads: string): string {
  if (!leads.trim()) return "";
  return [
    "# Heuristic leads",
    "",
    "A static keyword matcher produced the notes below. They are unverified and often wrong. Confirm each one against the source, or discard it; do not carry one into the report on its say-so.",
    "",
    leads.trim(),
    "",
  ].join("\n");
}

function fenceLanguage(file: string): string {
  if (/\.(kt|kts)$/.test(file)) return "kotlin";
  if (/\.java$/.test(file)) return "java";
  if (/\.swift$/.test(file)) return "swift";
  return "";
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "The Claude API rejected the credentials. Export ANTHROPIC_API_KEY, or install the Claude Code CLI so the audit can use your existing login.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "The Claude API rate limit was reached. Wait and retry, or tick fewer modules.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Claude API error ${error.status}: ${error.message}`;
  }
  if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return "The audit CLI could not be started. In Cursor run `agent login` once, or install Claude Code, or set ANTHROPIC_API_KEY with MIRROR_AI_RUNNER=api.";
  }
  if (error instanceof Error) return error.message;
  return "The request failed.";
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
