#!/usr/bin/env bash
# audit-unmerged-pr-done-issues.sh
# Reports AGE issues in "done" state that still have unmerged linked PR work products.
# Exit 0 = clean, exit 1 = violations found.

set -euo pipefail

PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
API_BASE="${PAPERCLIP_API_URL%/}/api"
COMPANY_ID="${1:?Usage: $0 <companyId>}"

log() { echo "[audit-unmerged-pr] $*"; }
warn() { echo "[audit-unmerged-pr] WARN: $*" >&2; }
fail() { echo "[audit-unmerged-pr] ERROR: $*" >&2; exit 1; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing: $1"; }
require_cmd curl
require_cmd jq

# Fetch all done issues for the company (paginated)
violations=0
offset=0
limit=200
done_issue_ids=()

while true; do
  resp=$(curl -sfS "${API_BASE}/companies/${COMPANY_ID}/issues?status=done&limit=${limit}&offset=${offset}" 2>/dev/null) || fail "API request failed"
  ids=$(echo "$resp" | jq -r '.[].id' 2>/dev/null) || break
  count=$(echo "$ids" | grep -c . || true)
  [ "$count" -eq 0 ] && break
  for id in $ids; do done_issue_ids+=("$id"); done
  [ "$count" -lt "$limit" ] && break
  offset=$((offset + limit))
done

if [ ${#done_issue_ids[@]} -eq 0 ]; then
  log "No done issues found for company ${COMPANY_ID}"
  exit 0
fi

log "Checking ${#done_issue_ids[@]} done issues for unmerged PR work products..."

for issue_id in "${done_issue_ids[@]}"; do
  wps=$(curl -sfS "${API_BASE}/issues/${issue_id}/work-products" 2>/dev/null) || continue
  pr_count=$(echo "$wps" | jq '[.[] | select(.type == "pull_request")] | length' 2>/dev/null || echo 0)
  [ "$pr_count" -eq 0 ] && continue

  unmerged=$(echo "$wps" | jq -r '[.[] | select(.type == "pull_request" and .status != "merged")] | length' 2>/dev/null || echo 0)
  failing_ci=$(echo "$wps" | jq -r '[.[] | select(.type == "pull_request" and .healthStatus == "unhealthy")] | length' 2>/dev/null || echo 0)

  if [ "$unmerged" -gt 0 ] || [ "$failing_ci" -gt 0 ]; then
    identifier=$(curl -sfS "${API_BASE}/issues/${issue_id}" 2>/dev/null | jq -r '.identifier // .id' 2>/dev/null || echo "$issue_id")
    log "VIOLATION: issue ${identifier} is done but has unmerged/unhealthy PR work products (unmerged=${unmerged}, failing_ci=${failing_ci})"
    violations=$((violations + 1))
  fi
done

if [ "$violations" -gt 0 ]; then
  log "Found ${violations} violation(s)"
  exit 1
fi

log "All done issues have merged PR work products. Clean."
exit 0
