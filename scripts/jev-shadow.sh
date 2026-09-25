#!/bin/sh
# scripts/jev-shadow.sh --dry-run logs what WOULD route, never switches model
set -e
# optional --dry-run flag (shadow never switches models either way)
[ "${1:-}" = "--dry-run" ] && shift
echo "shadow: complexity=${1:-routine} model-suggestion=cheap (Jev key absent = rules baseline)"
echo "rule: promote Jev to active only after same 10-30 Work Orders show Jev cost < frontier saved"
