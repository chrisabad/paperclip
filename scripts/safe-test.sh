#!/usr/bin/env bash
#
# safe-test.sh — Guard script that refuses to run the test suite inside the
# production Paperclip container.
#
# The production container exports PAPERCLIP_HOME, PAPERCLIP_INSTANCE_ID,
# PAPERCLIP_CONFIG, and PAPERCLIP_CONTEXT to every child process.  Any test
# that calls real (non-mocked) server code inheriting that env addresses
# **production** — a test reassigning the live embedded-Postgres port is an
# outage, and nothing structural prevents it.
#
# Usage:
#   ./scripts/safe-test.sh [--check]   # check only, exit 0 if safe
#   ./scripts/safe-test.sh              # check, then exec pnpm test:run
#
# To run tests safely, use a scratch checkout outside the prod data volume
# with all PAPERCLIP_* env vars unset.  See TEST-SAFETY.md for details.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Production env detection ────────────────────────────────────────────────

# These env vars are set by the production container's entrypoint.
# If any are present and non-empty, we are running inside the prod container.
DANGER_VARS=(PAPERCLIP_HOME PAPERCLIP_INSTANCE_ID PAPERCLIP_CONFIG PAPERCLIP_CONTEXT)

detected=()
for var in "${DANGER_VARS[@]}"; do
  if [[ -n "${!var:-}" ]]; then
    detected+=("$var=${!var}")
  fi
done

# Also check for the worktree vars that the worktree-config test sets.
if [[ -n "${PAPERCLIP_IN_WORKTREE:-}" ]]; then
  detected+=("PAPERCLIP_IN_WORKTREE=${PAPERCLIP_IN_WORKTREE}")
fi
if [[ -n "${PAPERCLIP_WORKTREE_NAME:-}" ]]; then
  detected+=("PAPERCLIP_WORKTREE_NAME=${PAPERCLIP_WORKTREE_NAME}")
fi

if [[ ${#detected[@]} -gt 0 ]]; then
  echo "ERROR: Refusing to run tests — production environment detected." >&2
  echo "" >&2
  echo "The following production env vars are set:" >&2
  for d in "${detected[@]}"; do
    echo "  $d" >&2
  done
  echo "" >&2
  echo "Tests MUST be run from a scratch checkout outside the production" >&2
  echo "data volume, in a shell with all PAPERCLIP_* env vars unset." >&2
  echo "See scripts/TEST-SAFETY.md for the safe procedure." >&2
  exit 1
fi

# ── Also check we are not inside the production data volume ─────────────────

# The production data volume is at /paperclip (PAPERCLIP_HOME).
# If the repo root resolves to a path under /paperclip, we are inside it.
case "$(cd "$PROJECT_ROOT" && pwd -P)" in
  /paperclip/*)
    echo "ERROR: Refusing to run tests — repo is inside production data volume." >&2
    echo "  Repo path: $PROJECT_ROOT" >&2
    echo "  Production home: /paperclip" >&2
    echo "See scripts/TEST-SAFETY.md for the safe procedure." >&2
    exit 1
    ;;
esac

# ── Check-only mode ─────────────────────────────────────────────────────────

if [[ "${1:-}" == "--check" ]]; then
  echo "OK: Environment looks safe for running tests."
  exit 0
fi

# ── Run tests ────────────────────────────────────────────────────────────────

cd "$PROJECT_ROOT"
echo "Environment looks safe. Running test suite..."
exec pnpm test:run "$@"
