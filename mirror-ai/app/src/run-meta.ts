/**
 * Writes run.json next to a parity report: which app and market, which code
 * (branch and commits on both platforms), which scope, and where the report
 * will live in superapp-workspace — so the Jira ticket can link to it before
 * the publish step has pushed it.
 *
 *   node src/run-meta.ts --out-dir <dir> --android <repo> --ios <repo> [--scope project|modules --modules 'A B']
 *
 * Environment: MIRROR_AI_MARKET, MIRROR_AI_APP_ID (overrides the id derived
 * from the market), MIRROR_AI_BRANCH, MIRROR_AI_REPORTS_WEB (repo web URL),
 * MIRROR_AI_SCOPE_FILE, WORKSPACE_ROOT (its last segment is the Ark session).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RunMeta } from "./dashboard.ts";

export const REPORTS_WEB_DEFAULT = "https://bitbucket.org/paytmteam/superapp-workspace";

/** `superapp-caribbean` → `caribbean`; other markets are already folder-friendly. */
export function appIdForMarket(market: string): string {
  return market
    .trim()
    .toLowerCase()
    .replace(/^superapp-/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

export function reportsBranch(appId: string): string {
  return `${appId}/reports`;
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 15_000 });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

/**
 * The branch the audit read. Ark checks out a per-session branch (`s-…`), so
 * prefer MIRROR_AI_BRANCH, then a remote branch pointing at HEAD, then HEAD.
 */
export function auditedBranch(root: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const session = (name: string) => /^s-[a-z0-9]{10}-/.test(name);
  // Several remote branches can sit on the same commit (Sprint-21 and Sprint-22
  // right after a cut), so first ask which branch this checkout came from: the
  // local branch it was cloned on, or the reflog's move onto the session branch.
  const local = git(root, ["branch", "--points-at", "HEAD", "--format=%(refname:short)"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !session(line) && !line.startsWith("("));
  if (local.length === 1) return local[0];
  const moved = git(root, ["reflog", "--format=%gs", "-n", "50"])
    .split("\n")
    .map((line) => /^checkout: moving from (\S+) to (\S+)$/.exec(line.trim()))
    .find((match) => match && session(match[2]) && !session(match[1]) && !/^[0-9a-f]{7,40}$/.test(match[1]));
  if (moved) return moved[1];
  const remote = git(root, ["branch", "-r", "--points-at", "HEAD"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.includes("->"))
    .map((line) => line.replace(/^origin\//, ""))
    .filter((line) => !/^s-[a-z0-9]{10}-/.test(line))[0];
  if (remote) return remote;
  const head = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return head === "HEAD" ? "" : head;
}

export function readScope(file: string): { scope: RunMeta["scope"]; modules: string[] } {
  const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (!text || /^(project|all|whole|whole-project|full-project)$/i.test(text)) return { scope: "project", modules: [] };
  if (/^(common|all-common)$/i.test(text)) return { scope: "project", modules: ["common"] };
  return { scope: "modules", modules: text.split(/[\s,]+/).filter(Boolean) };
}

export function runFolderName(date: Date, meta: Pick<RunMeta, "scope" | "modules">, session: string): string {
  const stamp = date.toISOString().slice(0, 16).replace("T", "_").replace(":", "");
  const scope = meta.scope === "project" ? "project" : (meta.modules ?? []).join("-").toLowerCase().replace(/[^a-z0-9-]+/g, "_").slice(0, 60) || "modules";
  return [stamp, scope, session].filter(Boolean).join("_");
}

export interface RunJson extends RunMeta {
  folder: string;
  branchRef: string;
  /** The HTML report: what dashboards, the PR and the Jira ticket link to. */
  reportUrl: string;
  reportMdUrl: string;
}

export function buildRunMeta(input: {
  androidPath: string;
  iosPath: string;
  scopeFile: string;
  /** The selection the audit actually ran; wins over the scope file. */
  scope?: { scope: RunMeta["scope"]; modules: string[] };
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): RunJson {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const market = env.MIRROR_AI_MARKET?.trim() || "unknown";
  const app = env.MIRROR_AI_APP_ID?.trim() || appIdForMarket(market);
  const { scope, modules } = input.scope ?? readScope(input.scopeFile);
  const session = env.WORKSPACE_ROOT ? path.basename(env.WORKSPACE_ROOT) : "";
  const folder = runFolderName(now, { scope, modules }, /^s-[a-z0-9]+$/.test(session) ? session : "");
  const branchRef = reportsBranch(app);
  const web = (env.MIRROR_AI_REPORTS_WEB?.trim() || REPORTS_WEB_DEFAULT).replace(/\/+$/, "");
  return {
    app,
    market,
    date: now.toISOString(),
    scope,
    modules,
    branch: auditedBranch(input.androidPath, env.MIRROR_AI_ANDROID_BRANCH || env.MIRROR_AI_BRANCH),
    android: { branch: auditedBranch(input.androidPath, env.MIRROR_AI_ANDROID_BRANCH || env.MIRROR_AI_BRANCH), commit: git(input.androidPath, ["rev-parse", "HEAD"]) },
    ios: { branch: auditedBranch(input.iosPath, env.MIRROR_AI_IOS_BRANCH || env.MIRROR_AI_BRANCH), commit: git(input.iosPath, ["rev-parse", "HEAD"]) },
    ...(session ? { sessionId: session } : {}),
    folder,
    branchRef,
    // Bitbucket picks the branch with ?at=, which copes with the slash in `<app>/reports`.
    reportUrl: `${web}/src/main/reports/${app}/${folder}/parity-report.html?at=${encodeURIComponent(branchRef)}`,
    reportMdUrl: `${web}/src/main/reports/${app}/${folder}/parity-report.md?at=${encodeURIComponent(branchRef)}`,
  };
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function main(argv: string[]): number {
  const outDir = flag(argv, "--out-dir");
  const android = flag(argv, "--android");
  const ios = flag(argv, "--ios");
  if (!outDir || !android || !ios) {
    console.error("Usage: node src/run-meta.ts --out-dir <dir> --android <repo> --ios <repo> [--scope project|modules --modules 'A B']");
    return 1;
  }
  const meta = buildRunMeta({
    androidPath: android,
    iosPath: ios,
    scopeFile: process.env.MIRROR_AI_SCOPE_FILE || path.join(outDir, "audit-scope.txt"),
    scope: flag(argv, "--scope")
      ? { scope: flag(argv, "--scope") === "modules" ? "modules" : "project", modules: (flag(argv, "--modules") ?? "").split(/[\s,]+/).filter(Boolean) }
      : undefined,
  });
  writeFileSync(path.join(outDir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`);
  console.error(`run.json: ${meta.app} · ${meta.scope}${meta.modules?.length ? ` (${meta.modules.join(", ")})` : ""} · ${meta.branch || "branch unknown"} · ${meta.reportUrl}`);
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exit(main(process.argv.slice(2)));
