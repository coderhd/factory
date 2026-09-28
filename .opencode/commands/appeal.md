---
description: Span triage with GLM-5.3-Flash appeal on low margin
agent: general
subagent: true
---
Run Span triage on the request: `python3 scripts/span-trial.py --live --prompt "$ARGUMENTS"`.
Read the verdict:
- ROUTE (margin >= 0.2): proceed on the Span task. Record `route_model`, `route_reason`, margin to session metadata.
- APPEAL (margin < 0.2): the brief is printed as JSON. Recommend `/route opencode-go/glm-5.3-flash` with the brief attached, so the appeal judge sees Span's top choice plus confidence/margin. Append one JSON line to `.factory/routing.log`.
If the harness reports key/network errors, fall back to the rules route (`route_model` from prompt-hook metadata) and note the fallback. Never block the task on triage failure.
