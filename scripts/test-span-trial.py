#!/usr/bin/env python3
"""Deterministic tests for the Span-01 Lite shadow trial (no network).

Covers Task 1 (question pack) now; Tasks 2-4 append harness tests here.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "scripts" / "span-trial-questions.json"


def load_harness():
    """Import hyphenated scripts/span-trial.py without adding deps."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "span_trial", str(ROOT / "scripts" / "span-trial.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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


def test_dry_run_scores_fixture_corpus():
    mod = load_harness()
    pack = json.loads(PACK.read_text())
    cases = mod.load_cases("train")[:3]
    results = mod.run_trial(cases, mod.fixture_responder(pack), pack)
    check("dry run scores 3 cases", len(results) == 3, f"got={len(results)}")
    check("results carry predictions", all("predicted" in r for r in results))


def test_malformed_fixture_records_error_not_crash():
    mod = load_harness()
    pack = json.loads(PACK.read_text())
    results = mod.run_trial(
        [{"id": "bad", "prompt": "x", "expected": {}}],
        lambda prompt: {"nonsense": True},
        pack,
    )
    check("malformed response records error", results[0].get("error") is not None)


def _stub_http_ok(url, body, timeout_s):
    assert body["model"] == "respan/span-01-lite", body.get("model")
    qs = body["questions"]
    assert all(q["type"] == "noul" for q in qs.values()), "Lite: noul-only"
    assert all(
        isinstance(q["instructions"], str) and isinstance(q["criteria"], str)
        for q in qs.values()
    ), "Lite: string instructions+criteria"
    assert body["state"] == "x"
    return {
        "answers": {
            "task_exploration": {"type": "noul", "noul": 0.9},
            "task_implementation": {"type": "noul", "noul": 0.1},
            "cx_normal": {"type": "noul", "noul": 0.85},
            "high_risk": {"type": "noul", "noul": 0.1},
        }
    }


def test_missing_key_raises_not_crashes():
    mod = load_harness()
    pack = json.loads(PACK.read_text())
    try:
        mod.live_responder(pack, api_key="")
        check("missing key raises MissingKeyError", False, "no exception raised")
    except Exception as e:
        check(
            "missing key raises MissingKeyError",
            type(e).__name__ == "MissingKeyError",
            type(e).__name__,
        )


def test_live_responder_parses_stubbed_http():
    mod = load_harness()
    pack = json.loads(PACK.read_text())
    resp = mod.live_responder(pack, api_key="test", http=_stub_http_ok)("x")
    check(
        "stubbed live response parses",
        "behaviors" in resp or "exploration" in resp,
        str(resp)[:120],
    )


def test_report_computes_bar_legs():
    mod = load_harness()
    rep = mod.score_report([], {"accuracy": 0.998, "negation_correct": False})
    check(
        "report has all bar legs",
        set(rep)
        >= {
            "accuracy_fine",
            "negation_correct",
            "p95_ms",
            "est_cost_usd",
            "bar_verdict",
        },
        str(sorted(rep)),
    )
    check("bar verdict binary", rep["bar_verdict"] in ("PASS", "FAIL"))


def test_verify_run_is_logged():
    import tempfile

    mod = load_harness()
    with tempfile.TemporaryDirectory() as d:
        p = str(Path(d) / "span-trial.log")
        mod.log_verify_run(path=p, n=16, verdict="FAIL")
        check("verify run logged with verdict", "verdict=FAIL" in Path(p).read_text())


if __name__ == "__main__":
    pack = test_pack_exists_and_versioned()
    test_coarse_map_covers_all_tasks(pack)
    test_task_definitions_complete(pack)
    test_pack_prompt_budget(pack)
    test_selection_rules_pinned(pack)
    test_dry_run_scores_fixture_corpus()
    test_malformed_fixture_records_error_not_crash()
    test_missing_key_raises_not_crashes()
    test_live_responder_parses_stubbed_http()
    test_report_computes_bar_legs()
    test_verify_run_is_logged()
    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURES")
        sys.exit(1)
    print("\nAll span trial pack tests pass.")
