#!/usr/bin/env python3
"""Classification eval gate for the factory dev router.

Runs every prompt in scripts/router-eval-cases.json through a Python mirror
of classifyTask() in .opencode/plugins/factory-guard/router.ts and asserts
the expected {task, complexity, risk, context} tuple.

Rule: any change to classifyTask() regexes must update the mirror below,
and any new defect class gets a case in router-eval-cases.json first.

Routing-matrix coverage (which model each tuple selects) lives in
scripts/test-router.py; this file covers classification only, so the two
gates compose into the full task->model path.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASES = []
for name in sorted(p.name for p in (ROOT / "scripts").glob("router-eval-*.json")):
    p = ROOT / "scripts" / name
    if p.exists():
        CASES.extend(json.loads(p.read_text()))

SPLIT = sys.argv[sys.argv.index("--split") + 1] if "--split" in sys.argv else "all"
assert SPLIT in ("train", "verify", "fresh", "fresh2", "all"), (
    "--split must be train|verify|all"
)
if SPLIT == "all":
    # Gate default: the tuned corpus only. Blind sets (fresh/fresh2) are
    # scored explicitly and never merged, so tuning can't chase them.
    CASES = [c for c in CASES if c.get("split", "train") in ("train", "verify")]
elif SPLIT != "all":
    CASES = [c for c in CASES if c.get("split", "train") == SPLIT]
print(f"split={SPLIT} n={len(CASES)}")


def parse_hint(text):
    if re.search(r"@plan\b", text, re.I):
        return {"task": "planning", "complexity": "complex"}
    if re.search(r"@architecture\b", text, re.I):
        return {"task": "architecture", "complexity": "complex"}
    if re.search(r"@review\b", text, re.I):
        return {"task": "code-review", "complexity": "normal"}
    if re.search(r"@debug\b", text, re.I):
        return {"task": "debugging", "complexity": "complex"}
    if re.search(r"@cheap\b", text, re.I):
        return {"task": "exploration", "complexity": "trivial"}
    if re.search(r"@deep\b", text, re.I):
        return {"complexity": "complex", "risk": "high"}
    return {}


def classify(text):
    """Mirror of classifyTask() in router.ts — keep in sync."""
    t = text.lower()
    hint = parse_hint(text)
    task = "implementation"
    if re.search(
        r"adversarial|try to break|red team|red-team|(?<!auth )\bbypass\w*|\bfuzz(ing|ed|er)?\b|break[- ]ins?\b",
        t,
    ):
        task = "adversarial-review"
    elif re.search(
        r"second opinion|sanity[- ]check.*(other|independent)|independent.*opinion|independent (review|assessment|take)",
        t,
    ):
        task = "second-opinion"
    elif re.search(
        r"code review|\blgtm\b|review (this|the|our|my)( \w+){0,2} (\bpr\b|\bdiffs?\b|changes?|code|module|function|endpoint|flow|logic|script|file|patch|commit|branch)|pr review",
        t,
    ):
        task = "code-review"
    elif re.search(
        r"architectural|architecture (decision|design|doc|review|change|proposal)|architecting|architected|re-architect|\barchitect\b|review.{0,30}\barchitectures?\b|(propos|design|draft|defin|creat).{0,40}\barchitectures?\b|design (doc|decision|system)|adr",
        t,
    ):
        task = "architecture"
    elif re.search(
        r"((test|spec).*fail|fail.*(test|spec|suite)|failing (test|spec|suite))", t
    ):
        task = "test-debugging"
    elif re.search(
        r"(\bplan(ned)?\b|\bspecs?\b|roadmap|decompos|work breakdown|break ?down)", t
    ):
        task = "planning"
    elif re.search(
        r"ci/cd|pipeline.*fail|github action|workflow.*fail|\bred\b (build|suite|pipeline|tests?|ci|jobs?|runs?)|(is|are|seems?|looks?|turned|went|gone) red\b|(is|are|seems?|looks?|got) (stuck|hung|frozen)",
        t,
    ):
        task = "ci-troubleshooting"
    elif re.search(
        r"debug|bug|crash|broken|\bbroke\b|\bbreaks\b|fails|failed|failure|defect|investigat(e|ion)?|stack trace|traceback|\btraces?\b|\btraced\b|failing test|test.*fail|ci fail|flaky|(repro\b|reproduc(e|es|ed|ing|ible))",
        t,
    ):
        task = (
            "test-debugging"
            if re.search(r"(test|spec).*fail|fail.*test", t)
            else "debugging"
        )
    elif re.search(
        r"write.{0,20}tests?|generat(e|es|ing|ed).{0,20}tests?|add.*test coverage|unit tests?",
        t,
    ):
        task = "test-generation"
    elif re.search(r"refactor|clean[ -]?ups?|migrate|rename", t):
        task = "refactoring"
    elif re.search(r"document|\bdocs\b|readme|changelog|docstring|jsdoc", t):
        task = "documentation"
    elif re.search(
        r"explore|search|explain|explan\w*|summar|\blist\b|\breads?\b|\breading\b|\bfind\b|where is|where (is|are|was|were|do|does|did)|what (does|is|are|was|were)|why (does|is|do|did)|how (do|does|is|was)|show (me|the|us)|walk me through",
        t,
    ):
        task = "exploration"
    elif re.search(
        r"security|vuln|cve|auth bypass|(?<!dependency )injection|xss|harden\w*|threat models?|\bpen[- ]tests?\b",
        t,
    ):
        task = "security-review"
    elif re.search(r"repo.*(analys|overview|map)|codebase", t):
        task = "repository-analysis"
    elif re.search(r"large|whole repo|entire|200k|500k|long context", t):
        task = "large-context-analysis"

    complexity = "normal"
    if re.search(r"trivial|typo|one-line|one line|rename only", t):
        complexity = "trivial"
    elif re.search(r"simple|small|quick|minor|straightforward", t):
        complexity = "simple"
    elif re.search(
        r"complex|\bhard\b|difficult|ambiguous|architectural|distributed|\braces?\b|deadlock|nondetermin",
        t,
    ):
        complexity = "complex"

    risk = "low"
    if re.search(
        r"(\bprod\b|\bproduction\b|\bsecurity\b|\bauth(entication)?\b|\bpayments?\b|\bbilling\b|\bmigrat\w*|\bpii\b|\bsecrets?\b|\bdeploy\w*)",
        t,
    ):
        risk = "high"
    elif re.search(r"(\bapis?\b|contract|schema|database|data model|breaking)", t):
        risk = "medium"

    context = "small"
    if re.search(r"xlarge|whole repo|entire codebase|>200k|500k", t):
        context = "xlarge"
    elif re.search(r"large|many files|\blong\b|full (\w+ )?file|directory", t):
        context = "large"
    elif re.search(r"medium|several files|multi-file", t):
        context = "medium"

    return {
        "task": hint.get("task", task),
        "complexity": hint.get("complexity", complexity),
        "risk": hint.get("risk", risk),
        "context": hint.get("context", context),
    }


fails = []
limited = []
for case in CASES:
    got = classify(case["prompt"])
    ok = got == case["expected"]
    tag = (
        "PASS "
        if ok
        else ("LIMIT " if case.get("status") == "known-limitation" else "FAIL ")
    )
    print(tag + case["id"])
    if not ok:
        print(f"  prompt:   {case['prompt']}")
        print(f"  expected: {case['expected']}")
        print(f"  got:      {got}")
        (limited if case.get("status") == "known-limitation" else fails).append(
            case["id"]
        )

print(
    f"\n{len(CASES) - len(fails) - len(limited)}/{len(CASES)} classification cases pass."
)
if limited:
    print("Known limitations (documented, gate-neutral): " + ", ".join(limited))
if fails:
    print("Misrouted: " + ", ".join(fails))
    sys.exit(1)
print("All classification eval cases pass.")
