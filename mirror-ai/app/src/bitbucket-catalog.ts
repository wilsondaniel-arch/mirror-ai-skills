import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialsForUrl, validateGitUrl } from "./clone.ts";

const API = "https://api.bitbucket.org/2.0";

export interface RepoChoice {
  name: string;
  fullName: string;
  url: string;
}

interface Page {
  values?: unknown[];
  next?: string;
}

/** Repositories the signed-in user can open. API first, then repos this Mac already reaches over git. */
export async function listAccessibleRepos(extraRoots: string[] = []): Promise<RepoChoice[] | { error: string }> {
  const fromApi = await listReposFromApi();
  if (Array.isArray(fromApi) && fromApi.length > 0) return fromApi;
  const local = discoverLocalBitbucketRepos(extraRoots);
  if (local.length > 0) return local;
  return fromApi;
}

/**
 * Branch names on one repository, newest commit first.
 * A shallow tip fetch supplies commit dates; names alone cannot.
 */
export function listRepoBranches(rawUrl: string, cacheRoot = process.cwd()): string[] | { error: string } {
  const validated = validateGitUrl(httpsRepoUrl(rawUrl));
  if ("error" in validated) return validated;
  const dated = branchesByLatestCommit(validated.url, cacheRoot);
  if (Array.isArray(dated) && dated.length > 0) return dated;
  const names = branchNames(validated.url);
  if ("error" in names) return Array.isArray(dated) ? names : dated;
  return names;
}

function branchesByLatestCommit(url: string, cacheRoot: string): string[] | { error: string } {
  const dir = path.join(cacheRoot, ".cache", "branch-tips", createHash("sha256").update(url).digest("hex").slice(0, 16));
  mkdirSync(path.dirname(dir), { recursive: true });
  if (!existsSync(path.join(dir, "HEAD"))) {
    const init = git(["init", "--bare", dir]);
    if (init.status !== 0) return { error: "Could not prepare a branch listing." };
  }
  git(["-C", dir, "remote", "remove", "origin"]);
  const added = git(["-C", dir, "remote", "add", "origin", url]);
  if (added.status !== 0) return { error: "Could not prepare a branch listing." };
  const fetched = git([
    "-C", dir, "fetch", "--depth=1", "--filter=tree:0", "origin", "+refs/heads/*:refs/heads/*",
  ], 180_000);
  if (fetched.status !== 0) {
    const detail = `${fetched.stderr ?? ""}\n${fetched.stdout ?? ""}`;
    if (/authentication|permission denied|could not read from remote/i.test(detail)) {
      return { error: "Git could not sign in to that repository." };
    }
    return { error: "Could not load branches for that repository." };
  }
  const listed = git([
    "-C", dir, "for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads",
  ]);
  const seen = new Set<string>();
  const branches: string[] = [];
  for (const ref of (listed.stdout ?? "").split(/\r?\n/)) {
    if (!ref.startsWith("refs/heads/")) continue;
    const name = ref.slice("refs/heads/".length);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    branches.push(name);
  }
  return branches;
}

function branchNames(url: string): string[] | { error: string } {
  const result = git(["ls-remote", "--heads", url], 120_000);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    if (/authentication|permission denied|could not read from remote/i.test(detail)) {
      return { error: "Git could not sign in to that repository." };
    }
    return { error: "Could not load branches for that repository." };
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => {
      const ref = line.slice(line.indexOf("\t") + 1);
      return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
    })
    .filter(Boolean);
}

function git(args: string[], timeout = 15_000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function listReposFromApi(): Promise<RepoChoice[] | { error: string }> {
  const auth = bitbucketAuth();
  if ("error" in auth) return auth;
  const repos: RepoChoice[] = [];
  let next: string | undefined = `${API}/repositories?role=member&pagelen=100`;
  try {
    for (let page = 0; page < 40 && next; page += 1) {
      const body = await bitbucketGet(next, auth.header, "repositories");
      for (const repo of body.values ?? []) {
        const choice = repoChoice(repo);
        if (choice) repos.push(choice);
      }
      next = typeof body.next === "string" ? body.next : undefined;
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not load repositories." };
  }
  repos.sort((left, right) => left.fullName.localeCompare(right.fullName));
  return repos;
}

function discoverLocalBitbucketRepos(extraRoots: string[]): RepoChoice[] {
  const home = os.homedir();
  const roots = [...new Set([home, ...extraRoots].filter(Boolean))];
  const byName = new Map<string, RepoChoice>();
  const gitDirs: string[] = [];
  for (const root of roots) {
    const found = spawnSync(
      "find",
      [
        root,
        "-path", path.join(home, "Library"), "-prune",
        "-o", "-path", "*/node_modules", "-prune",
        "-o", "-path", "*/.Trash", "-prune",
        "-o", "-type", "d", "-name", ".git", "-print",
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    gitDirs.push(...(found.stdout ?? "").split(/\r?\n/).filter(Boolean));
  }
  for (const gitDir of gitDirs.slice(0, 400)) {
    const checkout = path.dirname(gitDir);
    const remote = spawnSync("git", ["-C", checkout, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const choice = repoFromRemote((remote.stdout ?? "").trim());
    if (choice) byName.set(choice.fullName, choice);
  }
  return [...byName.values()].sort((left, right) => left.fullName.localeCompare(right.fullName));
}

export function repoFromRemote(remote: string): RepoChoice | null {
  const match = remote.match(/bitbucket\.org[:/]([^/\s]+)\/([^/\s]+)/i);
  if (!match) return null;
  const workspace = decodeURIComponent(match[1]);
  const slug = decodeURIComponent(match[2].replace(/\.git$/, "").replace(/\/$/, ""));
  if (!workspace || !slug) return null;
  const fullName = `${workspace}/${slug}`;
  return { name: slug, fullName, url: `https://bitbucket.org/${fullName}` };
}

function httpsRepoUrl(raw: string): string {
  return repoFromRemote(raw)?.url ?? raw.trim();
}

function bitbucketAuth(): { header: string } | { error: string } {
  const auth = credentialsForUrl("https://bitbucket.org/");
  if (!auth.token.trim()) {
    return { error: "No Bitbucket login was found on this Mac. Sign in with git, then reload." };
  }
  const username = auth.username.trim() || "x-token-auth";
  return { header: `Basic ${Buffer.from(`${username}:${auth.token}`).toString("base64")}` };
}

async function bitbucketGet(url: string, header: string, noun: string): Promise<Page> {
  const response = await fetch(url, {
    headers: { Authorization: header, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Bitbucket refused this Mac’s git login.");
  }
  if (!response.ok) {
    throw new Error(`Bitbucket returned ${response.status} while listing ${noun}.`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") throw new Error(`Bitbucket returned an unexpected ${noun} list.`);
  return body as Page;
}

function repoChoice(value: unknown): RepoChoice | null {
  if (!value || typeof value !== "object") return null;
  const repo = value as {
    name?: string;
    full_name?: string;
    links?: { html?: { href?: string } };
  };
  const href = repo.links?.html?.href?.trim().replace(/\/$/, "") ?? "";
  const fullName = repo.full_name?.trim() ?? "";
  if (!href || !fullName) return null;
  return { name: repo.name?.trim() || fullName, fullName, url: href };
}
