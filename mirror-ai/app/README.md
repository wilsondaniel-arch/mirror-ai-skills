# Mirror AI

Mirror AI compares **Android** and **iOS** codebases: it discovers each app’s module enum, lists modules in common and platform-only, and runs AI-assisted audits on the modules you select. A local web UI (`npm run serve`) and a CLI (`npm run audit`) share the same engine.

**Fast path:** [QUICKSTART.md](QUICKSTART.md)  
**Configuration template:** [.env.example](.env.example)

---

## What this project includes

| Path | Purpose |
|------|---------|
| `src/` | HTTP server, audit engine, repo clone, screenshots, static compare |
| `public/` | Web UI (module picker, live audit slots, code previews) |
| `prompts/` | Audit spec (`business-logic-audit.md`) and pluggable skills (`prompts/skills/`) |
| `fixtures/` | Small sample Android/iOS apps for tests and dry runs |
| `repos/` | Optional local checkout paths (your team’s real apps, not shipped) |
| `reference/` | Frozen API contract drift reference for Jamaica market |
| `generated reports/` | Saved audit sections (replayed when inputs match) |
| `.cache/repos/` | Shallow git clones from URLs entered in the UI |

---

## System requirements

| Platform | Web UI & audits | Android screenshots | iOS screenshots |
|----------|-----------------|---------------------|-----------------|
| **macOS** (Apple Silicon or Intel) | Yes | Yes (Android SDK + Gradle) | Yes (Xcode + Simulator) |
| **Linux** | Yes | Possible with `ANDROID_HOME` | No (Xcode is macOS-only) |
| **Windows** | Yes | Possible with `ANDROID_HOME` | No |

**Node.js 22+** is required. The app runs TypeScript via `node --experimental-strip-types` (see `package.json` scripts). Node **20.12+** can load `.env` via `process.loadEnvFile`; Node 22+ is still required for the runtime flags in use.

**Disk:** Cloned repos and Gradle/Xcode build outputs can use several gigabytes under `.cache/` and app build directories.

**Network:** `npm install` hits the npm registry; cloning uses your git host; audits call Anthropic (CLI or API).

---

## Required software

### Node.js and npm

