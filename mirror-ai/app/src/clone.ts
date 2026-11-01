import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

export interface GitAuth {
  username: string;
  token: string;
}

export function cloneRepository(
  url: string,
  projectRoot: string,
  branch = "",
  auth: GitAuth = { username: "", token: "" },
): { path: string } | { error: string } {
  const validated = validateGitUrl(url);
  if ("error" in validated) return validated;
  const named = validateBranch(branch);
  if ("error" in named) return named;
  const resolved = auth.token.trim() ? auth : cursorAuth(validated.url);
  const cacheRoot = path.join(projectRoot, ".cache", "repos");
  const cacheKey = named.branch ? `${validated.url}#${named.branch}` : validated.url;
  const dir = path.join(cacheRoot, createHash("sha256").update(cacheKey).digest("hex").slice(0, 16));
  if (existsSync(path.join(dir, ".git"))) return { path: dir };
  mkdirSync(cacheRoot, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  const args = ["clone", "--depth", "1"];
  if (named.branch) args.push("--branch", named.branch);
  args.push(validated.url, dir);
  const result = spawnSync("git", args, {
    encoding: "utf8",
    timeout: 600000,
    env: gitEnv(resolved),
  });
  if (result.status !== 0 || !existsSync(path.join(dir, ".git"))) {
    rmSync(dir, { recursive: true, force: true });
    const detail = gitFailure(result.stderr ?? "", result.stdout ?? "", result.error?.message);
    return { error: scrub(detail || "Could not clone that repository.", resolved.token) };
  }
  return { path: dir };
}

export function validateGitUrl(raw: string): { url: string } | { error: string } {
  const url = raw.trim();
  if (!url) return { error: "Enter a repository link." };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `"${url}" is not a valid repository link.` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { error: "Use an http or https git link." };
  }
  if (!parsed.hostname) return { error: "That link has no host." };
  return { url };
}

export function validateBranch(raw: string): { branch: string } | { error: string } {
  const branch = raw.trim();
  if (!branch) return { branch: "" };
  const result = spawnSync("git", ["check-ref-format", "--branch", branch], { encoding: "utf8" });
  if (result.status !== 0) return { error: `"${branch}" is not a valid branch name.` };
  return { branch: result.stdout.trim() || branch };
}

function gitEnv(auth: GitAuth): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const token = auth.token.trim();
  if (!token) return env;
  const username = auth.username.trim() || "x-token-auth";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "http.extraheader";
  env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
  return env;
}

function gitFailure(stderr: string, stdout: string, fallback?: string): string {
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Cloning into /.test(line) && !/^remote:/.test(line));
  const useful = lines.filter((line) => /fatal:|error:|unable to|could not|authentication|denied|repository|resolve/i.test(line));
  const detail = (useful.length > 0 ? useful : lines).slice(0, 3).join(" ") || fallback || "";
  if (/username|authentication|401|403|terminal prompts disabled|access denied|not permitted/i.test(detail)) {
    return "This repository is private. Cursor's pull-request token is not available in this session, so the clone cannot sign in.";
  }
  return detail;
}

/** Git credentials for a host: env, Cursor tokens, then this Mac’s git credential store. */
export function credentialsForUrl(url: string): GitAuth {
  return cursorAuth(url);
}

function cursorAuth(url: string): GitAuth {
  const fromEnv = authFromEnv(url);
  if (fromEnv.token) return fromEnv;
  return authFromGit(url);
}

function authFromEnv(url: string): GitAuth {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { username: "", token: "" };
  }
  if (host !== "bitbucket.org" && !host.endsWith(".bitbucket.org")) return { username: "", token: "" };
  const fromCursor = cursorPullRequestAuth();
  if (fromCursor.token) return fromCursor;
  const token = (process.env.BITBUCKET_TOKEN || process.env.BITBUCKET_APP_PASSWORD || "").trim();
  const username = (process.env.BITBUCKET_USERNAME || "").trim();
  return { username, token };
}

function cursorPullRequestAuth(): GitAuth {
  const candidates = [
    { username: "x-token-auth", token: process.env.__CURSOR_X_TOKEN_AUTH_TOKEN },
    { username: "pat", token: process.env.__CURSOR_PAT_AUTH_TOKEN },
    { username: "oauth2", token: process.env.__CURSOR_OAUTH2_AUTH_TOKEN },
  ];
  for (const candidate of candidates) {
    const token = candidate.token?.trim() ?? "";
    if (token) return { username: candidate.username, token };
  }
  return { username: "", token: "" };
}

function authFromGit(url: string): GitAuth {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { username: "", token: "" };
  }
  const result = spawnSync("git", ["credential", "fill"], {
    input: `protocol=${parsed.protocol.replace(":", "")}\nhost=${parsed.hostname}\n\n`,
    encoding: "utf8",
    timeout: 3000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (!result.stdout) return { username: "", token: "" };
  const values = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1));
  }
  return { username: values.get("username") ?? "", token: values.get("password") ?? "" };
}

function scrub(detail: string, token: string): string {
  if (!token) return detail;
  return detail.split(token).join("(token)");
}
