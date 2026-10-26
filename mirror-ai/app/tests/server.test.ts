import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Stands in for the Messages API so the audit runs without a network call. */
async function startFakeClaude(reply: string) {
  const requests: any[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse(reply));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function sse(text: string): string {
  const message = {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  };
  const events = [
    { type: "message_start", message },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

test("the page lists enum modules in three groups and compares the ticked ones", async () => {
  const claude = await startFakeClaude("### 1. Executive Summary\n\nNo mismatches in the stub.");
  const cliLog = path.join(root, "tests/.claude-args.log");
  const saved = {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_API_KEY,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN,
    runner: process.env.MIRROR_AI_RUNNER,
    cliLog: process.env.MIRROR_AI_CLI_LOG,
    binPath: process.env.PATH,
    cursorAgent: process.env.CURSOR_AGENT,
    cursorConversation: process.env.CURSOR_CONVERSATION_ID,
  };
  delete process.env.CURSOR_AGENT;
  delete process.env.CURSOR_CONVERSATION_ID;
  process.env.ANTHROPIC_BASE_URL = claude.url;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.MIRROR_AI_CLI_LOG = cliLog;
  process.env.PATH = `${path.join(root, "tests/bin")}${path.delimiter}${saved.binPath ?? ""}`;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  // Each audit saves a report. They go to a folder of their own, never the
  // real "generated reports", which holds audits that cost real minutes.
  const reports = mkdtempSync(path.join(tmpdir(), "mirror-ai-reports-"));
  const realReports = path.join(root, "generated reports");
  const realBefore = listing(realReports);
  const savedReportsDir = process.env.MIRROR_AI_REPORTS_DIR;
  process.env.MIRROR_AI_REPORTS_DIR = reports;
  const server = await startServer(0);
  try {
    const page = await fetch(server.url);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Android repository/);
    assert.match(html, /iOS repository/);
    assert.match(html, /Android branch/);
    assert.match(html, /iOS branch/);
    assert.match(html, /List modules/);
    assert.match(html, /Common modules/);
    assert.match(html, /Android only/);
    assert.match(html, /iOS only/);
    assert.match(html, /Find differences/);
    assert.match(html, /Download PDF/);
    // Everything below the two repositories is the module list and nothing else.
    assert.doesNotMatch(html, /Use sample fixtures/);
    assert.doesNotMatch(html, /Name specific modules/);
    assert.match(html, /Scope by module enum/);
    assert.match(html, /whole codebase/);
    assert.doesNotMatch(html, /Access token/);
    assert.doesNotMatch(html, /Git username/);

    const listed = await post(server.url, "/api/modules", { fixtures: true });
    assert.equal(typeof listed.sessionId, "string");
    assert.equal(listed.androidSource.enumName, "StoreModuleType");
    assert.equal(listed.iosSource.enumName, "StoreDestination");
    assert.deepEqual(ids(listed.common), ["AISLE", "CATALOG", "FEED", "SHOP"]);
    assert.deepEqual(ids(listed.androidOnly), ["CHECKOUT"]);
    assert.deepEqual(ids(listed.iosOnly), ["SHELF"]);
    assert.equal(listed.common[1].android.caseName, "CATALOG");
    assert.equal(listed.common[1].ios.file, "App/Router/StoreDestination.swift");

    // Default runner: the Claude Code CLI, which signs in the way the user
    // already does and reads both repositories itself.
    process.env.MIRROR_AI_RUNNER = "cli";
    const viaCli = await post(server.url, "/api/differences", {
      sessionId: listed.sessionId,
      modules: ["catalog"],
    });
    assert.match(viaCli.markdown, /# Business logic audit — Catalog/);
    assert.match(viaCli.markdown, /Stub audit of the Catalog module/);
    assert.equal(viaCli.modules[0].cached, false);
    assert.equal(claude.requests.length, 0, "the CLI runner must not call the API");

    const args: string[] = JSON.parse(readFileSync(cliLog, "utf8"));
    assert.equal(args[0], "-p");
    assert.match(args[1], /Audit this module: \*\*Catalog\*\*/);
    assert.match(args[1], /StoreModuleType\.CATALOG/);
    assert.match(args[1], /StoreDestination\.CATALOG/);
    assert.match(args[1], /Heuristic leads/);
    assert.equal(valueAfter(args, "--model"), "opus");
    assert.equal(valueAfter(args, "--effort"), "high");
    assert.equal(valueAfter(args, "--output-format"), "json");
    assert.equal(valueAfter(args, "--permission-mode"), "dontAsk");
    assert.equal(valueAfter(args, "--add-dir"), path.join(root, "fixtures/ios-app"));
    // Analysis only: no shell, no writes.
    assert.ok(args.includes("--restricted"));
    assert.equal(valueAfter(args, "--allowedTools"), "Read");
    assert.equal(valueAfter(args, "--disallowedTools"), "Write");
    assert.match(valueAfter(args, "--append-system-prompt"), /Android vs iOS — Business Logic & Behavioral Audit/);

    // Fallback runner: bundle the source and call the API directly.
    process.env.MIRROR_AI_RUNNER = "api";
    const catalog = await post(server.url, "/api/differences", {
      sessionId: listed.sessionId,
      modules: ["catalog"],
    });
    assert.match(catalog.markdown, /# Business logic audit — Catalog/);
    assert.match(catalog.markdown, /### 1\. Executive Summary/);

    // One request per section — the business logic and each skill — each
    // carrying the spec as a cached system prompt and the module's real source
    // on both sides as the evidence.
    const sections = 1 + readdirSync(path.join(root, "prompts/skills")).filter((file) => file.endsWith(".md")).length;
    assert.equal(claude.requests.length, sections);
    const sent = claude.requests[0];
    assert.equal(sent.model, "claude-opus-5");
    assert.deepEqual(sent.thinking, { type: "adaptive" });
    assert.equal(sent.output_config.effort, "high");
    assert.match(sent.system[0].text, /Android vs iOS — Business Logic & Behavioral Audit/);
    assert.match(sent.system[0].text, /Final Report Structure/);
    assert.deepEqual(sent.system[0].cache_control, { type: "ephemeral" });
    const evidence = sent.messages[0].content;
    assert.match(evidence, /# Feature to audit: Catalog/);
    assert.match(evidence, /StoreModuleType\.CATALOG/);
    assert.match(evidence, /StoreDestination\.CATALOG/);
    assert.match(evidence, /sort = "popularity"/);
    assert.match(evidence, /"relevance"/);
    assert.match(evidence, /# Heuristic leads/);

    // The same request again is served from the saved report, not re-audited.
    const replayed = await post(server.url, "/api/differences", {
      sessionId: listed.sessionId,
      modules: ["catalog"],
    });
    assert.match(replayed.markdown, /# Business logic audit — Catalog/);
    assert.equal(replayed.modules[0].cached, true);
    assert.ok(replayed.modules[0].at, "a replay says when it was saved");
    assert.equal(claude.requests.length, sections, "a replay must not call the API again");

    // refresh: true ignores what was saved.
    const forced = await post(server.url, "/api/differences", {
      sessionId: listed.sessionId,
      modules: ["catalog"],
      refresh: true,
    });
    assert.equal(forced.modules[0].cached, false);
    assert.equal(claude.requests.length, sections * 2, "refresh runs the audit again");

    // The page's path: start every section in the background, then poll.
    const started = await post(server.url, "/api/audits", {
      sessionId: listed.sessionId,
      modules: ["catalog"],
    });
    assert.equal(typeof started.id, "string");
    assert.deepEqual(
      started.modules[0].passes.map((pass: { id: string }) => pass.id),
      ["logic", "ui-skill", "api-skill"],
      "business logic first, then the skills in section order",
    );
    let polled = started;
    for (let tries = 0; !polled.done && tries < 100; tries++) {
      await new Promise((done) => setTimeout(done, 20));
      polled = await get(server.url, "/api/audits", { jobId: started.id });
    }
    assert.equal(polled.done, true);
    for (const pass of polled.modules[0].passes) {
      assert.equal(pass.state, "done");
      assert.equal(pass.cached, true, "saved sections are served without a run");
      assert.match(pass.markdown, /### 1\. Executive Summary/);
    }
    assert.equal(polled.reference, "");
    assert.equal(claude.requests.length, sections * 2, "a polled replay must not call the API again");
    const lost = await get(server.url, "/api/audits", { jobId: "nope" });
    assert.match(lost.error, /no longer running/);
    const noneTicked = await post(server.url, "/api/audits", { sessionId: listed.sessionId, modules: [] });
    assert.match(noneTicked.error, /Select at least one module/);

    const repoSession = await post(server.url, "/api/modules", { fixtures: true, mode: "repository" });
    assert.equal(repoSession.mode, "repository");
    assert.equal(typeof repoSession.sessionId, "string");
    process.env.MIRROR_AI_RUNNER = "cli";
    const repoAudit = await post(server.url, "/api/audits", {
      sessionId: repoSession.sessionId,
      mode: "repository",
    });
    assert.equal(typeof repoAudit.id, "string");
    assert.equal(repoAudit.modules.length, 1);
    assert.match(repoAudit.modules[0].heading, /full repository comparison/i);
    let repoPolled = repoAudit;
    for (let tries = 0; !repoPolled.done && tries < 100; tries++) {
      await new Promise((done) => setTimeout(done, 20));
      repoPolled = await get(server.url, "/api/audits", { jobId: repoAudit.id });
    }
    assert.equal(repoPolled.done, true);
    const repoArgs: string[] = JSON.parse(readFileSync(cliLog, "utf8"));
    assert.match(repoArgs[1], /both entire applications/i);
    assert.match(repoArgs[1], /Heuristic leads/);

    const nothingTicked = await post(server.url, "/api/differences", {
      sessionId: listed.sessionId,
      modules: [],
    });
    assert.match(nothingTicked.error, /Select at least one module/);

    // Citation previews read the checkout the report cites.
    const preview = await get(server.url, "/api/source", {
      sessionId: listed.sessionId,
      side: "android",
      file: "app/.../catalog/CatalogApi.kt",
      start: "8",
      end: "10",
    });
    assert.equal(preview.file, "app/src/main/java/com/example/store/catalog/CatalogApi.kt");
    assert.equal(preview.focusStart, 8);
    assert.match(preview.html, /class="shiki/);
    assert.match(preview.html, /class="line cited"/);

    // The resolver only walks files inside the checkout, so a path pointing at
    // the other one is refused and no source comes back.
    const outsideRepo = await get(server.url, "/api/source", {
      sessionId: listed.sessionId,
      side: "android",
      file: "../ios-app/App/Router/AppRouter.swift",
      start: "1",
    });
    assert.match(outsideRepo.error, /No single file in this checkout matches/);
    assert.equal(outsideRepo.html, undefined);

    // An absolute iOS path, as a run working from the Android checkout writes it.
    const absolute = await get(server.url, "/api/source", {
      sessionId: listed.sessionId,
      side: "ios",
      file: `${root}/fixtures/ios-app/App/Features/Browse/CatalogClient.swift`,
      start: "3",
    });
    assert.equal(absolute.file, "App/Features/Browse/CatalogClient.swift");
    assert.match(absolute.html, /class="shiki/);

    const unknownFile = await get(server.url, "/api/source", {
      sessionId: listed.sessionId,
      side: "ios",
      file: "Nope.swift",
      start: "1",
    });
    assert.match(unknownFile.error, /No single file in this checkout matches/);

    const noSession = await post(server.url, "/api/differences", { modules: ["catalog"] });
    assert.match(noSession.error, /List the modules before finding differences/);

    const badBranch = await post(server.url, "/api/modules", {
      androidUrl: "http://127.0.0.1:9/missing.git",
      iosUrl: "http://127.0.0.1:9/also-missing.git",
      androidBranch: "not a branch",
      iosBranch: "main",
    });
    assert.match(badBranch.error, /Android branch:/);
    assert.equal(badBranch.common, undefined);

    const hiddenToken = await post(server.url, "/api/modules", {
      androidUrl: "http://127.0.0.1:9/missing.git",
      iosUrl: "http://127.0.0.1:9/also-missing.git",
      gitUsername: "paytm",
      gitToken: "super-secret-token",
    });
    assert.match(hiddenToken.error, /Android:/);
    assert.equal(JSON.stringify(hiddenToken).includes("super-secret-token"), false);

    const missing = await post(server.url, "/api/modules", {
      androidUrl: "http://127.0.0.1:9/missing.git",
      iosUrl: "http://127.0.0.1:9/also-missing.git",
    });
    assert.match(missing.error, /Android:/);
    assert.equal(missing.common, undefined);
    assert.deepEqual(listing(realReports), realBefore, "the real reports folder must be left alone");
  } finally {
    await server.close();
    await claude.close();
    restore("ANTHROPIC_BASE_URL", saved.baseUrl);
    restore("ANTHROPIC_API_KEY", saved.apiKey);
    restore("ANTHROPIC_AUTH_TOKEN", saved.authToken);
    rmSync(reports, { recursive: true, force: true });
    restore("MIRROR_AI_REPORTS_DIR", savedReportsDir);
    restore("MIRROR_AI_RUNNER", saved.runner);
    restore("MIRROR_AI_CLI_LOG", saved.cliLog);
    restore("PATH", saved.binPath);
    restore("CURSOR_AGENT", saved.cursorAgent);
    restore("CURSOR_CONVERSATION_ID", saved.cursorConversation);
  }
});

function listing(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function get(base: string, pathname: string, query: Record<string, string>): Promise<any> {
  const url = new URL(pathname, base);
  url.search = new URLSearchParams(query).toString();
  return await (await fetch(url)).json();
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.ok(index >= 0, `missing ${flag}`);
  return args[index + 1];
}

function ids(rows: { id: string }[]): string[] {
  return rows.map((row) => row.id);
}

async function post(base: string, pathname: string, body: unknown): Promise<any> {
  const response = await fetch(new URL(pathname, base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await response.json();
}
