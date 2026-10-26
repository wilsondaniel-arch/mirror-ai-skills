import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pickRunner } from "./audit.ts";
import { resolveApiModel, resolveCliModel } from "./audit-models.ts";
import { runCursorAgent } from "./cursor-agent.ts";
import { readSources } from "./scan.ts";
import { screenshotDir } from "./screenshots.ts";
import type { IosPreview } from "./screenshot-render-ios.ts";
const EFFORT = (process.env.MIRROR_AI_PREVIEW_EFFORT || "medium") as "low" | "medium" | "high";
const TIMEOUT_MS = Number(process.env.MIRROR_AI_PREVIEW_TIMEOUT_MS) || 900_000;
/** Characters of view source sent on the API path, where the model cannot read the repo itself. */
const SOURCE_BUDGET = 120_000;
const MAX_VIEW_FILES = 12;
const SAVED_FILE = "previews.json";

export interface PreviewWriteRequest {
  iosPath: string;
  /** The app module the test target `@testable import`s. */
  module: string;
  keywords: string[];
  max: number;
}

export interface ViewFile {
  /** Repo-relative path. */
  file: string;
  /** Views a test target can name: neither `private` nor `fileprivate`. */
  views: string[];
}

/**
 * Most apps never write `#Preview`s, so a module would otherwise get no iOS
 * frames at all. This asks Claude to write them: it reads the module's views
 * and returns preview bodies that build each one from sample data, in the same
 * shape `parsePreviews` reads out of a real `#Preview`.
 */
export async function writeIosPreviews(request: PreviewWriteRequest): Promise<IosPreview[]> {
  const files = findIosViews(request.iosPath, request.keywords).slice(0, MAX_VIEW_FILES);
  if (files.length === 0) return [];
  const prompt = writePrompt(request, files);
  const text = await runPreviewModel(request.iosPath, request.module, prompt, files);
  return parseWrittenPreviews(text).slice(0, request.max);
}

/** Asks once more for the frames the compiler rejected, with its errors beside each. */
export async function repairIosPreviews(
  request: PreviewWriteRequest,
  broken: { preview: IosPreview; errors: string[] }[],
): Promise<IosPreview[]> {
  const prompt = `${harnessRules(request.module)}

These preview bodies did not compile. Fix each one, reading the source again
where you need to, and return them in the same JSON shape. Leave out any you
cannot make compile.

${broken
  .map(
    ({ preview, errors }) =>
      `### ${preview.label} (${preview.file})\n\`\`\`swift\n${preview.body.trim()}\n\`\`\`\nErrors:\n${errors.map((error) => `- ${error}`).join("\n")}`,
  )
  .join("\n\n")}`;
  const files = findIosViews(request.iosPath, request.keywords).slice(0, MAX_VIEW_FILES);
  const text = await runPreviewModel(request.iosPath, request.module, prompt, files);
  return parseWrittenPreviews(text);
}

/** Swift files in the module that declare a SwiftUI view the test target can see. */
export function findIosViews(iosPath: string, keywords: string[]): ViewFile[] {
  const needles = [...new Set(keywords.map(squash).filter((keyword) => keyword.length >= 4))];
  const found: ViewFile[] = [];
  for (const source of readSources(iosPath)) {
    if (!source.relativePath.endsWith(".swift")) continue;
    if (/Tests?\//.test(source.relativePath)) continue;
    if (!needles.some((needle) => squash(source.relativePath).includes(needle))) continue;
    const views = [...source.text.matchAll(/^([ \t]*(?:\w+[ \t]+)*)struct[ \t]+(\w+)(?:<[^>{]*>)?[ \t]*:[^{]*\bView\b/gm)]
      .filter((match) => !/\b(private|fileprivate)\b/.test(match[1]))
      .map((match) => match[2]);
    if (views.length > 0) found.push({ file: source.relativePath, views });
  }
  // Screens first: a file named for its view beats a helper row or modifier.
  return found.sort((left, right) => score(right) - score(left));
}

/** The JSON array the model returns, read leniently: a fence or prose around it is ignored. */
export function parseWrittenPreviews(text: string): IosPreview[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let items: unknown;
  try {
    items = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const previews: IosPreview[] = [];
  const labels = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const { file, label, body } = item as Record<string, unknown>;
    if (typeof file !== "string" || typeof label !== "string" || typeof body !== "string") continue;
    // `@Previewable` only compiles inside the macro, as with a real `#Preview`.
    if (!body.trim() || body.includes("@Previewable")) continue;
    if (labels.has(label)) continue;
    labels.add(label);
    previews.push({ file, label, body: `\n${body.trim()}\n` });
  }
  return previews;
}

/** Previews that rendered for this module last time, so a re-render skips the model. */
export function savedIosPreviews(projectRoot: string, moduleKey: string, iosPath: string): IosPreview[] {
  const file = path.join(screenshotDir(projectRoot, moduleKey, "ios"), SAVED_FILE);
  if (!existsSync(file)) return [];
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { iosPath?: string; previews?: IosPreview[] };
    return saved.iosPath === path.resolve(iosPath) && Array.isArray(saved.previews) ? saved.previews : [];
  } catch {
    return [];
  }
}

