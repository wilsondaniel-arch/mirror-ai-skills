import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AuditJobs } from "./audit-jobs.ts";
import { auditModules, type AuditRequest } from "./audit.ts";
import { cloneRepository, validateBranch } from "./clone.ts";
import { parseComparisonMode } from "./comparison-mode.ts";
import { buildModuleCatalog, moduleDefs, type ModuleRow } from "./enums.ts";
import { repositoryModuleDef, type ComparisonMode } from "./types.ts";
import { compareRepos, renderReport } from "./index.ts";
import { RenderQueue, type ModuleJob } from "./render-jobs.ts";
import { androidFrameSources } from "./screenshot-render.ts";
import { iosFrameSources, previewSources } from "./screenshot-render-ios.ts";
import { savedIosPreviews } from "./ios-preview-writer.ts";
import { listScreenshots, readScreenshot, type Platform } from "./screenshots.ts";
import { loadProjectEnv } from "./load-env.ts";
import { findChrome, renderReportPdf, reportDocument } from "./pdf.ts";
import { EXPORT_NAME, exportReport, exportsDir } from "./report-export.ts";
import { readSourceView, withinRoot } from "./source.ts";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
loadProjectEnv(projectRoot);
const publicDir = path.join(projectRoot, "public");
const fixtureAndroid = path.join(projectRoot, "fixtures/android-app");
const fixtureIos = path.join(projectRoot, "fixtures/ios-app");

interface Session {
  androidPath: string;
  iosPath: string;
  rows: ModuleRow[];
  mode: ComparisonMode;
}

const sessions = new Map<string, Session>();
const renders = new RenderQueue();
const audits = new AuditJobs();

