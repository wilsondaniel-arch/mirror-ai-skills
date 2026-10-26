import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findChrome, renderReportPdf, reportDocument } from "../src/pdf.ts";
import { startServer } from "../src/server.ts";

const chrome = findChrome();

test("the print document carries its own stylesheet and runs no script", () => {
  const html = reportDocument("<h1>Audit</h1>", "Audit <Shop>", "#report { color: red; } </style><script>");
  assert.match(html, /<style>\n#report \{ color: red; \} <\\\/style><script>\n<\/style>/);
  assert.doesNotMatch(html, /<base |<link /);
  assert.match(html, /Content-Security-Policy" content="script-src 'none'"/);
  assert.match(html, /<title>Audit &lt;Shop&gt;<\/title>/);
  assert.match(html, /<article id="report"><h1>Audit<\/h1><\/article>/);
});

test("the pdf route refuses an empty report and points at print when Chrome is missing", async () => {
  const prior = process.env.MIRROR_AI_CHROME;
  process.env.MIRROR_AI_CHROME = "/nonexistent/chrome";
  const server = await startServer(0);
  try {
    const post = (body: unknown) =>
      fetch(new URL("api/pdf", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const empty = await post({ html: "  " });
    assert.equal(empty.status, 400);
    const missing = await post({ html: "<h1>Audit</h1>" });
    assert.equal(missing.status, 501);
    assert.equal((await missing.json()).fallback, "print");
  } finally {
    await server.close();
    restore("MIRROR_AI_CHROME", prior);
  }
});

test("a finished report is saved once as HTML and PDF, and served back", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-ai-exports-"));
  const prior = { reports: process.env.MIRROR_AI_REPORTS_DIR, chrome: process.env.MIRROR_AI_CHROME };
  process.env.MIRROR_AI_REPORTS_DIR = dir;
  if (!chrome) process.env.MIRROR_AI_CHROME = "/nonexistent/chrome";
  const server = await startServer(0);
  try {
    const exportOnce = async () =>
      (await fetch(new URL("api/exports", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: "<h1>Audit</h1><p>Body text.</p>", title: "Business logic audit — Shop" }),
      })).json();
    const first = await exportOnce();
    assert.match(first.name, /^business-logic-audit-shop--[0-9a-f]{10}$/);
    assert.equal(path.dirname(first.html), path.join(dir, "exports"));
    assert.match(readFileSync(first.html, "utf8"), /<p>Body text\.<\/p>/);
    const page = await fetch(new URL(first.htmlUrl.slice(1), server.url));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<p>Body text\.<\/p>/);
    if (chrome) {
      assert.ok(existsSync(first.pdf));
      const pdf = Buffer.from(await (await fetch(new URL(first.pdfUrl.slice(1), server.url))).arrayBuffer());
      assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
      const again = await exportOnce();
      assert.equal(again.name, first.name);
      assert.equal(again.reused, true);
    } else {
      assert.equal(first.pdf, null);
      assert.match(first.pdfError, /Chrome/);
    }
    // Only names this module writes can be fetched.
    assert.equal((await fetch(new URL("exports/..%2Fsecret.html", server.url))).status, 404);
  } finally {
    await server.close();
    restore("MIRROR_AI_REPORTS_DIR", prior.reports);
    restore("MIRROR_AI_CHROME", prior.chrome);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Chrome prints the report as a real PDF", { skip: chrome ? false : "no Chrome on this machine" }, async () => {
  const pdf = await renderReportPdf(chrome, reportDocument("<h1>Audit</h1><p>Body text.</p>", "Audit", ""));
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