export function saveIosPreviews(projectRoot: string, moduleKey: string, iosPath: string, previews: IosPreview[]): void {
  const dir = screenshotDir(projectRoot, moduleKey, "ios");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, SAVED_FILE), JSON.stringify({ iosPath: path.resolve(iosPath), previews }, null, 2));
}

function harnessRules(module: string): string {
  return `Each preview body is pasted, unchanged, into this generated XCTest file in the
app's unit-test target, which runs hosted in the app on an iPhone simulator:

\`\`\`swift
import XCTest
import SwiftUI
@testable import ${module}

final class MirrorAIFrames: XCTestCase {
    @MainActor @ViewBuilder
    static func frame0() -> some View {
        <BODY>
    }
}
\`\`\`

Rules for a body:
- It is a SwiftUI result-builder body: \`let\` declarations, then one view expression.
- \`private\` and \`fileprivate\` declarations are invisible from the test target. Build
  only views and models that are \`internal\` or wider, and write sample values inline.
- Supply every \`@EnvironmentObject\` the view (or its children) reads, with
  \`.environmentObject(...)\`, or the test crashes. Shared singletons may be used as-is.
- Show the screen in a realistic, populated state with plausible sample data. No
  network, no \`#Preview\`, no \`@Previewable\`, no \`PreviewProvider\`.
- Do not add helper types, extensions or top-level declarations; only the body.

Answer with only a JSON array, no prose:
[{"file": "<repo-relative path of the view>", "label": "<short screen name>", "body": "<swift>"}]`;
}

function writePrompt(request: PreviewWriteRequest, files: ViewFile[]): string {
  return `${harnessRules(request.module)}

Write previews for up to ${request.max} screens of the "${request.keywords[0] ?? "this"}" feature in the iOS
app at \`${request.iosPath}\`. Prefer whole screens and sheets over rows and
small components, and cover distinct states (for example a populated list, an
empty list, an error) when the view supports them. Read each view and the
models and environment objects it needs before writing its body.

Candidate view files:
${files.map((entry) => `- ${entry.file}: ${entry.views.join(", ")}`).join("\n")}`;
}

async function runPreviewModel(
  iosPath: string,
  module: string,
  prompt: string,
  files: ViewFile[],
): Promise<string> {
  const runner = pickRunner();
  if (runner === "cli") return runCli(iosPath, prompt);
  if (runner === "cursor") {
    return runCursorAgent({
      prompt,
      systemAppend: harnessRules(module),
      cwd: iosPath,
      addDir: iosPath,
      effort: EFFORT,
      timeoutMs: TIMEOUT_MS,
    });
  }
  return runApi(iosPath, prompt, files);
}

async function runCli(iosPath: string, prompt: string): Promise<string> {
  const args = [
    "-p",
    prompt,
    "--model",
    resolveCliModel(),
    "--effort",
    EFFORT,
    "--output-format",
    "json",
    // Reading only: the harness file is written by Mirror AI, not the model.
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
    "ScheduleWakeup",
    "CronCreate",
    "--permission-mode",
    "dontAsk",
  ];
  const result = await run("claude", args, iosPath);
  if (result.code !== 0) throw new Error(`The \`claude\` CLI exited with ${result.code} while writing iOS previews.`);
  let payload: { result?: unknown; is_error?: boolean };
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("The `claude` CLI returned output that was not JSON while writing iOS previews.");
  }
  const text = typeof payload.result === "string" ? payload.result : "";
  if (payload.is_error) throw new Error(text || "The CLI reported an error while writing iOS previews.");
  return text;
}

async function runApi(iosPath: string, prompt: string, files: ViewFile[]): Promise<string> {
  let budget = SOURCE_BUDGET;
  const sources: string[] = [];
  for (const entry of files) {
    const text = readFileSync(path.join(iosPath, entry.file), "utf8");
    if (text.length > budget) break;
    budget -= text.length;
    sources.push(`### ${entry.file}\n\`\`\`swift\n${text}\n\`\`\``);
  }
  const message = await new Anthropic().messages
    .stream({
      model: resolveApiModel(),
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      messages: [
        {
          role: "user",
          content: `${prompt}\n\nYou cannot read the repository, so its view sources are below. Use only types you can see here or in SwiftUI.\n\n${sources.join("\n\n")}`,
        },
      ],
    })
    .finalMessage();
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    const stdout: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Writing iOS previews ran past ${Math.round(TIMEOUT_MS / 60000)} minutes and was stopped.`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8") });
    });
  });
}

function score(entry: ViewFile): number {
  const stem = path.basename(entry.file, ".swift");
  const named = entry.views.includes(stem) ? 2 : 0;
  const screen = /(View|Screen|Sheet)$/.test(stem) ? 1 : 0;
  return named + screen;
}

/** `AUTO_PAY`, `AutoPay` and `auto-pay` all read as `autopay`. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
