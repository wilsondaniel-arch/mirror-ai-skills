---
name: mirror-ai
description: >-
  Installs and runs Mirror AI from the skills marketplace — local Android vs iOS
  comparison UI with module or whole-repo audits. Use when the user invokes
  /mirror-ai, asks to install Mirror AI, start the comparison app, or open
  Mirror UI. Bootstraps Node deps on first run.
disable-model-invocation: true
---

# Mirror AI (marketplace skill)

This skill **ships the full Mirror AI app**. Other developers install it once;
**`/mirror-ai`** runs setup (if needed) and opens the UI.

**Install (once per machine):**

```bash
npx skills add wilsondaniel-arch/mirror-ai-skills@mirror-ai -g -y
```

https://github.com/wilsondaniel-arch/mirror-ai-skills · https://skills.sh/

## When to use

User says **/mirror-ai**, **install Mirror AI**, **start Mirror AI**, **open Mirror UI**, or **run Android iOS comparison**.

## What you MUST do (every /mirror-ai)

Do **not** ask the user to clone or unzip anything. Run the skill’s start script.

1. **Resolve the skill directory** (try in order until `scripts/start.sh` exists):

   ```bash
   for d in \
     "$HOME/.agents/skills/mirror-ai" \
     "$HOME/.cursor/skills/mirror-ai" \
     "${CURSOR_SKILL_DIR:-}"; do
     [ -n "$d" ] && [ -x "$d/scripts/start.sh" ] && echo "$d" && break
   done
   ```

   If nothing is found, tell the user to install:

   `npx skills add wilsondaniel-arch/mirror-ai-skills@mirror-ai -g -y`

   then run step 2 again.

2. **Bootstrap + start** (installs app to `~/.mirror-ai` on first run, then serves UI):

   ```bash
   chmod +x "<SKILL_DIR>/scripts/"*.sh
   "<SKILL_DIR>/scripts/start.sh"
   ```

   Replace `<SKILL_DIR>` with the path from step 1.

3. **Tell the user:**

   - Open **http://127.0.0.1:4173/** (or `PORT` from `~/.mirror-ai/.env` if present)
   - App files live in **`~/.mirror-ai`** (`MIRROR_AI_HOME` overrides this)
   - Logs: `~/.mirror-ai/.cache/mirror-ai-serve.log`
   - Stop server: `kill $(cat ~/.mirror-ai/.cache/mirror-ai-serve.pid)`

4. If the script reports the server is **already running**, only share the URL — do not start a second copy.

## Prerequisites (only mention if bootstrap fails)

- **Node.js 22+** — https://nodejs.org/
- **Audits** (not required to open UI): `claude login` or `ANTHROPIC_API_KEY` in `~/.mirror-ai/.env` with `MIRROR_AI_RUNNER=api`

## UI quick reference

| Goal | Action |
|------|--------|
| Per-module | Scope by module enum **on** → list modules → select → Find differences |
| Whole app | Scope **off** → Compare entire codebase |
| PDF | Download PDF when the report is visible |

## Do not

- Start a second server if one is already running
- Log or paste `.env` secrets
- Modify `~/.mirror-ai` source unless fixing a startup failure the user asked about

## Maintainer: refresh bundled app

From the Mirror AI source repo:

```bash
./scripts/package-for-skill.sh
cd skills && git add -A && git commit -m "chore: refresh bundled app" && git push
```
