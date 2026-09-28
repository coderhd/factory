#!/usr/bin/env python3
"""Deterministic tests for the Span-01 Lite shadow trial (no network).

Covers Task 1 (question pack) now; Tasks 2-4 append harness tests here.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "scripts" / "span-trial-questions.json"

ALL_16_TASKS = [
    "exploration",
    "repository-analysis",
    "planning",
    "architecture",
    "implementation",
    "refactoring",
    "debugging",
    "test-generation",
    "test-debugging",
    "ci-troubleshooting",
    "documentation",
    "code-review",
    "security-review",
    "adversarial-review",
    "second-opinion",
    "large-context-analysis",
]
COARSE_FAMILIES = {"build", "investigate", "decide", "review", "consult"}

FAILURES = []


def check(name, cond, detail=""):
    print(
        ("PASS " if cond else "FAIL ")
        + name
        + (f" ({detail})" if detail and not cond else "")
    )
    if not cond:
        FAILURES.append(name)


def test_pack_exists_and_versioned():
    pack = json.loads(PACK.read_text())
    check("pack loads as JSON", isinstance(pack, dict))
    check("pack has version", isinstance(pack.get("version"), str))
    return pack


def test_coarse_map_covers_all_tasks(pack):
    m = pack["coarse_map"]
    check(
        "coarse map covers all 16 tasks",
        set(m) == set(ALL_16_TASKS),
        f"missing={set(ALL_16_TASKS) - set(m)}",
    )
    check(
        "coarse families valid",
        set(m.values()) <= COARSE_FAMILIES,
        f"bad={set(m.values()) - COARSE_FAMILIES}",
    )


def test_task_definitions_complete(pack):
    defs = pack["task_definitions"]
    check("16 task definitions", set(defs) == set(ALL_16_TASKS))
    check(
        "definitions are one-liners",
        all(
            isinstance(v, str) and 20 <= len(v) <= 300 and "\n" not in v
            for v in defs.values()
        ),
    )


def test_pack_prompt_budget(pack):
    total = sum(len(v) for v in pack["task_definitions"].values())
    total += sum(len(v) for v in pack["complexity_definitions"].values())
    total += len(pack["risk_definition"])
    check("pack prompt budget under 12k chars", total < 12_000, f"total={total}")


def test_selection_rules_pinned(pack):
    check("task selection rule pinned", pack.get("task_selection") == "argmax_present")
    check("risk threshold pinned", pack.get("risk_threshold") == 0.5)
    check("4 complexity levels", len(pack["complexity_definitions"]) == 4)


if __name__ == "__main__":
    pack = test_pack_exists_and_versioned()
    test_coarse_map_covers_all_tasks(pack)
    test_task_definitions_complete(pack)
    test_pack_prompt_budget(pack)
    test_selection_rules_pinned(pack)
    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURES")
        sys.exit(1)
    print("\nAll span trial pack tests pass.")
