#!/usr/bin/env python3
"""Stamp a deterministic, task-stratified 80/20 train/verify split onto the
eval corpora (run again whenever cases are added; seed fixed for repro).

Rule per task group (ids sorted): every 5th case -> verify; groups with
>=2 members but no 5th position contribute their last case. Singletons stay
in train. Result ~80/20 with every multi-case task represented in verify.
Known-limitation cases are stamped like any other item (the runner treats
them as gate-neutral in every split).
"""

import json
from collections import defaultdict
from pathlib import Path

SEED_NOTE = "deterministic by sorted id (no RNG state to reproduce)"
ROOT = Path(__file__).resolve().parents[1]
FILES = sorted(p.name for p in ROOT.glob("scripts/router-eval-*.json"))

by_task = defaultdict(list)
sources = {}
for name in FILES:
    p = ROOT / "scripts" / name
    for case in json.loads(p.read_text()):
        by_task[case["expected"]["task"]].append(case["id"])
        sources[case["id"]] = name

verify = set()
for task, ids in sorted(by_task.items()):
    ids = sorted(ids)
    picks = {i for i in range(len(ids)) if (i + 1) % 5 == 0}
    if not picks and len(ids) >= 2:
        picks = {len(ids) - 1}
    for i in picks:
        verify.add(ids[i])

for name in FILES:
    p = ROOT / "scripts" / name
    cases = json.loads(p.read_text())
    for case in cases:
        case["split"] = "verify" if case["id"] in verify else "train"
    p.write_text(json.dumps(cases, indent=2) + "\n")

n_v, n_t = len(verify), sum(len(v) for v in by_task.values()) - len(verify)
print(f"train={n_t} verify={n_v} ({n_v / (n_t + n_v):.0%}) [{SEED_NOTE}]")
print("verify ids: " + ", ".join(sorted(verify)))
