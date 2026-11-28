#!/usr/bin/env bash
# One entrypoint for the whole loop. Replaces "remember the right sequence".
#
#   scripts/gate.sh fast          ~15 s   build + every JS/Python test (run before every commit)
#   scripts/gate.sh full          ~20 min request full browser acceptance for HEAD and wait
#   scripts/gate.sh ci            ~2 s   assert a CI run exists for HEAD and is green
#   scripts/gate.sh merge [PR]    gate    refuse to merge unless a GREEN full run exists for the exact head
#   scripts/gate.sh publish [PR]  gate    merge, publish, and verify the public bytes
#
# The point of `ci`/`merge`: `gh pr checks` prints "no checks reported" (success-looking)
# when no run was ever created for a SHA. That silently dropped the gate once. Here a
# missing run is an error, not an absence.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
SHA=$(git rev-parse HEAD)
DRY=${DRY_RUN:-}

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

fast() {
  say "build (deterministic)"
  python3 scripts/build.py .
  say "JavaScript regression tests"
  node --test tests/*.js
  say "release build and probe routing tests"
  python3 -m unittest tests.test_release_build tests.test_probe_matrix tests.test_probe_shards
  say "fast gate green: $(python3 -c "import hashlib,pathlib;print(hashlib.sha256(pathlib.Path('dist/Operation Blackout.html').read_bytes()).hexdigest()[:16])")"
}

# Run id of the newest run for $1 (event filter optional) at $SHA.
run_id_for_sha() {
  local sha=$1 event=${2:-}
  gh api "repos/$REPO/actions/runs?per_page=100" \
    --jq "[.workflow_runs[] | select(.head_sha==\"$sha\")${event:+ | select(.event==\"$event\")}] | sort_by(.created_at) | last | .id // empty"
}

ci() {
  local sha=${1:-$SHA} id
  id=$(run_id_for_sha "$sha")
  [ -n "$id" ] || die "no CI run exists for $sha — push, or trigger: scripts/gate.sh full"
  gh run watch "$id" --exit-status >/dev/null 2>&1 || true
  gh run view "$id" --json status,conclusion,displayTitle,event,headSha \
    --jq '"run \(.databaseId // "") \(.status) \(.conclusion) [\(.event)] \(.headSha[0:8])"' 2>/dev/null || true
  local concl
  concl=$(gh api "repos/$REPO/actions/runs/$id" --jq .conclusion)
  [ "$concl" = success ] || die "CI run $id concluded: $concl"
  say "CI green for $sha (run $id)"
}

full() {
  local pr=${1:-}
  if [ -z "$pr" ]; then
    say "dispatching full acceptance for $SHA"
    gh workflow run ci.yml --ref "$(git rev-parse --abbrev-ref HEAD)"
  else
    say "labelling PR #$pr full-ci"
    gh pr edit "$pr" --add-label full-ci
    say "dispatching full acceptance on PR #$pr head"
    gh workflow run ci.yml --ref "$(gh pr view "$pr" --json headRefName --jq .headRefName)"
  fi
  say "waiting for the run to be created"
  local id="" i
  for i in $(seq 1 24); do
    id=$(run_id_for_sha "$SHA" workflow_dispatch)
    [ -n "$id" ] && break
    sleep 5
  done
  [ -n "$id" ] || die "no full run appeared for $SHA after 2 minutes"
  say "watching run $id (~19 min)"
  gh run watch "$id" --exit-status
  say "full acceptance green for $SHA"
}

merge() {
  local pr=${1:-}
  [ -n "$pr" ] || die "usage: gate.sh merge <pr-number>"
  python3 scripts/build.py . >/dev/null
  local head id concl
  head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  [ "$head" = "$SHA" ] || die "PR #$pr head is ${head:0:8}, local HEAD is ${SHA:0:8} — check out the PR head first"
  # Full run for the exact head, not just "a green run somewhere".
  gh api "repos/$REPO/actions/runs?per_page=100" \
    --jq "[.workflow_runs[] | select(.head_sha==\"$head\") | select(.conclusion!=\"\")] | length" \
    | grep -qv '^0$' || die "no completed run for ${head:0:8}"
  concl=$(gh api "repos/$REPO/actions/runs?per_page=100" \
    --jq "[.workflow_runs[] | select(.head_sha==\"$head\") | select(.conclusion==\"success\")]
          | map(select(.event==\"workflow_dispatch\" or (.event==\"pull_request\" and .name==\"CI\")))
          | length")
  # A green pull_request run counts only if it actually ran the browser matrix.
  local full_green
  full_green=$(gh api "repos/$REPO/actions/runs?per_page=100" \
    --jq "[.workflow_runs[] | select(.head_sha==\"$head\") | select(.conclusion==\"success\") | select(.event==\"workflow_dispatch\")] | length")
  if [ "${full_green:-0}" = "0" ]; then
    # Fall back: inspect the PR run's jobs for the browser shards.
    local rid
    rid=$(gh api "repos/$REPO/actions/runs?per_page=100" \
      --jq "[.workflow_runs[] | select(.head_sha==\"$head\") | select(.event==\"pull_request\")] | sort_by(.created_at) | last | .id // empty")
    [ -n "$rid" ] || die "no full acceptance run for ${head:0:8} — run: scripts/gate.sh full $pr"
    gh api "repos/$REPO/actions/runs/$rid/jobs?per_page=100" \
      --jq '[.jobs[] | select(.name|startswith("Browser /")) | .conclusion] | if length < 4 then "missing" else (unique|join(",")) end' \
      | grep -qx success || die "full browser acceptance is not green for ${head:0:8} — run: scripts/gate.sh full $pr"
  fi
  say "merging PR #$pr at ${head:0:8}"
  [ -n "$DRY" ] && { echo "(dry run)"; return 0; }
  gh pr merge "$pr" --squash --delete-branch
}

publish() {
  merge "${1:-}"
  say "publishing accepted bytes"
  /home/server/.hermes/scripts/ob-herenow-publish.sh
}

case "${1:-}" in
  fast)    fast ;;
  full)    full "${2:-}" ;;
  ci)      ci "${2:-}" ;;
  merge)   merge "${2:-}" ;;
  publish) publish "${2:-}" ;;
  *) sed -n '2,16p' "$0"; exit 1 ;;
esac
