#!/bin/sh
# Factory type gate (E9.9 #35). Runs `tsc --noEmit` over the Factory surface
# (`src/` + `tests/`) using the pinned compiler in tsconfig.json's repo.
#
# Bun executes TypeScript directly and strips types at runtime, so without this
# gate a test-only type slip is invisible until it breaks at runtime. This is
# the same shape `bun test` does *not* give us.
#
# Deterministic: the compiler version is pinned (never `latest`). Bun fetches it
# on first run and caches it; the check itself needs no network after that.
set -e
cd "$(dirname "$0")/.."

TSC_VERSION="5.9.3"

# `tsc --noEmit` discovers tsconfig.json in the repo root (no `-p`, so bunx
# cannot mistake the flag for its own `--package`).
if command -v bun >/dev/null 2>&1; then
  exec bunx "--package=typescript@${TSC_VERSION}" tsc --noEmit
fi

if command -v npx >/dev/null 2>&1; then
  exec npx --yes "--package=typescript@${TSC_VERSION}" tsc --noEmit
fi

echo "check-tsc.sh: neither bun nor npx found; cannot run the type gate" >&2
exit 1
