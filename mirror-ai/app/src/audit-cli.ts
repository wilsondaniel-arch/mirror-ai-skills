import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditModules, estimateBudget, pickRunner } from "./audit.ts";
import { budgetStatus } from "./budget-audit.ts";
import { markdownToHtml } from "./markdown-html.ts";
import { exportReport, projectFolderName } from "./report-export.ts";
import { cloneRepository, validateBranch } from "./clone.ts";
import { buildModuleCatalog, moduleDefs, moduleKey, type ModuleRow } from "./enums.ts";
import { buildModuleLeadsMap } from "./leads-builder.ts";
import { loadProjectEnv } from "./load-env.ts";
import { miscellaneousDef } from "./misc-scope.ts";
import { listSavedReports, reportsDir } from "./report-store.ts";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
loadProjectEnv(projectRoot);

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(usage());
    return argv.length === 0 ? 1 : 0;
  }
  if (argv.includes("--reports")) {
    const saved = listSavedReports(projectRoot);
    if (saved.length === 0) {
      console.log(`No saved reports yet. They are written to "${path.relative(projectRoot, reportsDir(projectRoot)) || "."}/" as you run audits.`);
      return 0;
    }
    console.log(`${saved.length} saved report${saved.length === 1 ? "" : "s"} in "${path.relative(projectRoot, reportsDir(projectRoot)) || "."}/":`);
    for (const report of saved) {
      const when = report.createdAt.slice(0, 16).replace("T", " ");
      const took = `${Math.round(report.durationMs / 1000)}s`;
      console.log(`  ${when}  ${report.label.padEnd(28)} android ${report.android}  ios ${report.ios}  (${took})`);
    }
    return 0;
  }

  const android = flag(argv, "--android");
  const ios = flag(argv, "--ios");
  if (!android || !ios) {
    console.error("Both --android and --ios are required.\n");
    console.error(usage());
    return 1;
  }
  const branch = flag(argv, "--branch") ?? "";
  const checkouts = resolve(
    { url: android, branch: flag(argv, "--android-branch") ?? branch, side: "Android" },
    { url: ios, branch: flag(argv, "--ios-branch") ?? branch, side: "iOS" },
  );
  if ("error" in checkouts) {
    console.error(checkouts.error);
    return 1;
  }

  note("Reading both repositories and finding their module enums…");
  const catalog = buildModuleCatalog(checkouts.androidPath, checkouts.iosPath);
  const rows = [...catalog.common, ...catalog.androidOnly, ...catalog.iosOnly];
  if (rows.length === 0) {
    console.error("No module enum was found in either repository.");
    return 1;
  }
  if (catalog.androidSource) {
    note(`Android: ${catalog.androidSource.enumName} (${catalog.androidSource.file})`);
  }
  if (catalog.iosSource) {
    note(`iOS: ${catalog.iosSource.enumName} (${catalog.iosSource.file})`);
  }

  if (argv.includes("--list") && argv.includes("--json")) {
    // Machine-readable module index (the Ark flow's modules-index.json).
    const side = (row: ModuleRow) => ({ id: row.id, key: row.key, label: row.label, android: row.android?.caseName ?? null, ios: row.ios?.caseName ?? null });
    console.log(
      JSON.stringify(
        {
          android: { path: checkouts.androidPath, enum: catalog.androidSource },
          ios: { path: checkouts.iosPath, enum: catalog.iosSource },
          common: catalog.common.map(side),
          androidOnly: catalog.androidOnly.map(side),
          iosOnly: catalog.iosOnly.map(side),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (argv.includes("--list")) {
    console.log(listing(catalog.common, "Common modules"));
    console.log(listing(catalog.androidOnly, "Android only"));
    console.log(listing(catalog.iosOnly, "iOS only"));
    return 0;
  }

  // --module takes one name or a comma/space separated list, and may repeat.
  const wanted = flags(argv, "--module").flatMap((value) => value.split(/[\s,]+/)).filter(Boolean);
  const whole = argv.includes("--all");
  // A whole-project audit runs every common module, then one Miscellaneous
  // section for everything else: platform-only modules, modules missing from
  // the enum, and code that belongs to no module.
  const selected = whole ? catalog.common : argv.includes("--common") ? catalog.common : pick(rows, wanted);
  if (selected.length === 0) {
    console.error(
      wanted.length > 0
        ? `No module matched ${wanted.join(", ")}. Run with --list to see the names.`
        : "Name a module with --module, or pass --common for every shared module. --list shows the names.",
    );
    return 1;
  }
  const missing = wanted.filter((name) => !selected.some((row) => matches(row, name)));
  for (const name of missing) note(`No module matched "${name}" — skipping it.`);

  const defs = moduleDefs(selected);
  if (whole) {
    const misc = miscellaneousDef(checkouts.androidPath, checkouts.iosPath, defs);
    if (misc) {
      defs.push(misc);
      note(`Miscellaneous: ${misc.files?.android.length ?? 0} Android and ${misc.files?.ios.length ?? 0} iOS file(s) no common module claims.`);
    }
  }
  if (argv.includes("--estimate")) {
    note(`Estimating a budget audit of ${defs.length} module(s); nothing is spent.`);
    const estimate = await estimateBudget({
      androidPath: checkouts.androidPath,
      iosPath: checkouts.iosPath,
      rows: selected,
      defs,
      projectRoot,
      mode: "module",
    });
    console.log(formatEstimate(estimate));
    return 0;
  }
  note(`Auditing ${defs.length} module(s) with the ${pickRunner()} runner: ${defs.map((def) => def.label).join(", ")}`);
  note("A module with no saved report takes a few minutes; saved ones return at once.");
  const started = Date.now();
  const moduleLeads = buildModuleLeadsMap(checkouts.androidPath, checkouts.iosPath, defs);
  const audit = await auditModules({
    androidPath: checkouts.androidPath,
    iosPath: checkouts.iosPath,
    rows: selected,
    defs,
    projectRoot,
    moduleLeads,
    mode: "module",
    refresh: argv.includes("--refresh"),
  });
  const markdown = audit.markdown;
  for (const module of audit.modules) {
    if (module.cached) note(`${module.label}: reused the report saved ${module.at?.slice(0, 16).replace("T", " ")}`);
  }

  const out = flag(argv, "--out");
  if (out) {
    const target = path.resolve(out);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${markdown}\n`);
    note(`Report written to ${target}`);
  } else {
    console.log(markdown);
  }
  // Every report is also kept as Markdown, HTML and PDF in its project's folder.
  const project = projectFolderName(checkouts.androidPath, checkouts.iosPath);
  const scope = whole ? "full-project" : defs.length === 1 ? defs[0].id : `${defs.length}-modules`;
  const title = `mirror-ai-${scope}-${new Date().toISOString().slice(0, 10)}`;
  const saved = await exportReport(projectRoot, markdownToHtml(markdown), title, project, markdown);
  const folder = path.relative(projectRoot, path.dirname(saved.html));
  note(
    `Saved in "${folder}/": ${saved.name}.md, ${saved.name}.html${saved.pdf ? `, ${saved.name}.pdf` : ` (no PDF: ${saved.pdfError ?? "it could not be printed"})`}`,
  );
  note(`Finished in ${Math.round((Date.now() - started) / 1000)}s.`);
  if (pickRunner() === "budget") {
    const spend = budgetStatus(projectRoot);
    note(
      spend.transport === "cli"
        ? `Ran on your Claude subscription via the claude CLI (no dollar bill). API-equivalent usage so far: $${spend.spentUsd.toFixed(2)} (ledger: .cache/budget/ledger.json).`
        : `Budget: $${spend.spentUsd.toFixed(2)} of $${spend.limitUsd.toFixed(2)} spent (ledger: .cache/budget/ledger.json).`,
    );
  }
  return 0;
}

interface Repo {
  url: string;
  branch: string;
  side: string;
}

/** A local directory is used where it stands; anything else is cloned. */
function resolve(
  android: Repo,
  ios: Repo,
): { androidPath: string; iosPath: string } | { error: string } {
  const left = checkout(android);
  if ("error" in left) return left;
  const right = checkout(ios);
  if ("error" in right) return right;
  return { androidPath: left.path, iosPath: right.path };
}

function checkout(repo: Repo): { path: string } | { error: string } {
  const local = path.resolve(repo.url);
  if (statSync(local, { throwIfNoEntry: false })?.isDirectory()) return { path: local };
  const branch = validateBranch(repo.branch);
  if ("error" in branch) return { error: `${repo.side} branch: ${branch.error}` };
  note(`Cloning ${repo.side}${branch.branch ? ` (${branch.branch})` : ""}…`);
  const cloned = cloneRepository(repo.url, projectRoot, branch.branch);
  if ("error" in cloned) return { error: `${repo.side}: ${cloned.error}` };
  return { path: cloned.path };
}

function pick(rows: ModuleRow[], wanted: string[]): ModuleRow[] {
  if (wanted.length === 0) return [];
  return rows.filter((row) => wanted.some((name) => matches(row, name)));
}

function matches(row: ModuleRow, name: string): boolean {
  const key = moduleKey(name);
  return row.key === key || moduleKey(row.id) === key || moduleKey(row.label) === key;
}

function listing(rows: ModuleRow[], title: string): string {
  const lines = [`${title} (${rows.length})`];
  if (rows.length === 0) lines.push("  (none)");
  for (const row of rows) lines.push(`  ${row.id.padEnd(30)} ${row.label}`);
  return lines.join("\n");
}

/** Progress goes to stderr so the report on stdout stays pipeable. */
function note(message: string): void {
  console.error(message);
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function flags(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}

function usage(): string {
  return [
    "Usage: npm run audit -- --android <url|path> --ios <url|path> [options]",
    "",
    "  Compares the same module on both platforms and writes a business logic audit.",
    "  A local directory is read where it stands; a git URL is cloned into .cache/repos/.",
    "",
    "  --android <url|path>    Android repository (required)",
    "  --ios <url|path>        iOS repository (required)",
    "  --branch <name>         Branch to clone for both repositories",
    "  --android-branch <n>    Branch for Android only",
    "  --ios-branch <n>        Branch for iOS only",
    "",
    "  --list                  List every module, grouped, and stop (add --json for JSON)",
    "  --module <id>[,<id>]    Module(s) to audit, by constant or label. Comma-separated or repeated.",
    "                          The report holds only those modules.",
    "  --common                Audit every module both platforms declare",
    "  --all                   Whole project: every common module, then a last Miscellaneous section",
    "                          for platform-only modules, modules missing from the enum and unmapped code",
    "  --estimate              With the budget runner: plan the audit and print its cost; spend nothing",
    "  --out <file>            Write the report to a file instead of stdout",
    "  --refresh               Audit again even if a report was already saved",
    "  --reports               List every saved report and stop",
    "",
    "Every report is saved under \"generated reports/\". A later run of the same",
    "module, on the same commits with the same prompts, replays it instead of",
    "auditing again.",
    "",
    "Environment: MIRROR_AI_RUNNER (budget|cursor|cli|api), MIRROR_AI_EFFORT, MIRROR_AI_CONCURRENCY,",
    "MIRROR_AI_TIMEOUT_MS, MIRROR_AI_CURSOR_MODEL, MIRROR_AI_API_MODEL, MIRROR_AI_CLI_MODEL.",
    "In Cursor, audits use the `agent` CLI + Opus 5.5 after `agent login` (no Anthropic API key).",
    "The audit spec is prompts/business-logic-audit.md.",
    "",
    "MIRROR_AI_RUNNER=budget runs a two-stage batch audit (Haiku 5.5 scan, Sonnet 5.5 verify)",
    "under a hard cap: MIRROR_AI_BUDGET_USD (default 5). Spend is kept in .cache/budget/ledger.json;",
    "delete that file to start a new budget. MIRROR_AI_SCAN_CHUNKS (default 2) sets how much code",
    "per module is read.",
    "",
    "Examples:",
    "  npm run audit -- --android ./repos/android --ios ./repos/ios --list",
    "  npm run audit -- --android ./repos/android --ios ./repos/ios --module BILL_PAYMENT",
    "  npm run audit -- --android <url> --ios <url> --branch main --common --out audit.md",
    "  MIRROR_AI_RUNNER=budget npm run audit -- --android <a> --ios <i> --all --estimate",
    "  MIRROR_AI_RUNNER=budget npm run audit -- --android <a> --ios <i> --all --out project-audit.md",
  ].join("\n");
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  process.exit(await main(process.argv.slice(2)));
}

function formatEstimate(estimate: Awaited<ReturnType<typeof estimateBudget>>): string {
  const usd = (value: number) => `$${value.toFixed(2)}`;
  const cli = estimate.transport === "cli";
  const lines = [
    cli
      ? "Transport: claude CLI on your Claude subscription — no dollar bill; figures below are API-equivalent usage, which counts against your plan's limits."
      : "Transport: Message Batches API with ANTHROPIC_API_KEY — real dollars at half price.",
    `Modules needing work: ${estimate.modules} (already-saved modules are free and excluded)`,
    `Scan requests: ${estimate.scanRequests}, ~${Math.round(estimate.scanInputTokens / 1000)}K input tokens`,
    `Scan   — likely ${usd(estimate.scanLikelyUsd)}, worst case ${usd(estimate.scanWorstUsd)}`,
    `Verify — likely ${usd(estimate.verifyLikelyUsd)}, worst case ${usd(estimate.verifyWorstUsd)} (if every module has candidates)`,
    `Total  — likely ${usd(estimate.scanLikelyUsd + estimate.verifyLikelyUsd)}, worst case ${usd(estimate.scanWorstUsd + estimate.verifyWorstUsd)}`,
    cli
      ? `Usage so far — ${usd(estimate.spentUsd)} API-equivalent.${Number.isFinite(estimate.limitUsd) ? ` Cap: ${usd(estimate.limitUsd)} (MIRROR_AI_CLI_USAGE_CAP_USD).` : " No cap (set MIRROR_AI_CLI_USAGE_CAP_USD to add one)."}`
      : `Budget — ${usd(estimate.spentUsd)} of ${usd(estimate.limitUsd)} spent. The run never exceeds the cap: if the worst case does not fit, it reads less code per module first and skips modules last.`,
    "",
    "Coverage per module (matching source files read, Android | iOS):",
    ...estimate.perModule.map(
      (row) => `  ${row.label.padEnd(30)} ${row.android.padStart(9)} | ${row.ios.padStart(9)}  chunks ${row.chunks}${row.unread ? `  (${row.unread} lower-ranked files unread)` : ""}`,
    ),
  ];
  return lines.join("\n");
}
