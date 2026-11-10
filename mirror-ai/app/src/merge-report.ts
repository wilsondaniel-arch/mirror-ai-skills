/**
 * Completes a report whose run stopped part-way (a usage limit, a timeout):
 * the modules that were redone replace their unfinished sections in place,
 * keeping the original module order, then the HTML, PDF and summary.json are
 * rebuilt from the merged Markdown.
 *
 *   node src/merge-report.ts <run-dir> <redone.md>
 *   node src/merge-report.ts --incomplete <run-dir>     prints the keys to redo
 *
 * <run-dir> holds parity-report.md (and the .html it replaces).
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { markdownToHtml } from "./markdown-html.ts";
import { findChrome, renderReportPdf, reportDocument } from "./pdf.ts";
import { summarizeReport } from "./report-summary.ts";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MODULE_HEADING = /^# Business logic audit — (.+?)\s*$/;
const SEPARATOR = "\n\n---\n\n";

export interface ModuleBlock {
  label: string;
  markdown: string;
}

/** Splits a report into its module blocks; text before the first module heading is kept as a preamble. */
export function splitModules(markdown: string): { preamble: string; modules: ModuleBlock[] } {
  const lines = markdown.split("\n");
  const modules: ModuleBlock[] = [];
  const preamble: string[] = [];
  let current: { label: string; lines: string[] } | null = null;
  for (const line of lines) {
    const heading = MODULE_HEADING.exec(line);
    if (heading) {
      if (current) modules.push({ label: current.label, markdown: tidy(current.lines) });
      current = { label: heading[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) modules.push({ label: current.label, markdown: tidy(current.lines) });
  return { preamble: preamble.join("\n").trim(), modules };
}

/** A block without the trailing rule that separated it from the next module. */
function tidy(lines: string[]): string {
  return lines.join("\n").trimEnd().replace(/\n+---\s*$/, "").trimEnd();
}

const labelKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Replaces each module of `base` that `redone` also has. A redone module that
 * still could not be produced does not replace anything, so a merge never
 * makes the report worse; modules only in `redone` are appended.
 */
export function mergeReports(base: string, redone: string): { markdown: string; replaced: string[]; stillFailed: string[] } {
  const original = splitModules(base);
  const fresh = new Map(splitModules(redone).modules.map((block) => [labelKey(block.label), block]));
  const replaced: string[] = [];
  const stillFailed: string[] = [];
  const modules = original.modules.map((block) => {
    const next = fresh.get(labelKey(block.label));
    if (!next) return block;
    fresh.delete(labelKey(block.label));
    if (incomplete(next.markdown) && !incomplete(block.markdown)) return block;
    if (incomplete(next.markdown)) stillFailed.push(block.label);
    else replaced.push(block.label);
    return next;
  });
  for (const block of fresh.values()) {
    modules.push(block);
    (incomplete(block.markdown) ? stillFailed : replaced).push(block.label);
  }
  const body = modules.map((block) => block.markdown).join(SEPARATOR);
  return { markdown: `${original.preamble ? `${original.preamble}\n\n` : ""}${body}\n`, replaced, stillFailed };
}

function incomplete(markdown: string): boolean {
  return /\*\*This section could not be produced\.\*\*/.test(markdown);
}

/** Module keys (as summary.json writes them) whose sections could not be produced. */
export function incompleteModuleKeys(markdown: string): string[] {
  return summarizeReport(markdown)
    .modules.filter((module) => module.incompleteSections.length > 0)
    .map((module) => module.key);
}

export async function rerender(dir: string, markdown: string): Promise<string> {
  const htmlFile = path.join(dir, "parity-report.html");
  const oldTitle = existsSync(htmlFile) ? /<title>([^<]*)<\/title>/.exec(readFileSync(htmlFile, "utf8"))?.[1] : undefined;
  const css = readFileSync(path.join(projectRoot, "public/app.css"), "utf8");
  const documentHtml = reportDocument(markdownToHtml(markdown), oldTitle ?? "Mirror AI parity report", css);
  writeFileSync(htmlFile, documentHtml);
  writeFileSync(path.join(dir, "summary.json"), `${JSON.stringify(summarizeReport(markdown), null, 2)}\n`);
  const pdfFile = path.join(dir, "parity-report.pdf");
  const chrome = findChrome();
  if (chrome) {
    try {
      writeFileSync(pdfFile, await renderReportPdf(chrome, documentHtml));
      return "PDF rebuilt";
    } catch (error) {
      if (existsSync(pdfFile)) unlinkSync(pdfFile);
      return `PDF not rebuilt (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
    }
  }
  if (existsSync(pdfFile)) unlinkSync(pdfFile);
  return "PDF not rebuilt (no Chrome)";
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--incomplete") {
    const file = path.join(argv[1] ?? "", "parity-report.md");
    if (!existsSync(file)) return 1;
    console.log(incompleteModuleKeys(readFileSync(file, "utf8")).join(" "));
    return 0;
  }
  const [dir, redoneFile] = argv;
  const mdFile = path.join(dir ?? "", "parity-report.md");
  if (!dir || !redoneFile || !existsSync(mdFile) || !existsSync(redoneFile)) {
    console.error("Usage: node src/merge-report.ts <run-dir> <redone.md> | --incomplete <run-dir>");
    return 1;
  }
  const merged = mergeReports(readFileSync(mdFile, "utf8"), readFileSync(redoneFile, "utf8"));
  writeFileSync(mdFile, merged.markdown);
  const pdfNote = await rerender(dir, merged.markdown);
  console.error(
    `Merged ${merged.replaced.length} redone module(s)${merged.replaced.length ? `: ${merged.replaced.join(", ")}` : ""}` +
      `${merged.stillFailed.length ? `; still incomplete: ${merged.stillFailed.join(", ")}` : ""}; HTML and summary.json rebuilt; ${pdfNote}.`,
  );
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exit(await main(process.argv.slice(2)));
