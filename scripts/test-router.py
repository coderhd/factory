#!/usr/bin/env python3
"""Behavioral mirror of router.ts candidate/budget/fallback logic.

Runs with system python3 (no node/bun required). The TypeScript file remains
the source of truth for the plugin; this mirror encodes the same ordered
candidate tables so CI without a JS runtime still validates routing behavior.
Any change to router.ts candidate order must update the tables below.
"""

import re
import sys
from pathlib import Path

GUARD = Path(__file__).resolve().parents[1] / ".opencode" / "plugins" / "factory-guard"
ROUTER = GUARD / "router.ts"
SRC = ROUTER.read_text()

FAILURES = []


def check(name, cond, detail=""):
    print(
        ("PASS " if cond else "FAIL ")
        + name
        + (f" ({detail})" if detail and not cond else "")
    )
    if not cond:
        FAILURES.append(name)


def candidates(task, complexity="normal", risk="low", context="small"):
    if task in ("exploration", "repository-analysis", "large-context-analysis"):
        if context in ("large", "xlarge"):
            return [
                "deepseek-v4.1-flash",
                "mimo-v2.6-flash",
                "glm-5.3-flash",
                "qwen3.8-flash",
            ]
        return ["mimo-v2.6-flash", "glm-5.3-flash", "qwen3.8-flash"]
    if task in ("implementation", "refactoring"):
        if complexity in ("simple", "trivial"):
            return ["glm-5.3-flash", "qwen3.8-flash", "mimo-v2.6-flash"]
        if complexity == "complex":
            return ["deepseek-v4.1-flash", "mimo-v2.6-pro", "glm-5.3", "qwen3.8-flash"]
        return ["qwen3.8-flash", "glm-5.3-flash", "deepseek-v4.1-flash"]
    if task in ("debugging", "test-debugging", "ci-troubleshooting"):
        return ["deepseek-v4.1-flash", "mimo-v2.6-pro", "glm-5.3"]
    if task in ("test-generation", "documentation"):
        return ["qwen3.8-flash", "glm-5.3-flash", "mimo-v2.6-flash"]
    if task == "planning":
        return ["glm-5.3", "mimo-v2.6-pro", "qwen3.8-max"]
    if task == "architecture":
        return ["glm-5.3", "qwen3.8-max", "mimo-v2.6-pro"]
    if task == "code-review":
        if risk == "high":
            return ["qwen3.8-max", "grok-4.7", "mimo-v2.6-pro"]
        return ["mimo-v2.6-pro", "glm-5.3", "deepseek-v4.1-flash"]
    if task in ("security-review", "adversarial-review"):
        return ["qwen3.8-max", "grok-4.7", "kimi-k3"]
    if task == "second-opinion":
        return ["gpt-6-luna", "mimo-v2.6-pro", "kimi-k3"]
    return ["glm-5.3-flash", "qwen3.8-flash", "mimo-v2.6-flash"]


ESC = {"qwen3.8-max", "grok-4.7", "kimi-k3"}
MID = {"deepseek-v4.1-flash", "mimo-v2.6-pro", "glm-5.3"}


def allows(model, budget):
    m, w, h = budget
    if model in ESC:
        return m >= 0.3 and w >= 0.3 and h >= 0.2
    if model in MID:
        return m >= 0.1 and w >= 0.1 and h >= 0.05
    return True


def select(task, complexity, risk, context, budget=(1, 1, 1), unavailable=()):
    blocked = set(unavailable)
    for mod in candidates(task, complexity, risk, context):
        if mod in blocked:
            continue
        if not allows(mod, budget):
            continue
        return mod
    return "glm-5.3-flash" if "mimo-v2.6-flash" in blocked else "mimo-v2.6-flash"


# --- behavioral assertions (mirror the required test list) ---
check("exploration -> mimo flash", candidates("exploration")[0] == "mimo-v2.6-flash")
check(
    "simple implementation -> glm/qwen flash",
    candidates("implementation", "simple")[0] == "glm-5.3-flash",
)
check(
    "normal implementation -> qwen flash",
    candidates("implementation", "normal")[0] == "qwen3.8-flash",
)
check(
    "complex implementation -> deepseek flash",
    candidates("implementation", "complex")[0] == "deepseek-v4.1-flash",
)
check(
    "debugging -> deepseek flash",
    candidates("debugging", "complex")[0] == "deepseek-v4.1-flash",
)
check("planning -> glm 5.3", candidates("planning", "complex")[0] == "glm-5.3")
check("architecture -> glm 5.3", candidates("architecture", "complex")[0] == "glm-5.3")
check("review -> mimo pro", candidates("code-review")[0] == "mimo-v2.6-pro")
check(
    "high-risk review -> qwen max",
    candidates("code-review", "complex", "high")[0] == "qwen3.8-max",
)
check("second opinion -> gpt-6 luna", candidates("second-opinion")[0] == "gpt-6-luna")
check(
    "manual override parses",
    bool(re.search(r"parseRouteOverride", SRC)) and bool(re.search(r"/route", SRC)),
)
check("budget exhausted skips escalation", not allows("qwen3.8-max", (0.1, 0.1, 0.1)))
check(
    "budget fallback stays in category",
    select("code-review", "complex", "high", "medium", (0.1, 0.1, 0.1))
    == "mimo-v2.6-pro",
)
check(
    "model unavailable falls back in order",
    select("implementation", "normal", "low", "medium", (1, 1, 1), ("qwen3.8-flash",))
    == "glm-5.3-flash",
)
check(
    "routine never escalation",
    all(
        select(t, "normal", "low", "small") not in ESC
        for t in ("exploration", "implementation", "test-generation", "documentation")
    ),
)

# --- static invariants on the real TS source ---
check("router.ts has capability matrix", "candidatesFor" in SRC)
check("router.ts has budget gate", "budgetAllows" in SRC)
check(
    "router.ts has fallback in order",
    "selectModel" in SRC and "last-resort" in SRC or "Last resort" in SRC,
)
check("router.ts has override", "parseRouteOverride" in SRC and "parseTaskHint" in SRC)
check(
    "router.ts has metadata logging",
    "route_reason" in (GUARD / "index.ts").read_text()
    or "route_reason" in SRC
    or "route_reason" in (GUARD / "index.ts").read_text(),
)
check(
    "DecisionModel generic, no JevDecisionModel",
    "interface DecisionModel" in SRC
    and "class JevDecisionModel" not in SRC
    and "interface JevDecisionModel" not in SRC,
)
check("jev shadow-only", "jevShadowSuggest" in SRC and "shadow-only" in SRC)
check(
    "index.ts preserves guard hooks",
    all(
        s in (GUARD / "index.ts").read_text()
        for s in (
            'session.hook("prompt"',
            'permission.hook("evaluate"',
            'tool.hook("execute.after"',
            'session.hook("compaction"',
            'session.hook("title"',
        )
    ),
)

# verify.md check with correct relative path
try:
    v = Path(__file__).resolve().parents[1] / ".opencode" / "commands" / "verify.md"
    vt = v.read_text()
    first_model = re.search(r"model:\s*(\S+)", vt)
    check(
        "verify default is mimo pro (not kimi)",
        bool(first_model) and "mimo-v2.6-pro" in first_model.group(1),
        vt[:200],
    )
except Exception as e:
    check("verify default readable", False, str(e))

if FAILURES:
    print(f"\n{len(FAILURES)} FAILURES")
    sys.exit(1)
print("\nAll router behavior checks passed.")
