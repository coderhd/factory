#!/bin/sh
# scripts/worktree-new.sh --dry-run <ticket> | <ticket>
set -e
DRY=""; T=""
[ "$1" = "--dry-run" ] && { DRY=1; T="$2"; } || T="$1"
[ -n "$T" ] || { echo "usage: $0 [--dry-run] <ticket>"; exit 1; }
[ -n "$DRY" ] && echo "git worktree add ../worktrees/$T -b $T" || git worktree add "../worktrees/$T" -b "$T"