- Install from [https://nodejs.org/](https://nodejs.org/) (LTS 22 or newer), or on macOS: `brew install node`.
- Verify: `node -v` (major ≥ 22), `npm -v`.

### Git

- Required when you pass **HTTPS git URLs** instead of local paths.
- macOS: Xcode Command Line Tools or `brew install git`.
- Windows: [Git for Windows](https://git-scm.com/download/win).

### Audit runner (one of)

1. **Claude Code CLI** (recommended) — install from [Anthropic’s Claude Code docs](https://docs.anthropic.com/en/docs/claude-code). Log in with `claude` so `claude --version` succeeds. No API key needed for audits; the CLI runs read-only (`--restricted`).
2. **Anthropic API** — create an API key at [Anthropic Console](https://console.anthropic.com/). Set `ANTHROPIC_API_KEY` in `.env`. Use a **console API key**, not a Claude Code OAuth token in `ANTHROPIC_AUTH_TOKEN` (that path is throttled for this app).

### Optional — private Bitbucket

For `bitbucket.org` URLs when git has no stored credentials, set in `.env`:

- `BITBUCKET_USERNAME`
- `BITBUCKET_TOKEN` (or `BITBUCKET_APP_PASSWORD`)

Create an **App password** or **Repository access token** under Bitbucket → Personal settings.

### Optional — screenshot rendering

- **Android:** Android SDK, set `ANDROID_HOME`, JDK compatible with the app’s Gradle wrapper.
- **iOS (macOS only):** Xcode, iOS Simulator, scheme/configuration (see `MIRROR_AI_IOS_*` in `.env.example`).

---

## Accounts and credentials (summary)

| Credential | Required when | Where to get it |
|------------|---------------|-----------------|
| Claude Code login | Default audit runner (`cli`) | Install and sign in to Claude Code |
| `ANTHROPIC_API_KEY` | No `claude` CLI, or `MIRROR_AI_RUNNER=api` | [console.anthropic.com](https://console.anthropic.com/) |
| `BITBUCKET_USERNAME` + `BITBUCKET_TOKEN` | Private Bitbucket clone without git credentials | Bitbucket personal settings |
| Git HTTPS credentials | Private non-Bitbucket hosts | Your git credential manager / PAT |

Cursor-specific tokens (`__CURSOR_*_AUTH_TOKEN`) are injected only inside Cursor sessions; do not rely on them in a plain terminal.

**Cursor install (recommended):** install the Mirror AI skill, then run `./setup.sh --yes` (or open via `/mirror-ai` — bootstrap runs it). Audits use the **Cursor `agent` CLI** and **Claude Opus 5.5** after one-time `agent login` — no Anthropic API key in `.env`. Override runners/models with `MIRROR_AI_RUNNER`, `MIRROR_AI_CURSOR_MODEL`, etc.

---

## Configuration

Copy the template and edit locally (never commit `.env`):

```bash
cp .env.example .env
```

Or run the interactive installer (writes `.env` for you):

```bash
chmod +x setup.sh && ./setup.sh          # macOS / Linux
# Windows:  .\setup.ps1
```

### Required variables

| Variable | When required |
|----------|----------------|
| `ANTHROPIC_API_KEY` | API runner only (no working `claude` CLI, or `MIRROR_AI_RUNNER=api`) |

### Common optional variables

| Variable | Default | Effect |
|----------|---------|--------|
| `PORT` | `4173` | Web server port |
| `MIRROR_AI_RUNNER` | auto (`cli` if `claude` exists, else `api`) | Force `cli` or `api` |
| `MIRROR_AI_EFFORT` | `high` | `low` … `max` thinking effort |
| `MIRROR_AI_CONCURRENCY` | `3` | Parallel audit sections |
| `MIRROR_AI_TIMEOUT_MS` | `2700000` | Per-section timeout (ms) |
| `MIRROR_AI_EVIDENCE_BUDGET` | `200000` | API runner source budget (chars/platform) |
| `MIRROR_AI_REPORTS_DIR` | `./generated reports/` | Saved report location |
| `BITBUCKET_USERNAME` / `BITBUCKET_TOKEN` | empty | Bitbucket HTTPS clone auth |
| `ANDROID_HOME` | macOS: `~/Library/Android/sdk` | Android SDK for screenshots |
| `MIRROR_AI_ANDROID_VARIANT` | `JmDevDebug` | Gradle variant for Compose screenshots |
| `MIRROR_AI_IOS_SIMULATOR` | auto | Simulator device name |
| `MIRROR_AI_IOS_SCHEME` / `MIRROR_AI_IOS_CONFIGURATION` | from project | Xcode build settings |

Full list with comments: [.env.example](.env.example).

---

## Get the project

```bash
git clone <repository-url> mirror-ai
cd mirror-ai
```

For a zip export, unpack anywhere; all paths in scripts are relative to the project root.

---

## Installation

### Automated (recommended)

```bash
./setup.sh
```

The script checks Node 22+, optional git/Claude/Xcode/Android notes, creates or updates `.env`, runs `npm install`, and executes `npm test`.

### Manual

```bash
npm install
cp .env.example .env   # edit as needed
npm test
```

---

## Start Mirror AI

```bash
npm run serve
```

The process prints a URL (default **http://127.0.0.1:4173/**). The server binds on all interfaces (`::`) so tools like Cursor port forwarding can reach it; use the printed `127.0.0.1` URL locally.

### Web workflow

1. Enter Android and iOS repository URLs (or use local paths under `fixtures/` or `repos/`) and a branch.
2. **List modules** — enums are detected from Kotlin/Java/Swift sources; repos clone into `.cache/repos/`.
3. Select modules → **Find differences** — audits stream in per section (business logic, then skills).
4. Click code citations for Shiki-highlighted previews from the checkout.

### CLI workflow

```bash
npm run audit -- --android ./fixtures/android-app --ios ./fixtures/ios-app --list
npm run audit -- --android ./repos/android --ios ./repos/ios --module BILL_PAYMENT
npm run audit -- --android <url> --ios <url> --branch main --common --out audit.md
```

Static keyword compare (no model):

```bash
npm run compare -- --help
```

---

## Verify installation

```bash
npm test                    # 89 unit/integration tests
npm run typecheck           # TypeScript
npm run serve               # then open the printed URL; home page should load
```

Fixture audit (needs `claude` or `ANTHROPIC_API_KEY`):

```bash
npm run audit -- --android ./fixtures/android-app --ios ./fixtures/ios-app --module <name> --out /tmp/mirror-test.md
```

---

## Troubleshooting

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| `node: bad option: --experimental-strip-types` | Node &lt; 22 | Upgrade Node.js |
| `The claude CLI could not be started` | Claude Code not installed | Install Claude Code or set `ANTHROPIC_API_KEY` and `MIRROR_AI_RUNNER=api` |
| `Claude API rejected the credentials` | Missing/invalid API key | Set `ANTHROPIC_API_KEY`; avoid OAuth tokens in `ANTHROPIC_AUTH_TOKEN` |
| Private clone / authentication errors | No git or Bitbucket creds | Configure git credentials or `BITBUCKET_*` in `.env` |
| `That session has expired` | Server restarted | List modules again in the UI |
| Screenshot step fails | Missing SDK/Xcode | Set `ANDROID_HOME` or use macOS + Xcode; screenshots are optional for audits |
| Port in use | Another process on `PORT` | Change `PORT` in `.env` |
| Tests fail after upgrade | Dependency drift | `rm -rf node_modules && npm install` |

Logs: server errors go to the terminal running `npm run serve`. CLI progress is on **stderr**; report markdown on **stdout**.

---

## Update, restart, uninstall

**Update dependencies**

```bash
git pull                  # if using git
npm install
npm test
```

**Restart** — stop the server with `Ctrl+C`, then `npm run serve` again. Prompt changes under `prompts/` apply on the next audit without restart.

**Remove clone cache**

```bash
rm -rf .cache/repos
```

**Uninstall** — delete the project folder. Remove `node_modules/` to reclaim space. Saved audits live in `generated reports/` unless you set `MIRROR_AI_REPORTS_DIR`.

---

## Security

- **Never commit `.env`** — it is listed in `.gitignore`.
- Use **least-privilege** Bitbucket tokens scoped to required repositories.
- API keys and app passwords are **secrets**; rotate if leaked.
- The `cli` runner uses `--restricted` (read-only, no network) for audits.
- Do not paste production credentials into issues, chats, or screenshots.
- Distributing the project: share source without `node_modules/`, `.cache/`, `.env`, or `generated reports/` unless reports are intentionally included.

---

## How audits work

`prompts/business-logic-audit.md` drives **Find differences**. Skills in `prompts/skills/` add sections (e.g. UI Difference, API Contract Drift). Each skill’s `### N.` heading controls order.

**Runners**

- **`cli` (default)** — `claude -p` with repository read access; best coverage.
- **`api`** — Anthropic Messages API with keyword-gathered files; bounded by `MIRROR_AI_EVIDENCE_BUDGET`.

| Variable | Default | Effect |
|----------|---------|--------|
| `MIRROR_AI_RUNNER` | auto | Force `cli` or `api` |
| `MIRROR_AI_EFFORT` | `high` | Thinking effort |
| `MIRROR_AI_CONCURRENCY` | `3` | Parallel sections |
| `MIRROR_AI_TIMEOUT_MS` | `2700000` | Per-section ceiling |
| `MIRROR_AI_EVIDENCE_BUDGET` | `200000` | API runner source cap |

Sections stream to the UI as they finish (`POST /api/audits`, poll `GET /api/audits`). Reports cache under `generated reports/` when commits and prompts match.

### Skills (high level)

- **`ui-skill`** — Section 3 UI Difference; element counts and match/drift; percentages computed in the browser.
- **`api-skill`** — Section 4 API Contract Drift, discovered from the **pinned Android/iOS checkouts** using the superapp-workspace workflow in `prompts/references/api-contract-drift-workflow.md` (from `feature/api-contract-drift-v2`). Module scope by default; whole-app mode inventories every wired BFF path. No static Jamaica appendix is appended to audits.

The `reference/superapp-jamaica-api-contract-drift.md` file and `tools/api-drift/render-reference.ts` remain for optional offline canvas rendering, not for automatic audit output.

### Module groups caveat

**Android only** / **iOS only** follow **enum membership**, not whether a feature exists on the other platform. Audits often still find cross-platform implementations.

---

## Development

```bash
npm test
npm run typecheck
```

TypeScript sources live in `src/`; tests in `tests/`.

---

## License

Mirror AI is `private` in `package.json`. Dependencies (`@anthropic-ai/sdk`, `shiki`, etc.) carry their own licenses under `node_modules/`. Confirm distribution rights with your organization before sharing outside your team.
