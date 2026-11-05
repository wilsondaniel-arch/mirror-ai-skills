import { spawnSync } from "node:child_process";
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
  /** The project's folder under "generated reports/", when the report belongs to one. */
  project?: string;
}

/** A name that can only ever address a file this module wrote. */
export const EXPORT_NAME = /^[a-z0-9-]+--[0-9a-f]{10}\.(html|pdf)$/;

/** A project folder name this module produced; never a path. */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,120}$/;

export function exportsDir(projectRoot: string, project?: string): string {
  if (project && PROJECT_NAME.test(project)) return path.join(reportsDir(projectRoot), project);
  return path.join(reportsDir(projectRoot), "exports");
}

/**
 * The folder a pair of checkouts' reports go in: each repository's name from
 * its git remote (or its directory when it has none), Android first, so every
 * report for the same two apps lands together, e.g.
 * `lla-superapp-android__lla-superapp-ios`.
 */
export function projectFolderName(androidPath: string, iosPath: string): string {
  return `${repoName(androidPath)}__${repoName(iosPath)}`.slice(0, 120);
}

function repoName(root: string): string {
  const remote = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 10_000 });
  const url = remote.status === 0 ? remote.stdout.trim() : "";
  const fromRemote = url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? "";
  return slug(fromRemote || path.basename(path.resolve(root))).replace(/-{2,}/g, "-");
}

/**
 * Saves the finished report as a self-contained HTML file and a PDF printed
 * from it. The name carries a hash of the document, so showing the same report
 * again reuses its files instead of piling up copies.
 */
export async function exportReport(
  projectRoot: string,
  reportHtml: string,
  title: string,
  project?: string,
  markdown?: string,
): Promise<ReportExport> {
  const css = readFileSync(path.join(projectRoot, "public/app.css"), "utf8");
  const documentHtml = reportDocument(reportHtml, title, css);
  const hash = createHash("sha256").update(documentHtml).digest("hex").slice(0, 10);
  const name = `${slug(title)}--${hash}`;
  const folder = project && PROJECT_NAME.test(project) ? project : undefined;
  const dir = exportsDir(projectRoot, folder);
  mkdirSync(dir, { recursive: true });
  const html = path.join(dir, `${name}.html`);
  const pdf = path.join(dir, `${name}.pdf`);
  if (markdown !== undefined && !existsSync(path.join(dir, `${name}.md`))) writeFileSync(path.join(dir, `${name}.md`), markdown);
  const reused = existsSync(html) && existsSync(pdf);
  if (!existsSync(html)) writeFileSync(html, documentHtml);
  if (existsSync(pdf)) return { name, html, pdf, reused, project: folder };
  const chrome = findChrome();
  if (!chrome) return { name, html, pdf: null, pdfError: "Chrome is not installed on this machine.", reused: false, project: folder };
  try {
    writeFileSync(pdf, await renderReportPdf(chrome, documentHtml));
    return { name, html, pdf, reused: false, project: folder };
  } catch (error) {
    return {
      name,
      html,
      pdf: null,
      pdfError: error instanceof Error ? error.message : "The PDF could not be printed.",
      reused: false,
      project: folder,
    };
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
