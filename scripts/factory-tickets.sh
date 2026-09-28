#!/bin/sh
# scripts/factory-tickets.sh --spec <spec> --plan <plan> [--dry-run]
#   [--complexity <label>] [--model <opencode-go id>] [--confidence <0-1>] [--disputed]
set -e
SPEC=""; PLAN=""; DRY=""; COMPLEXITY="pending"; MODEL="pending"; CONF="pending"; DISPUTED="no"
while [ $# -gt 0 ]; do case "$1" in --spec) SPEC="$2"; shift 2;; --plan) PLAN="$2"; shift 2;; --dry-run) DRY=1; shift;; --complexity) COMPLEXITY="$2"; shift 2;; --model) MODEL="$2"; shift 2;; --confidence) CONF="$2"; shift 2;; --disputed) DISPUTED="yes"; shift;; *) shift;; esac; done
[ -n "$SPEC" ] && [ -n "$PLAN" ] || { echo "usage: $0 --spec <spec> --plan <plan> [--dry-run] [--complexity L] [--model ID] [--confidence C] [--disputed]"; exit 1; }
cmd_title="[Epic] $(basename "$SPEC" .md)"
cmd_body="spec: $SPEC
plan: $PLAN
Factory: WO-pending
complexity: $COMPLEXITY
model: $MODEL
confidence: $CONF
disputed: $DISPUTED
Acceptance: see plan"
if [ -n "$DRY" ]; then printf 'gh issue create --title %s --body %s\n' "$cmd_title" "$cmd_body"; else gh issue create --title "$cmd_title" --body "$cmd_body"; fi
