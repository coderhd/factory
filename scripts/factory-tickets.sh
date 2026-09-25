#!/bin/sh
# scripts/factory-tickets.sh --spec <spec> --plan <plan> [--dry-run]
set -e
SPEC=""; PLAN=""; DRY=""
while [ $# -gt 0 ]; do case "$1" in --spec) SPEC="$2"; shift 2;; --plan) PLAN="$2"; shift 2;; --dry-run) DRY=1; shift;; *) shift;; esac; done
[ -n "$SPEC" ] && [ -n "$PLAN" ] || { echo "usage: $0 --spec <spec> --plan <plan> [--dry-run]"; exit 1; }
cmd="gh issue create --title \"[Epic] $(basename $SPEC .md)\" --body \"spec: $SPEC
plan: $PLAN
Factory: WO-pending
Acceptance: see plan\""
if [ -n "$DRY" ]; then echo "$cmd"; else eval "$cmd"; fi
