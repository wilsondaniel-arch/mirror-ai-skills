import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findChrome, renderReportPdf, reportDocument } from "./pdf.ts";
import { reportsDir } from "./report-store.ts";

export interface ReportExport {
  /** The shared file name, without extension; `/exports/<name>.html` serves it. */
  name: string;
  html: string;
  /** Null when no PDF could be printed; `pdfError` says why. */
  pdf: string | null;
  pdfError?: string;
  /** True when this exact report was exported before and its files were reused. */
  reused: boolean;
}

/** A name that can only ever address a file this module wrote. */
export const EXPORT_NAME = /^[a-z0-9-]+--[0-9a-f]{10}\.(html|pdf)$/;

export function exportsDir(projectRoot: string): string {
  return path.join(reportsDir(projectRoot), "exports");
}

/**
 * Saves the finished report as a self-contained HTML file and a PDF printed
 * from it. The name carries a hash of the document, so showing the same report
 * again reuses its files instead of piling up copies.
 */
export async function exportReport(projectRoot: string, reportHtml: string, title: string): Promise<ReportExport> {
  const css = readFileSync(path.join(projectRoot, "public/app.css"), "utf8");
  const documentHtml = reportDocument(reportHtml, title, css);
  const hash = createHash("sha256").update(documentHtml).digest("hex").slice(0, 10);
  const name = `${slug(title)}--${hash}`;
  const dir = exportsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const html = path.join(dir, `${name}.html`);
  const pdf = path.join(dir, `${name}.pdf`);
  const reused = existsSync(html) && existsSync(pdf);
  if (!existsSync(html)) writeFileSync(html, documentHtml);
  if (existsSync(pdf)) return { name, html, pdf, reused };
  const chrome = findChrome();
  if (!chrome) return { name, html, pdf: null, pdfError: "Chrome is not installed on this machine.", reused: false };
  try {
    writeFileSync(pdf, await renderReportPdf(chrome, documentHtml));
    return { name, html, pdf, reused: false };
  } catch (error) {
    return { name, html, pdf: null, pdfError: error instanceof Error ? error.message : "The PDF could not be printed.", reused: false };
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "report"
  );
}
