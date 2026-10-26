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
  return probe.status === 0 || out.includes("logged in");
}

export function resolveCursorModel(effort: string): string {
  const base = process.env.MIRROR_AI_CURSOR_MODEL?.trim() || DEFAULT_CURSOR_MODEL;
  if (base.includes("[")) return base;
  if (effort && effort !== "medium") return `${base}[effort=${effort}]`;
  return base;
}

export interface CursorAgentRun {
  prompt: string;
  systemAppend: string;
  cwd: string;
  addDir: string;
  effort: string;
  timeoutMs: number;
}

export function runCursorAgent(request: CursorAgentRun): Promise<string> {
  const model = resolveCursorModel(request.effort);
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
    const child = spawn("agent", args, { cwd: request.cwd, env: process.env });
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
        reject(
          new Error(
            `The Cursor agent CLI exited with ${code ?? 1}. ${firstLine(err) || firstLine(out) || "No output."}`,
          ),
        );
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

/** Prefer the Cursor agent runner in Cursor sessions when the CLI is installed. */
export function preferCursorRunner(): boolean {
  if (process.env.MIRROR_AI_PREFER_CURSOR === "0") return false;
  return isCursorSession() && hasCursorAgentCli();
}
