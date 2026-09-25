#!/bin/sh
# scripts/jev-shadow.sh --dry-run logs what WOULD route, never switches model
set -e
echo "shadow: complexity=$1 model-suggestion=cheap (Jev key absent = rules baseline)"
echo "rule: promote Jev to active only after same 10-30 Work Orders show Jev cost < frontier saved"
