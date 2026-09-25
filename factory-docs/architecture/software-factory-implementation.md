# Software Factory Implementation Architecture

The existing `2026-09-17-software-factory-design.md` remains the authoritative Software Factory implementation baseline. This document only places it within the frozen Root architecture.

Software Factory is a standalone product, the first Factory implementation and Root proving ground.

Its existing flow remains:
```text
Work Order → Planning/DAG → demand-driven Workers → Execution/Interaction → Verification → Evidence Bundle → Human Gate → GitHub PR → Merge
```

Software Factory owns its Work Orders, Task/DAG planning, workers, Git/worktrees, verification, Evidence Bundles, human gates, repository integration, local policy/risk handling, Observatory and recovery.

Herdr remains a Worker adapter. Developer/writer and semantic verifier remain independently contextualized; deterministic verification remains foundational.

Do not refactor Software Factory into a generic Root implementation prematurely. Extract common semantics only after genuine cross-Factory evidence.
