# Pilot A (active): rules-first dev router

Mid-tier default/build/general = glm-5.3-flash (default+build rotation), deepseek-v4.1-flash (general), qwen3.8-flash (build; use qwen3.8-flash-next ID when listed on Go page). Low/search = mimo-v2.6-flash on explore. Frontier plan/verify only: glm-5.3 (plan agent), kimi-k3 / qwen3.8-max / grok-4.7 via /verify child session. GPT-6-luna is mid, not frontier — do not use for verify. No muse-spark (trains on prompts).

Full policy: see `routing-policy.md`. Implementation: `router.ts` (pure, tested). Decision log: `.factory/routing.log`.