export function startServer(port = 4173): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer({ insecureHTTPParser: true }, (req, res) => {
    void handle(req, res);
  });
  // The browser tunnel resets the tab (Chrome -101) if Node destroys an idle
  // forwarded socket, and it drops chunked bodies. Keep the socket open and
  // let Content-Length frame each response.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 3_600_000;
  server.headersTimeout = 3_601_000;
  server.on("connection", (socket) => {
    socket.setNoDelay(true);
  });
  server.removeAllListeners("clientError");
  server.on("clientError", (error, socket) => {
    console.error(`client error: ${error instanceof Error ? error.message : "request rejected"}`);
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const body = "Bad request.";
    socket.end(
      `HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`,
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Cursor's localhost forward dials this machine from outside the loopback.
    // A 127.0.0.1-only bind answers curl here and never reaches the user's browser.
    server.listen({ port, host: "::", ipv6Only: false }, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${bound}/`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return sendFile(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/app.js") {
      return sendFile(res, path.join(publicDir, "app.js"), "text/javascript; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/app.css") {
      return sendFile(res, path.join(publicDir, "app.css"), "text/css; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/drift-canvas.js") {
      return sendFile(res, path.join(publicDir, "drift-canvas.js"), "text/javascript; charset=utf-8");
    }
    if (req.method === "POST" && url.pathname === "/api/pdf") {
      const report = printableReport(await readJson(req, REPORT_LIMIT));
      if ("error" in report) return sendJson(res, 400, { error: report.error });
      const chrome = findChrome();
      // No Chrome here: the page prints through the browser's dialog instead.
      if (!chrome) return sendJson(res, 501, { error: "Chrome is not installed on this machine.", fallback: "print" });
      const css = readFileSync(path.join(publicDir, "app.css"), "utf8");
      const pdf = await renderReportPdf(chrome, reportDocument(report.html, report.title, css));
      return sendBytes(res, 200, pdf, "application/pdf");
    }
    if (req.method === "POST" && url.pathname === "/api/exports") {
      // The page sends each finished report here once, and it is kept as files.
      const report = printableReport(await readJson(req, REPORT_LIMIT));
      if ("error" in report) return sendJson(res, 400, { error: report.error });
      const saved = await exportReport(projectRoot, report.html, report.title);
      return sendJson(res, 200, {
        ...saved,
        htmlUrl: `/exports/${saved.name}.html`,
        pdfUrl: saved.pdf ? `/exports/${saved.name}.pdf` : null,
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/exports/")) {
      const name = decodeURIComponent(url.pathname.slice("/exports/".length));
      if (!EXPORT_NAME.test(name)) return sendJson(res, 404, { error: "Not found." });
      const type = name.endsWith(".pdf") ? "application/pdf" : "text/html; charset=utf-8";
      return sendFile(res, path.join(exportsDir(projectRoot), name), type);
    }
    if (req.method === "GET" && url.pathname === "/api/screenshots") {
      const session = sessions.get(url.searchParams.get("sessionId") ?? "");
      if (!session) return sendJson(res, 400, { error: "That session has expired. List the modules again." });
      const modules = url.searchParams.getAll("module");
      const shots = modules.flatMap((moduleKey) => {
        const sources = frameSources(session, moduleKey);
        return listScreenshots(projectRoot, moduleKey).map((shot) => ({
          ...shot,
          module: moduleKey,
          source: sources[shot.platform].get(shot.file.replace(/\.\w+$/, "")) ?? "",
        }));
      });
      return sendJson(res, 200, { shots });
    }
    if (req.method === "GET" && url.pathname === "/api/screenshot") {
      const session = sessions.get(url.searchParams.get("sessionId") ?? "");
      if (!session) return sendJson(res, 400, { error: "That session has expired." });
      const platform = url.searchParams.get("platform") === "ios" ? "ios" : "android";
      const shot = readScreenshot(
        projectRoot,
        url.searchParams.get("module") ?? "",
        platform as Platform,
        url.searchParams.get("file") ?? "",
      );
      if (!shot) return sendJson(res, 404, { error: "No such frame." });
      return sendBytes(res, 200, shot.body, shot.contentType);
    }
    if (req.method === "POST" && url.pathname === "/api/render") {
      const body = await readJson(req);
      const session = sessions.get(typeof body.sessionId === "string" ? body.sessionId : "");
      if (!session) return sendJson(res, 400, { error: "That session has expired. List the modules again." });
      const selected = new Set(
        Array.isArray(body.modules) ? body.modules.filter((key): key is string => typeof key === "string") : [],
      );
      const defs = moduleDefs(session.rows.filter((row) => selected.has(row.key)));
      if (defs.length === 0) return sendJson(res, 400, { error: "Select at least one module." });
      // Rendering takes minutes, so this only queues it; the page polls below.
      const jobs = defs.map((def) =>
        renders.enqueue(
          {
            projectRoot,
            androidPath: session.androidPath,
            iosPath: session.iosPath,
            moduleKey: def.id,
            keywords: def.keywords,
          },
          body.force === true,
        ),
      );
      return sendJson(res, 200, { jobs });
    }
    if (req.method === "GET" && url.pathname === "/api/render") {
      const session = sessions.get(url.searchParams.get("sessionId") ?? "");
      if (!session) return sendJson(res, 400, { error: "That session has expired." });
      const jobs = url.searchParams
        .getAll("module")
        .map((moduleKey) => renders.status(moduleKey))
        .filter((job): job is ModuleJob => job !== null);
      return sendJson(res, 200, { jobs });
    }
    if (req.method === "GET" && url.pathname === "/api/source") {
      const session = sessions.get(url.searchParams.get("sessionId") ?? "");
      if (!session) return sendJson(res, 400, { error: "That session has expired. List the modules again." });
      const file = url.searchParams.get("file") ?? "";
      if (!file) return sendJson(res, 400, { error: "Name a file to preview." });
      const root = url.searchParams.get("side") === "ios" ? session.iosPath : session.androidPath;
      const view = await readSourceView(
        root,
        file,
        Number(url.searchParams.get("start")) || 1,
        Number(url.searchParams.get("end")) || 0,
      );
      if (!view) return sendJson(res, 404, { error: `No single file in this checkout matches ${file}.` });
      // The resolver only ever returns a file it walked inside the checkout;
      // this proves that rather than trusting it.
      if (!withinRoot(root, view.file)) {
        return sendJson(res, 400, { error: "That is not a file in this checkout." });
      }
      return sendJson(res, 200, view);
    }
    if (req.method === "POST" && url.pathname === "/api/modules") {
      const body = await readJson(req);
      const checkouts = resolveCheckouts(body);
      if ("error" in checkouts) return sendJson(res, 400, { error: checkouts.error });
      const mode = parseComparisonMode(body.mode);
      const catalog = buildModuleCatalog(checkouts.androidPath, checkouts.iosPath);
      const rows = [...catalog.common, ...catalog.androidOnly, ...catalog.iosOnly];
      if (mode === "module" && rows.length === 0) {
        return sendJson(res, 400, {
          error: "No module enum was found in either repository.",
        });
      }
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        androidPath: checkouts.androidPath,
        iosPath: checkouts.iosPath,
        rows,
        mode,
      });
      return sendJson(res, 200, { sessionId, mode, ...catalog });
    }
    if (req.method === "POST" && url.pathname === "/api/audits") {
      const body = await readJson(req);
      const request = auditRequest(body);
      if ("error" in request) return sendJson(res, 400, { error: request.error });
      // Minutes per section, so this only starts the job; the page polls below
      // and shows each section as it finishes.
      const job = audits.start(request);
      return sendJson(res, 200, job);
    }
    if (req.method === "GET" && url.pathname === "/api/audits") {
      const job = audits.status(url.searchParams.get("jobId") ?? "");
      if (!job) return sendJson(res, 404, { error: "That audit is no longer running. Find differences again." });
      return sendJson(res, 200, job);
    }
    if (req.method === "POST" && url.pathname === "/api/differences") {
      const body = await readJson(req);
      const request = auditRequest(body);
      if ("error" in request) return sendJson(res, 400, { error: request.error });
      const audit = await auditModules(request);
      return sendJson(res, 200, { markdown: audit.markdown, modules: audit.modules });
    }
    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    sendJson(res, 400, { error: message });
  }
}

const frameSourceCache = new Map<string, Record<Platform, Map<string, string>>>();

/** Frame name → the source file it was rendered from, per platform; read once per checkout pair. */
function frameSources(session: Session, moduleKey: string): Record<Platform, Map<string, string>> {
  const key = `${session.androidPath}\u0000${session.iosPath}\u0000${moduleKey}`;
  let sources = frameSourceCache.get(key);
  if (!sources) {
    const keywords = moduleDefs(session.rows.filter((row) => row.key === moduleKey))[0]?.keywords ?? [];
    sources = {
      android: androidFrameSources(session.androidPath, keywords),
      ios: iosFrameSources(session.iosPath, keywords),
    };
    frameSourceCache.set(key, sources);
  }
  // Written previews appear after a render, so they are read fresh, not cached.
  const written = savedIosPreviews(projectRoot, moduleKey, session.iosPath);
  if (written.length === 0) return sources;
  return { ...sources, ios: new Map([...sources.ios, ...previewSources(written)]) };
}

/** What both audit endpoints need from a request: the session, the ticked modules and the leads. */
function auditRequest(body: Json): AuditRequest | { error: string } {
  const session = sessions.get(typeof body.sessionId === "string" ? body.sessionId : "");
  if (!session) return { error: "List the modules before finding differences." };
  const mode = parseComparisonMode(body.mode ?? session.mode);
  if (mode === "repository") {
    const def = repositoryModuleDef();
    const leads = renderReport(
      compareRepos({
        androidPath: session.androidPath,
        iosPath: session.iosPath,
        scope: { kind: "full" },
      }),
    );
    return {
      androidPath: session.androidPath,
      iosPath: session.iosPath,
      rows: [],
      defs: [def],
      projectRoot,
      leads,
      mode: "repository",
      refresh: body.refresh === true,
    };
  }
  const selected = Array.isArray(body.modules)
    ? new Set(body.modules.filter((key): key is string => typeof key === "string"))
    : new Set<string>();
  const rows = session.rows.filter((row) => selected.has(row.key));
  const defs = moduleDefs(rows);
  if (defs.length === 0) return { error: "Select at least one module." };
  // The static matcher no longer writes the report; it only hands the audit
  // a list of places worth checking, which the audit confirms or discards.
  const leads = renderReport(
    compareRepos({
      androidPath: session.androidPath,
      iosPath: session.iosPath,
      scope: { kind: "enum-modules", defs },
    }),
  );
  return {
    androidPath: session.androidPath,
    iosPath: session.iosPath,
    rows,
    defs,
    projectRoot,
    leads,
    mode: "module",
    refresh: body.refresh === true,
  };
}

function resolveCheckouts(body: Json): { androidPath: string; iosPath: string } | { error: string } {
  if (body.fixtures === true) {
    return { androidPath: fixtureAndroid, iosPath: fixtureIos };
  }
  const androidUrl = typeof body.androidUrl === "string" ? body.androidUrl : "";
  const iosUrl = typeof body.iosUrl === "string" ? body.iosUrl : "";
  if (!androidUrl.trim() || !iosUrl.trim()) {
    return { error: "Enter both the Android and iOS repository links." };
  }
  const androidBranch = validateBranch(typeof body.androidBranch === "string" ? body.androidBranch : "");
  if ("error" in androidBranch) return { error: `Android branch: ${androidBranch.error}` };
  const iosBranch = validateBranch(typeof body.iosBranch === "string" ? body.iosBranch : "");
  if ("error" in iosBranch) return { error: `iOS branch: ${iosBranch.error}` };
  const android = cloneRepository(androidUrl, projectRoot, androidBranch.branch);
  if ("error" in android) return { error: checkoutError("Android", androidBranch.branch, android.error) };
  const ios = cloneRepository(iosUrl, projectRoot, iosBranch.branch);
  if ("error" in ios) return { error: checkoutError("iOS", iosBranch.branch, ios.error) };
  return { androidPath: android.path, iosPath: ios.path };
}

function checkoutError(side: string, branch: string, error: string): string {
  const label = branch && /branch/i.test(error) ? `${side} branch` : side;
  return `${label}: ${error}`;
}

type Json = Record<string, unknown>;

/** A report with its citations and embedded frames can run to tens of megabytes. */
const REPORT_LIMIT = 60_000_000;

/** What both print routes need from a request: the drawn report and a title. */
function printableReport(body: Json): { html: string; title: string } | { error: string } {
  const html = typeof body.html === "string" ? body.html : "";
  if (!html.trim()) return { error: "There is no report to print yet." };
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Mirror AI report";
  return { html, title };
}

async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
  return parsed as Json;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendBytes(res, status, Buffer.from(JSON.stringify(body)), "application/json; charset=utf-8");
}

function sendFile(res: ServerResponse, file: string, contentType: string): void {
  if (!existsSync(file)) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  sendBytes(res, 200, readFileSync(file), contentType);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  const response = res as ServerResponse & { shouldKeepAlive?: boolean };
  response.shouldKeepAlive = true;
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    Connection: "keep-alive",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  const port = Number(process.env.PORT) || 4173;
  startServer(port).then(({ url }) => {
    console.log(url);
  });
}
