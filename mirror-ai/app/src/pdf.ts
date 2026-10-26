import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Long reports with screenshots take a while to lay out; past this the print is abandoned. */
const PRINT_TIMEOUT_MS = 120_000;

/**
 * A Chromium-family browser to print with, or "" when none is installed. The
 * page falls back to the browser's own print dialog then, which uses the same
 * print stylesheet. `MIRROR_AI_CHROME` points at one explicitly.
 */
export function findChrome(): string {
  const override = process.env.MIRROR_AI_CHROME;
  if (override) return existsSync(override) ? override : "";
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : process.platform === "win32"
        ? [
            path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
            path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
          ]
        : [];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("which", [name], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return "";
}

/**
 * The report as the page drew it, as one self-contained file: the page's own
 * stylesheet inlined and frames already embedded by the page, so it opens the
 * same anywhere and prints the same as the screen. Scripts are blocked.
 */
export function reportDocument(reportHtml: string, title: string, css: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="script-src 'none'" />
<title>${escapeText(title)}</title>
<style>
${css.replace(/<\/style/gi, "<\\/style")}
</style>
</head>
<body class="pdf-document">
<main><article id="report">${reportHtml}</article></main>
</body>
</html>
`;
}

/**
 * Prints the report with headless Chrome: real text, the print stylesheet's
 * page breaks, and table headers repeated on every page. The document's CSP
 * turns scripts off — the report is already drawn, and nothing in it should
 * run. (`--blink-settings=scriptEnabled=false` would too, but Chrome then
 * writes no PDF at all.)
 */
export async function renderReportPdf(chrome: string, documentHtml: string): Promise<Buffer> {
  const work = mkdtempSync(path.join(tmpdir(), "mirror-ai-pdf-"));
  try {
    const page = path.join(work, "report.html");
    const out = path.join(work, "report.pdf");
    writeFileSync(page, documentHtml);
    await new Promise<void>((resolve, reject) => {
      execFile(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          `--user-data-dir=${path.join(work, "profile")}`,
          "--run-all-compositor-stages-before-draw",
          "--virtual-time-budget=20000",
          "--no-pdf-header-footer",
          "--print-to-pdf-no-header",
          `--print-to-pdf=${out}`,
          pathToFileURL(page).href,
        ],
        { timeout: PRINT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (existsSync(out)) return resolve();
          const detail = error?.killed ? "it ran too long" : firstLine(String(stderr)) || error?.message || "no PDF was written";
          reject(new Error(`Chrome could not print the report: ${detail}.`));
        },
      );
    });
    return readFileSync(out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
