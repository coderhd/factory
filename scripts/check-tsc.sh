#!/bin/sh
# Factory type gate (E9.9 #35). Runs `tsc --noEmit` over the Factory surface
# (`src/` + `tests/`) with the compiler and type packages pinned in the root
# `package.json`.
#
# Bun executes TypeScript directly and strips types at runtime, so without this
# gate a test-only type slip is invisible until it breaks at runtime. This is
# the same shape `bun test` does *not* give us.
#
# Self-contained and reproducible: the compiler and `@types/bun` are ordinary
# devDependencies, installed into this repo's `node_modules`. The script never
# relies on a home-directory or global TypeScript/bun-types install, and it
# fetches nothing once the deps are present.
set -e
cd "$(dirname "$0")/.."

TSC="node_modules/.bin/tsc"

# The type deps are ordinary devDependencies (see package.json). If they are not
# installed yet — a clean checkout — install them first so the documented
# command works as-is. Versions are pinned; a lockfile makes it exact.
if [ ! -x "$TSC" ] || [ ! -d node_modules/@types/bun ]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "check-tsc.sh: type dependencies are not installed and 'bun' is unavailable." >&2
    echo "  install Bun (https://bun.sh), then run: bun install" >&2
    exit 1
  fi
  echo "check-tsc.sh: installing pinned type dependencies (bun install)..." >&2
  if [ -f bun.lock ]; then
    bun install --frozen-lockfile
  else
    bun install
  fi
fi

exec "$TSC" --noEmit
