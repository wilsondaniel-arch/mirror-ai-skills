#!/usr/bin/env bash
# Create or update the marketplace skill repo on GitHub and optionally remove the old personal copy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DIR="$ROOT/skills"
OWNER="${SKILL_REPO_OWNER:-wilsondaniel-arch}"
REPO="${SKILL_REPO_NAME:-mirror-ai-skills}"
OLD_OWNER="${SKILL_REPO_OLD_OWNER:-Wilson-Daniel-30}"
DELETE_OLD="${DELETE_OLD_PERSONAL_REPO:-0}"
PUSH_ONLY="${PUSH_ONLY:-0}"

REPO_SLUG="$OWNER/$REPO"
REMOTE_URL="https://github.com/$REPO_SLUG.git"

print_token_help() {
  cat <<'EOF'

Could not create the repo via `gh` (common with fine-grained PATs: github_pat_...).

Option A — browser login (recommended; full `gh` permissions):
  gh auth logout -h github.com -u wilsondaniel-arch
  gh auth login -h github.com
  Choose: GitHub.com → HTTPS → Login with a web browser
  Do NOT paste a fine-grained PAT unless it has Contents: Read and write.

Option B — create empty repo in the browser, then push only:
  https://github.com/new?name=mirror-ai-skills&visibility=public
  (owner: wilsondaniel-arch, no README/.gitignore)

  PUSH_ONLY=1 ./scripts/publish-skill-repo.sh

EOF
}

print_write_token_help() {
  cat <<'EOF'

Git push failed: your token cannot write to the repository.

Fine-grained PAT (github_pat_...) checklist:
  GitHub → Settings → Developer settings → Fine-grained tokens → your token
  → Repository access: mirror-ai-skills
  → Contents: Read and write
  → Save, then:
     gh auth login -h github.com -p https   # paste updated token
     gh auth setup-git -h github.com
     PUSH_ONLY=1 ./scripts/publish-skill-repo.sh

Or use browser login: gh auth login -h github.com -p https -w

EOF
}

assert_can_write_contents() {
  local probe_b64
  probe_b64="$(printf '%s' 'mirror-ai-publish-probe' | base64 | tr -d '\n')"
  if gh api -X PUT "repos/$REPO_SLUG/contents/.mirror-ai-publish-probe" \
    -f message="mirror-ai publish preflight" \
    -f content="$probe_b64" >/dev/null 2>&1; then
    local sha
    sha="$(gh api "repos/$REPO_SLUG/contents/.mirror-ai-publish-probe" --jq .sha 2>/dev/null || true)"
    if [ -n "$sha" ]; then
      gh api -X DELETE "repos/$REPO_SLUG/contents/.mirror-ai-publish-probe" \
        -f message="remove publish preflight" \
        -f sha="$sha" >/dev/null 2>&1 || true
    fi
    return 0
  fi
  return 1
}

configure_remote_and_push() {
  if ! assert_can_write_contents; then
    echo "ERROR: GitHub token cannot write repository contents."
    print_write_token_help
    exit 1
  fi

  if ! git remote get-url origin >/dev/null 2>&1; then
    git remote add origin "$REMOTE_URL"
  else
    git remote set-url origin "$REMOTE_URL"
  fi

  gh auth setup-git -h github.com 2>/dev/null || true
  if ! git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u origin HEAD; then
    echo "ERROR: git push failed."
    print_write_token_help
    exit 1
  fi
}

if [ ! -d "$SKILLS_DIR/.git" ]; then
  echo "ERROR: $SKILLS_DIR is not a git repo."
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI (gh) is required. https://cli.github.com/"
  exit 1
fi

ACTIVE="$(gh api user -q .login 2>/dev/null || true)"
echo "GitHub CLI active account: ${ACTIVE:-unknown}"
echo "Target: https://github.com/$REPO_SLUG"

if [ -n "$ACTIVE" ] && [ "$ACTIVE" != "$OWNER" ]; then
  echo "WARNING: Active gh user is '$ACTIVE' but OWNER is '$OWNER'. Run: gh auth switch"
fi

cd "$SKILLS_DIR"

if [ "$PUSH_ONLY" = "1" ]; then
  echo "PUSH_ONLY=1 — skipping gh repo create."
  if ! gh repo view "$REPO_SLUG" >/dev/null 2>&1; then
    echo "ERROR: $REPO_SLUG not found. Create it on GitHub first, then re-run."
    print_token_help
    exit 1
  fi
  configure_remote_and_push
elif gh repo view "$REPO_SLUG" >/dev/null 2>&1; then
  echo "Repository $REPO_SLUG already exists — pushing."
  configure_remote_and_push
else
  echo "Creating $REPO_SLUG and pushing..."
  if ! gh repo create "$REPO_SLUG" \
    --public \
    --description "Mirror AI — Agent Skill marketplace bundle (/mirror-ai)" \
    --source=. \
    --remote=origin \
    --push 2>"/tmp/gh-repo-create-$$.err"; then
    if grep -q "createRepository" "/tmp/gh-repo-create-$$.err" 2>/dev/null; then
      echo "ERROR: GitHub token cannot create repositories."
      print_token_help
      rm -f "/tmp/gh-repo-create-$$.err"
      exit 1
    fi
    cat "/tmp/gh-repo-create-$$.err" >&2
    rm -f "/tmp/gh-repo-create-$$.err"
    exit 1
  fi
  rm -f "/tmp/gh-repo-create-$$.err"
fi

echo ""
echo "Install command for teammates:"
echo "  npx skills add $OWNER/$REPO@mirror-ai -g -y"

if [ "$DELETE_OLD" = "1" ] && [ "$OLD_OWNER" != "$OWNER" ]; then
  if gh repo view "$OLD_OWNER/$REPO" >/dev/null 2>&1; then
    echo "Deleting $OLD_OWNER/$REPO ..."
    gh repo delete "$OLD_OWNER/$REPO" --yes
  else
    echo "No repo at $OLD_OWNER/$REPO (already removed)."
  fi
else
  echo ""
  echo "Old personal repo (if any): $OLD_OWNER/$REPO"
  echo "After install works: DELETE_OLD_PERSONAL_REPO=1 ./scripts/publish-skill-repo.sh"
fi
