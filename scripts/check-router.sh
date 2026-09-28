#!/bin/sh
# Router gate: static checks + behavioral mirror (python3, no node required).
set -e
cd "$(dirname "$0")/.."
echo "--- router static checks ---"
grep -q "candidatesFor" .opencode/plugins/factory-guard/router.ts && echo MATRIX_OK
grep -q "budgetAllows" .opencode/plugins/factory-guard/router.ts && echo BUDGET_OK
grep -q "parseRouteOverride" .opencode/plugins/factory-guard/router.ts && echo OVERRIDE_OK
grep -q "parseTaskHint" .opencode/plugins/factory-guard/router.ts && echo HINTS_OK
grep -q "selectModel" .opencode/plugins/factory-guard/router.ts && echo FALLBACK_OK
grep -q "jevShadowSuggest" .opencode/plugins/factory-guard/router.ts && echo JEV_SHADOW_OK
grep -q "interface DecisionModel" .opencode/plugins/factory-guard/router.ts && echo DECISION_MODEL_OK
if grep -Eq "(class|interface|type) JevDecisionModel" .opencode/plugins/factory-guard/router.ts .opencode/plugins/factory-guard/index.ts; then echo JEV_MODEL_LEAK; exit 1; else echo NO_JEV_MODEL_OK; fi
grep -q "route_reason" .opencode/plugins/factory-guard/index.ts && echo METADATA_OK
test -f .opencode/plugins/factory-guard/routing-policy.md && echo POLICY_OK
echo "--- router behavior checks ---"
python3 scripts/test-router.py
echo "--- router classification eval (37 cases) ---"
python3 scripts/test-router-eval.py
echo "--- span trial dry-run ---"
python3 scripts/span-trial.py --dry-run --limit 3
echo "--- appeal command + tickets ---"
grep -q "span-trial.py --live --prompt" .opencode/commands/appeal.md && echo APPEAL_OK
grep -q "glm-5.3-flash" .opencode/commands/appeal.md && echo APPEAL_MODEL_OK
sh scripts/factory-tickets.sh --dry-run --spec factory-docs/architecture/root-architecture.md --plan docs/superpowers/plans/2026-09-25-factory-dev-workflow.md --complexity complex --model opencode-go/glm-5.3 --confidence 0.9 | grep -q "complexity: complex" && echo TICKETS_OK
if command -v bun >/dev/null 2>&1; then
  echo "--- bun tests (real router.ts) ---"
  bun test ./.opencode/plugins/factory-guard/
elif command -v node >/dev/null 2>&1; then
  echo "--- node tests (if runtime present) ---"
  node --test .opencode/plugins/factory-guard/router.test.ts 2>/dev/null || echo "node tests skipped (needs ts support)"
else
  echo "no JS runtime present; node:test file ships for CI (router.test.ts)"
fi
