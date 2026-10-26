import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readSources } from "./scan.ts";

/** Named as the user asked for it; the space is deliberate. */
export const REPORTS_DIR = "generated reports";

/**
 * Where saved reports live. `MIRROR_AI_REPORTS_DIR` moves them, which is how the
 * tests keep their stub reports out of the real folder. Read per call, so a test
 * can set it after this module has loaded.
 */
export function reportsDir(projectRoot: string): string {
  const override = process.env.MIRROR_AI_REPORTS_DIR;
  return override ? path.resolve(override) : path.join(projectRoot, REPORTS_DIR);
}

export interface ReportMeta {
  module: string;
  label: string;
  android: string;
  ios: string;
  prompts: string;
  runner: string;
  effort: string;
  model: string;
  createdAt: string;
  durationMs: number;
}

export interface SavedReport {
  markdown: string;
  meta: ReportMeta;
  file: string;
}

export interface ReportIdentity {
  projectRoot: string;
  androidPath: string;
  iosPath: string;
  moduleKey: string;
  label: string;
  prompts: string;
  runner: string;
  effort: string;
  model: string;
}

/**
 * Everything that can change a report is in the key: which module, the state of
 * both checkouts, the prompt text, and how it was run. Edit a prompt or pull a
 * new commit and the next run is a miss, which is the point.
 */
export function reportKey(identity: ReportIdentity): string {
  const parts = [
    identity.moduleKey,
    fingerprint(identity.androidPath),
    fingerprint(identity.iosPath),
    identity.prompts,
    identity.runner,
    identity.effort,
    identity.model,
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

export function readSavedReport(identity: ReportIdentity): SavedReport | null {
  const file = reportPath(identity);
  if (!existsSync(file.markdown) || !existsSync(file.meta)) return null;
  try {
    return {
      markdown: readFileSync(file.markdown, "utf8"),
      meta: JSON.parse(readFileSync(file.meta, "utf8")) as ReportMeta,
      file: file.markdown,
    };
  } catch {
    return null;
  }
}

export function saveReport(identity: ReportIdentity, markdown: string, durationMs: number): string {
  const file = reportPath(identity);
  mkdirSync(path.dirname(file.markdown), { recursive: true });
  const meta: ReportMeta = {
    module: identity.moduleKey,
    label: identity.label,
    android: fingerprint(identity.androidPath),
    ios: fingerprint(identity.iosPath),
    prompts: identity.prompts,
    runner: identity.runner,
    effort: identity.effort,
    model: identity.model,
    createdAt: new Date().toISOString(),
    durationMs,
  };
  writeFileSync(file.markdown, `${markdown}\n`);
  writeFileSync(file.meta, `${JSON.stringify(meta, null, 2)}\n`);
  return file.markdown;
}

export function listSavedReports(projectRoot: string): ReportMeta[] {
  const dir = reportsDir(projectRoot);
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const saved: ReportMeta[] = [];
  for (const entry of entries) {
    try {
      saved.push(JSON.parse(readFileSync(path.join(dir, entry), "utf8")) as ReportMeta);
    } catch {
      // A half-written or hand-edited sidecar is skipped, not fatal.
    }
  }
  return saved.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** A stable hash of the spec and every skill, so editing a prompt invalidates. */
export function promptsFingerprint(spec: string): string {
  return createHash("sha256").update(spec).digest("hex").slice(0, 12);
}

function reportPath(identity: ReportIdentity): { markdown: string; meta: string } {
  const base = path.join(
    reportsDir(identity.projectRoot),
    `${slug(identity.label || identity.moduleKey)}--${reportKey(identity)}`,
  );
  return { markdown: `${base}.md`, meta: `${base}.json` };
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "module"
  );
}

const fingerprints = new Map<string, string>();

/**
 * A commit is the cheap answer; uncommitted edits are folded in so a working
 * checkout cannot serve a report for code it no longer has. A directory that is
 * not a checkout falls back to hashing what was read off disk.
 */
export function fingerprint(root: string): string {
  const resolved = path.resolve(root);
  const cached = fingerprints.get(resolved);
  if (cached) return cached;
  let value = "";
  const head = git(resolved, ["rev-parse", "HEAD"]);
  if (head) {
    const dirty = git(resolved, ["status", "--porcelain", "--untracked-files=no"]);
    value = dirty
      ? `${head.slice(0, 12)}+${createHash("sha256").update(dirty).digest("hex").slice(0, 8)}`
      : head.slice(0, 12);
  } else {
    const hash = createHash("sha256");
    for (const source of readSources(resolved)) {
      hash.update(source.relativePath).update("\u0000").update(String(source.text.length)).update("\u0000");
    }
    value = hash.digest("hex").slice(0, 12);
  }
  fingerprints.set(resolved, value);
  return value;
}

/** The branch and commit a checkout is on, or empty strings outside git. */
export function checkoutInfo(root: string): { branch: string; commit: string } {
  const resolved = path.resolve(root);
  const branch = git(resolved, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { branch: branch === "HEAD" ? "" : branch, commit: git(resolved, ["rev-parse", "HEAD"]) };
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 15_000 });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}
