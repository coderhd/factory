#!/usr/bin/env python3
"""Span-01 Lite shadow trial harness (dry-run by default; live needs SPAN_API_KEY).

Scores Span against the eval corpora without touching live routing.
Usage:
  python3 scripts/span-trial.py --dry-run [--split train|verify|all] [--limit N]
  SPAN_API_KEY=... python3 scripts/span-trial.py --live [--split ...] [--limit N]
"""

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACK_PATH = ROOT / "scripts" / "span-trial-questions.json"
FIXTURES_PATH = ROOT / "scripts" / "span-trial-fixtures.json"


def load_pack(path=PACK_PATH):
    return json.loads(Path(path).read_text())


def load_cases(split="all"):
    cases = []
    for name in sorted(p.name for p in (ROOT / "scripts").glob("router-eval-*.json")):
        cases.extend(json.loads((ROOT / "scripts" / name).read_text()))
    if split != "all":
        cases = [c for c in cases if c.get("split", "train") == split]
    return cases


def map_response(pack, response):
    """Map a Span behavior-probability response to a predicted tuple.

    Expects response like {"behaviors": {def_id: {"present": p, ...}}}.
    Task = argmax present over task definitions; complexity = argmax over
    complexity definitions; risk = high iff risk definition present > threshold.
    Raises ValueError on malformed responses (caller records, never crashes).
    """
    try:
        scored = response["behaviors"]
        tdefs = pack["task_definitions"]
        task = max(tdefs, key=lambda k: scored[k]["present"])
        cdefs = pack["complexity_definitions"]
        complexity = max(cdefs, key=lambda k: scored[k]["present"])
        risk = (
            "high" if scored["__risk__"]["present"] > pack["risk_threshold"] else "low"
        )
    except (KeyError, TypeError, AttributeError) as e:
        raise ValueError(f"malformed span response: {e}")
    return {"task": task, "complexity": complexity, "risk": risk}


def fixture_responder(pack):
    fixtures = json.loads(FIXTURES_PATH.read_text())
    n = len(fixtures)

    def respond(prompt, i=[0]):
        resp = fixtures[i[0] % n]
        i[0] += 1
        return resp

    return respond


def run_trial(cases, responder, pack):
    results = []
    for case in cases:
        t0 = time.monotonic()
        try:
            predicted = map_response(pack, responder(case["prompt"]))
            err = None
        except ValueError as e:
            predicted = {}
            err = str(e)
        results.append(
            {
                "id": case["id"],
                "expected": case.get("expected", {}),
                "predicted": predicted,
                "latency_ms": round((time.monotonic() - t0) * 1000, 1),
                "error": err,
            }
        )
    return results


def format_report(results):
    ok = [r for r in results if not r["error"]]
    match = sum(
        1 for r in ok if r["predicted"].get("task") == r["expected"].get("task")
    )
    lines = [f"n={len(results)} scored={len(ok)} task_match={match}"]
    for r in results:
        if r["error"]:
            lines.append(f"ERROR {r['id']}: {r['error']}")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="all", choices=["train", "verify", "all"])
    ap.add_argument("--dry-run", action="store_true", default=True)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args(argv)
    pack = load_pack()
    cases = load_cases(args.split)
    if args.limit:
        cases = cases[: args.limit]
    results = run_trial(cases, fixture_responder(pack), pack)
    print(format_report(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
