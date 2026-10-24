# mirror-ai-skills — marketplace package

**Mirror AI** bundled as an [Agent Skill](https://skills.sh/). Developers install once; **`/mirror-ai`** runs setup and opens the comparison UI.

## Install (other developers)

```bash
npx skills add wilsondaniel-arch/mirror-ai-skills@mirror-ai -g -y
```

Then in Cursor (or any supported agent): type **`/mirror-ai`**. The agent runs `scripts/start.sh`, which:

1. Copies the bundled app into **`~/.mirror-ai`** (first time)
2. Runs **`setup.sh`** (`npm install`) if needed
3. Starts **`scripts/start-ui.sh`** and opens http://127.0.0.1:4173/

## Repo layout

```
mirror-ai/
  SKILL.md          # Agent instructions
  scripts/
    start.sh        # Entry point for /mirror-ai
    bootstrap.sh    # Install to ~/.mirror-ai
  app/              # Full Mirror AI source (no node_modules)
```

## First-time publish (GitHub)

### Fine-grained PAT only (wilsondaniel-arch)

Fine-grained tokens **cannot** run `gh repo create` — create the repo in the UI first, then grant **write** on that repo.

1. **Create empty repo** (no README):  
   [github.com/new?name=mirror-ai-skills&visibility=public](https://github.com/new?name=mirror-ai-skills&visibility=public)  
   Owner: **wilsondaniel-arch**

2. **Token** → GitHub **Settings → Developer settings → Fine-grained personal access tokens** → your token (or create one):
   - **Repository access:** Only select repositories → **mirror-ai-skills**
   - **Repository permissions:**
     - **Contents:** Read and write *(required for `git push`)*
     - **Metadata:** Read-only *(default)*
   - Optional later: **Administration:** Read and write *(only if you use `DELETE_OLD_PERSONAL_REPO=1` to delete the old repo via `gh`)*

3. **Point `gh` at that token** (paste the `github_pat_...` value when prompted):

   ```bash
   gh auth logout -h github.com -u wilsondaniel-arch
   gh auth login -h github.com -p https
   # Choose: Paste an authentication token
   gh auth setup-git -h github.com
   ```

4. **Push** from the Mirror AI project:

   ```bash
   PUSH_ONLY=1 ./scripts/publish-skill-repo.sh
   ```

If push still returns **403**, the token is missing **Contents: Read and write** on `mirror-ai-skills`, or `gh` is still using another account (`gh auth status`).

### Browser login (alternative)

`gh auth login -h github.com -w` uses an OAuth token (`gho_...`) with broader scopes if you prefer not to manage PAT permissions.

From the main **Mirror AI** project:

```bash
chmod +x scripts/publish-skill-repo.sh
./scripts/publish-skill-repo.sh
```

To drop the old personal repo after Paytm is live:

```bash
DELETE_OLD_PERSONAL_REPO=1 ./scripts/publish-skill-repo.sh
```

Override owner if needed: `SKILL_REPO_OWNER=other-user ./scripts/publish-skill-repo.sh`

## Publish updates

From the main **Mirror AI** project (not this folder only):

```bash
./scripts/package-for-skill.sh
cd skills
git add -A
git commit -m "chore: refresh bundled Mirror AI app"
git push
```

Users update with:

```bash
npx skills update mirror-ai -g -y
```

## skills.sh

Public GitHub repos are installable via `npx skills add`. Listing on [skills.sh](https://skills.sh/) grows with installs and search — there is no separate upload form.

## Cursor Marketplace

This repo is packaged as a **Cursor / Agent Plugin** (`plugin.json` and `.cursor-plugin/plugin.json`).

1. **Install locally (test before submit):** Cursor → **Customize** → search **mirror-ai**, or install from Git once listed.
2. **Submit for listing:** [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish) — paste  
   `https://github.com/wilsondaniel-arch/mirror-ai-skills`  
   Cursor manually reviews open-source plugins before they appear in the marketplace.
3. **Usage:** After install, invoke **`/mirror-ai`** in Agent chat (see `mirror-ai/SKILL.md`).

**Teams / Enterprise:** You can also publish from **Customize → Skills** → your personal **mirror-ai** skill → **Publish** to your team’s Default marketplace (no public review).
