import { spawn, spawnSync } from "node:child_process";
import { isCursorSession, OPUS_55_CLI } from "./audit-models.ts";

const DEFAULT_CURSOR_MODEL = OPUS_55_CLI;

let cursorAgentCli: boolean | null = null;

/** Cursor Agent CLI (`agent` on PATH), installed with Cursor or `agent update`. */
export function hasCursorAgentCli(): boolean {
  if (cursorAgentCli === null) {
    const probe = spawnSync("agent", ["--version"], { encoding: "utf8", timeout: 15_000 });
    cursorAgentCli = probe.status === 0;
  }
  return cursorAgentCli;
}

export function cursorAgentLoggedIn(): boolean {
  if (!hasCursorAgentCli()) return false;
  const probe = spawnSync("agent", ["status"], { encoding: "utf8", timeout: 15_000 });
  const out = `${probe.stdout}\n${probe.stderr}`.toLowerCase();
  if (out.includes("not logged in")) return false;
  if (/authentication required|run ['`]agent login/i.test(out)) return false;
  return probe.status === 0 || out.includes("logged in");
}

/** Cursor agent audits need `agent login` or `CURSOR_API_KEY` — not merely `agent` on PATH. */
export function canUseCursorRunner(): boolean {
  if (!hasCursorAgentCli()) return false;
  if (process.env.CURSOR_API_KEY?.trim()) return true;
  return cursorAgentLoggedIn();
}

/** The agent CLI takes `claude-opus-5-5-high`, not `claude-opus-5-5[effort=high]`. */
export function resolveCursorModel(effort: string): string {
  const configured = process.env.MIRROR_AI_CURSOR_MODEL?.trim() || DEFAULT_CURSOR_MODEL;
  const bracket = configured.match(/^([^[]+)\[effort=([^\]]+)\]$/);
  const base = (bracket?.[1] ?? configured).trim();
  const level = (bracket?.[2] ?? effort).trim();
  if (hasEffortSuffix(base)) return base;
  if (base === DEFAULT_CURSOR_MODEL) return `${base}-${opusEffort(level)}`;
  return base;
}

function hasEffortSuffix(model: string): boolean {
  return /-(none|minimal|low|medium|high|xhigh|max)$/.test(model);
}

/** Opus 5.5 is published as low, medium, and high on the agent CLI. */
function opusEffort(effort: string): "low" | "medium" | "high" {
  if (effort === "low" || effort === "medium") return effort;
  return "high";
}

export interface CursorAgentRun {
  prompt: string;
  systemAppend: string;
  cwd: string;
  addDir: string;
  effort: string;
  /** When set, used as `--model` instead of deriving from effort. */
  model?: string;
  timeoutMs: number;
}

export function runCursorAgent(request: CursorAgentRun): Promise<string> {
  const model = request.model?.trim() || resolveCursorModel(request.effort);
  const fullPrompt = [request.systemAppend, "", request.prompt].filter(Boolean).join("\n");
  const args = [
    "-p",
    fullPrompt,
    "--model",
    model,
    "--mode",
    "ask",
    "--output-format",
    "text",
    "--trust",
    "--workspace",
    request.cwd,
    "--add-dir",
    request.addDir,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("agent", args, { cwd: request.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The Cursor agent ran past ${Math.round(request.timeoutMs / 60000)} minutes and was stopped.`));
    }, request.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        const detail = firstLine(err) || firstLine(out) || "No output.";
        const message = /authentication required|agent login/i.test(`${err}\n${out}`)
          ? `The Cursor agent is not signed in. ${runnerAuthHint()} (${detail})`
          : `The Cursor agent CLI exited with ${code ?? 1}. ${detail}`;
        reject(new Error(message));
        return;
      }
      if (!out) {
        reject(new Error("The Cursor agent returned an empty report."));
        return;
      }
      resolve(out);
    });
  });
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

/** Prefer the Cursor agent runner in Cursor sessions when the CLI can authenticate. */
export function preferCursorRunner(): boolean {
  if (process.env.MIRROR_AI_PREFER_CURSOR === "0") return false;
  return isCursorSession() && canUseCursorRunner();
}

function runnerAuthHint(): string {
  return "Run `agent login` once (Cursor plan), or set CURSOR_API_KEY, or use MIRROR_AI_RUNNER=cli after `claude login`, or MIRROR_AI_RUNNER=api with ANTHROPIC_API_KEY.";
}
