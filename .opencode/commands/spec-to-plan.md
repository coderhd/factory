---
description: Spec -> plan -> tickets (explicit only)
---
Input: $ARGUMENTS = path to spec file in factory-docs/**/*.md
Steps:
1. Invoke skill to-spec if spec missing acceptance criteria.
2. Invoke skill writing-plans to write docs/superpowers/plans/<date>-<slug>.md.
3. Invoke skill to-tickets to emit epics with blocking edges.
4. Run scripts/factory-tickets.sh with plan path to create GitHub issues.
Rules: explicit invocation only. Every ticket needs spec: + plan: links + Factory: WO-* ID from prompt metadata.
