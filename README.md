# mirror-ai-skills — marketplace package

**Mirror AI** bundled as an [Agent Skill](https://skills.sh/). Developers install once; **`/mirror-ai`** runs setup and opens the comparison UI.

## Install (other developers)

```bash
npx skills add paytm/mirror-ai-skills@mirror-ai -g -y
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

## First-time publish (Paytm GitHub)

Log in with an account that can **create repos** on the Paytm org (or your Paytm GitHub user):

```bash
gh auth login   # or: gh auth switch
```

From the main **Mirror AI** project:

```bash
chmod +x scripts/publish-skill-repo.sh
./scripts/publish-skill-repo.sh
```

To drop the old personal repo after Paytm is live:

```bash
DELETE_OLD_PERSONAL_REPO=1 ./scripts/publish-skill-repo.sh
```

Override owner if needed: `SKILL_REPO_OWNER=your-paytm-user ./scripts/publish-skill-repo.sh`

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
