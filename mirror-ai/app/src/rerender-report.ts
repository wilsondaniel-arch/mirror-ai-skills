/**
 * Rebuilds a published run's report after removing a section: the Markdown,
 * the HTML and PDF rendered from it the same way the audit renders them, and
 * summary.json recomputed so scores no longer count what was removed.
 *
 *   node src/rerender-report.ts <run-dir> --drop-hardcoded-copy
 *
 * <run-dir> holds parity-report.md (and the .html it replaces).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { markdownToHtml } from "./markdown-html.ts";
import { findChrome, renderReportPdf, reportDocument } from "./pdf.ts";
import { summarizeReport } from "./report-summary.ts";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Removes every "### Hard-coded copy on buttons and labels" section, up to the next heading or rule. */
export function dropHardcodedCopy(markdown: string): { markdown: string; removed: number } {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let skipping = false;
  let removed = 0;
  for (const line of lines) {
    if (/^###\s+Hard-coded copy on buttons and labels/i.test(line)) {
      skipping = true;
      removed++;
      continue;
    }
    if (skipping && (/^#{1,3}\s/.test(line) || /^---\s*$/.test(line))) skipping = false;
    if (!skipping) out.push(line);
  }
  return { markdown: out.join("\n").replace(/\n{3,}/g, "\n\n"), removed };
}

export async function main(argv: string[]): Promise<number> {
  const dir = argv.find((arg) => !arg.startsWith("--"));
  if (!dir || !existsSync(path.join(dir, "parity-report.md")) || !argv.includes("--drop-hardcoded-copy")) {
    console.error("Usage: node src/rerender-report.ts <run-dir> --drop-hardcoded-copy");
    return 1;
  }
  const mdFile = path.join(dir, "parity-report.md");
  const { markdown, removed } = dropHardcodedCopy(readFileSync(mdFile, "utf8"));
  writeFileSync(mdFile, markdown);
  const htmlFile = path.join(dir, "parity-report.html");
  const oldTitle = existsSync(htmlFile) ? /<title>([^<]*)<\/title>/.exec(readFileSync(htmlFile, "utf8"))?.[1] : undefined;
  const title = oldTitle ?? "Mirror AI parity report";
  const css = readFileSync(path.join(projectRoot, "public/app.css"), "utf8");
  const documentHtml = reportDocument(markdownToHtml(markdown), title, css);
  writeFileSync(htmlFile, documentHtml);
  const chrome = findChrome();
  let pdfNote = "PDF not rebuilt (no Chrome); the old PDF was removed so it cannot disagree with the HTML";
  const pdfFile = path.join(dir, "parity-report.pdf");
  if (chrome) {
    writeFileSync(pdfFile, await renderReportPdf(chrome, documentHtml));
    pdfNote = "PDF rebuilt";
  } else if (existsSync(pdfFile)) {
    (await import("node:fs")).unlinkSync(pdfFile);
  }
  writeFileSync(path.join(dir, "summary.json"), `${JSON.stringify(summarizeReport(markdown), null, 2)}\n`);
  console.error(`Removed ${removed} hard-coded copy section(s); HTML and summary.json rebuilt; ${pdfNote}.`);
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exit(await main(process.argv.slice(2)));
