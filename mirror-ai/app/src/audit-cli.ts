import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditModules, pickRunner } from "./audit.ts";
import { cloneRepository, validateBranch } from "./clone.ts";
import { buildModuleCatalog, moduleDefs, moduleKey, type ModuleRow } from "./enums.ts";
import { compareRepos, renderReport } from "./index.ts";
import { loadProjectEnv } from "./load-env.ts";
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

  if (argv.includes("--list")) {
    console.log(listing(catalog.common, "Common modules"));
    console.log(listing(catalog.androidOnly, "Android only"));
    console.log(listing(catalog.iosOnly, "iOS only"));
    return 0;
  }

  const wanted = flags(argv, "--module");
  const selected = argv.includes("--common") ? catalog.common : pick(rows, wanted);
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
  note(`Auditing ${defs.length} module(s) with the ${pickRunner()} runner: ${defs.map((def) => def.label).join(", ")}`);
  note("A module with no saved report takes a few minutes; saved ones return at once.");
  const started = Date.now();
  const leads = renderReport(
    compareRepos({
      androidPath: checkouts.androidPath,
      iosPath: checkouts.iosPath,
      scope: { kind: "enum-modules", defs },
    }),
  );
  const audit = await auditModules({
    androidPath: checkouts.androidPath,
    iosPath: checkouts.iosPath,
    rows: selected,
    defs,
    projectRoot,
    leads,
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
  note(`Finished in ${Math.round((Date.now() - started) / 1000)}s.`);
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
    "  --list                  List every module, grouped, and stop",
    "  --module <id>           Module to audit, by constant or label. Repeat for more.",
    "  --common                Audit every module both platforms declare",
    "  --out <file>            Write the report to a file instead of stdout",
    "  --refresh               Audit again even if a report was already saved",
    "  --reports               List every saved report and stop",
    "",
    "Every report is saved under \"generated reports/\". A later run of the same",
    "module, on the same commits with the same prompts, replays it instead of",
    "auditing again.",
    "",
    "Environment: MIRROR_AI_RUNNER (cursor|cli|api), MIRROR_AI_EFFORT, MIRROR_AI_CONCURRENCY,",
    "MIRROR_AI_TIMEOUT_MS, MIRROR_AI_CURSOR_MODEL, MIRROR_AI_API_MODEL, MIRROR_AI_CLI_MODEL.",
    "In Cursor, audits use the `agent` CLI + Opus 5.5 after `agent login` (no Anthropic API key).",
    "The audit spec is prompts/business-logic-audit.md.",
    "",
    "Examples:",
    "  npm run audit -- --android ./repos/android --ios ./repos/ios --list",
    "  npm run audit -- --android ./repos/android --ios ./repos/ios --module BILL_PAYMENT",
    "  npm run audit -- --android <url> --ios <url> --branch main --common --out audit.md",
  ].join("\n");
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  process.exit(await main(process.argv.slice(2)));
}
