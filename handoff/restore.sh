#!/usr/bin/env bash
# Restores the gitignored handoff state into a clone of acquit.
# Usage: from the repo root on main, run:
#   git fetch origin handoff/cloud && bash <(git show FETCH_HEAD:handoff/restore.sh)
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"
# Cloud clones are single-branch; without this, stack branches can't track origin.
git config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git fetch -q origin

src="$(mktemp -d)"
git archive origin/handoff/cloud handoff | tar -x -C "$src"
h="$src/handoff"

mkdir -p data/trail
for f in "$h"/trail/*; do
  [ -e "data/trail/$(basename "$f")" ] && { echo "refusing to overwrite data/trail/$(basename "$f")"; exit 1; }
done
cp "$h"/trail/* data/trail/

mkdir -p scratch/verifier scratch/verifier-judge
cp -rn "$h"/fixtures/verifier/. scratch/verifier/
cp -rn "$h"/fixtures/verifier-judge/. scratch/verifier-judge/
[ -d scratch/verifier/invoice-app ] || git clone -q "$h/fixtures/invoice-app.bundle" scratch/verifier/invoice-app
(cd scratch/verifier/invoice-app && for b in $(git branch -r | grep -v HEAD | sed 's#origin/##'); do git show-ref -q "refs/heads/$b" || git branch -q "$b" "origin/$b"; done)
(cd scratch/verifier/toolchain && npm ci --silent)
(cd scratch/verifier-judge && node setup.mjs >/dev/null)

for b in h0-lanes f1-ledger f3-verifier; do
  git show-ref -q "refs/heads/stack/$b" || git branch -q --track "stack/$b" "origin/stack/$b"
done
mkdir -p ../acquit-worktrees
for pr in h0:h0-lanes f1:f1-ledger f3:f3-verifier; do
  dir="../acquit-worktrees/${pr%%:*}"
  [ -d "$dir" ] || git worktree add -q "$dir" "stack/${pr#*:}"
  [ -f .env ] && [ ! -f "$dir/.env" ] && cp .env "$dir/.env"
done

rm -rf "$src"
echo "restored: data/trail, scratch/verifier*, worktrees in $(cd ../acquit-worktrees && pwd)"
[ -f .env ] || echo "WARNING: .env missing; create it from README.md, then copy it into each worktree"
