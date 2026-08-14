# Test Safety — Running Paperclip Tests Without Damaging Production

## The Problem

The production Paperclip container (`paperclip-ezk7-paperclip-1`) exports these
environment variables to every child process:

| Variable | Value |
|---|---|
| `PAPERCLIP_HOME` | `/paperclip` |
| `PAPERCLIP_INSTANCE_ID` | `default` |
| `PAPERCLIP_CONFIG` | `/paperclip/instances/default/config.json` |
| `PAPERCLIP_CONTEXT` | `/paperclip/context.json` |

Any test that calls real (non-mocked) server code inheriting that env addresses
**production**.  This has already happened:

- `worktree-config.test.ts` set `PAPERCLIP_IN_WORKTREE=true` without clearing
  ambient vars, and `maybeRepairLegacyWorktreeConfigAndEnvFiles()` rewrote
  `/paperclip/instances/default/.env` at 19:35:48Z (see AGE-3632).
- Test fixture runtime services were registered under
  `/paperclip/.paperclip/instances/default/runtime-services/`, some spawning
  real listening processes.
- `packages/*/node_modules` were rewritten against the prod volume.

**A test run reassigning the live embedded-Postgres port is an outage, and
nothing structural prevented it.**

## The Rule

**Never run `pnpm test` or `pnpm test:run` inside the production container.**

Tests belong in a scratch checkout outside the production data volume, in a
shell whose env has all `PAPERCLIP_*` vars unset.

## Safe Procedure

### 1. Clone the repo to a scratch location

```sh
cd /tmp
git clone git@github.com:chrisabad/paperclip.git paperclip-test-$(date +%s)
cd paperclip-test-*
```

### 2. Unset all production env vars

```sh
unset PAPERCLIP_HOME PAPERCLIP_INSTANCE_ID PAPERCLIP_CONFIG PAPERCLIP_CONTEXT
unset PAPERCLIP_IN_WORKTREE PAPERCLIP_WORKTREE_NAME
```

### 3. Install and run tests

```sh
pnpm install
pnpm test
```

### 4. Clean up

```sh
cd / && rm -rf /tmp/paperclip-test-*
```

## Guard Script

The repo includes `scripts/safe-test.sh` which detects production env vars and
refuses to run if any are set.  It is wired into the default test entrypoint:
`pnpm test` now invokes the guard first, so running the suite inside the
production container is refused by default.

```sh
pnpm test          # runs the guard, then the suite if the env is safe
./scripts/safe-test.sh --check   # check only, exit 0 if safe
```

The guard refuses to run if any of `PAPERCLIP_HOME`, `PAPERCLIP_INSTANCE_ID`,
`PAPERCLIP_CONFIG`, `PAPERCLIP_CONTEXT`, `PAPERCLIP_IN_WORKTREE`, or
`PAPERCLIP_WORKTREE_NAME` are set, or if the repo path resolves under
`/paperclip/*`.  To run tests directly without the guard (e.g. from a scratch
checkout where the env is already known safe), use `pnpm test:run`.

## Source Clones in the Production Data Volume

Two full Paperclip source clones exist inside the production data volume:

| Path | Branch |
|---|---|
| `/paperclip/paperclip` | `clean/age-3471` |
| `/paperclip/instances/default/data/repos/paperclip` | (not present) |

The first (`/paperclip/paperclip`) is the one agents have been running tests
from.  It is on branch `clean/age-3471` and is **not** the deployed version.

**Decision:** The clone at `/paperclip/paperclip` should be moved out of the
production data volume to a scratch location.  It is not needed for production
operation — the deployed version is the Docker image, not a git checkout.

## Verification

After following the safe procedure, confirm:

1. `echo $PAPERCLIP_HOME` is empty
2. `pwd` is **not** under `/paperclip/`
3. `./scripts/safe-test.sh --check` prints "OK: Environment looks safe"
