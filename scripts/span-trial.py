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
        ranked = sorted(tdefs, key=lambda k: scored[k]["present"], reverse=True)
        task = ranked[0]
        conf = scored[task]["present"]
        margin = conf - scored[ranked[1]]["present"] if len(ranked) > 1 else 1.0
        cdefs = pack["complexity_definitions"]
        complexity = max(cdefs, key=lambda k: scored[k]["present"])
        risk = (
            "high" if scored["__risk__"]["present"] > pack["risk_threshold"] else "low"
        )
    except (KeyError, TypeError, AttributeError) as e:
        raise ValueError(f"malformed span response: {e}")
    return {
        "task": task,
        "complexity": complexity,
        "risk": risk,
        "confidence": round(conf, 4),
        "margin": round(margin, 4),
    }


def fixture_responder(pack):
    fixtures = json.loads(FIXTURES_PATH.read_text())
    n = len(fixtures)

    def respond(prompt, i=[0]):
        resp = fixtures[i[0] % n]
        i[0] += 1
        return resp

    return respond


class MissingKeyError(RuntimeError):
    """Raised when no API key is available; callers fall back to dry-run."""


OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions"


def _urllib_post(url, body, timeout_s):
    import urllib.request

    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {body.pop('_key')}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as r:
        return json.loads(r.read().decode())


def _normalize_live_payload(payload):
    """Convert a Decisions-API response to {"behaviors": {...}} for map_response.

    Accepts the documented answers shape ({answers: {route: {choice,
    probabilities, confidence}, complexity: {score, probabilities},
    risk: {noul}}}) plus the legacy behaviors shape. Score positions map to
    the nearest complexity level. Raises ValueError when nothing parses
    (recorded per case, never raised into the scorer).
    """
    if isinstance(payload, dict) and isinstance(payload.get("behaviors"), dict):
        return {"behaviors": payload["behaviors"]}
    try:
        answers = payload["answers"]
        out = {}
        for qid, ans in answers.items():
            p = ans.get("noul")
            if p is None:
                continue
            if qid.startswith("task_"):
                out[qid[5:]] = {"present": p, "absent": 1 - p, "not_observable": 0.0}
            elif qid.startswith("cx_"):
                out[qid[3:]] = {"present": p, "absent": 1 - p, "not_observable": 0.0}
            elif qid == "high_risk":
                out["__risk__"] = {"present": p, "absent": 1 - p, "not_observable": 0.0}
        if out:
            return {"behaviors": out}
        route = answers["route"]
        for task, p in route.get("probabilities", {}).items():
            out[task] = {"present": p, "absent": 1 - p, "not_observable": 0.0}
        cx = answers.get("complexity", {})
        for lvl, p in cx.get("probabilities", {}).items():
            out[lvl] = {"present": p, "absent": 1 - p, "not_observable": 0.0}
        if "score" in cx and not cx.get("probabilities"):
            levels = ["trivial", "simple", "normal", "complex"]
            idx = min(3, max(0, round(float(cx["score"]))))
            out[levels[idx]] = {"present": 1.0, "absent": 0.0, "not_observable": 0.0}
        if not out:
            out[route["choice"]] = {
                "present": route.get("confidence", 1.0),
                "absent": 0.0,
                "not_observable": 0.0,
            }
        risk = answers.get("risk", {})
        if "noul" in risk:
            out["__risk__"] = {
                "present": risk["noul"],
                "absent": 1 - risk["noul"],
                "not_observable": 0.0,
            }
        if out:
            return {"behaviors": out}
    except (KeyError, IndexError, TypeError, AttributeError, ValueError):
        pass
    keys = list(payload)[:5] if isinstance(payload, dict) else type(payload).__name__
    raise ValueError(f"unrecognized span payload: {keys}")


def build_span_request(pack, prompt, model):
    """One batched Decisions-API request, noul-only (Span-01 Lite constraint).

    The Lite tier rejects choice/score questions and non-string criteria,
    so each label becomes its own yes/no question; mapping back to a
    decision is argmax-over-present in map_response.
    """
    questions = {}
    for task, definition in pack["task_definitions"].items():
        questions[f"task_{task}"] = {
            "type": "noul",
            "instructions": f"Is this developer request a {task} task?",
            "criteria": {
                "true": definition,
                "false": f"This request is not a {task} task.",
            },
        }
    for level, definition in pack["complexity_definitions"].items():
        questions[f"cx_{level}"] = {
            "type": "noul",
            "instructions": "How complex is this developer request?",
            "criteria": {
                "true": definition,
                "false": "This does not describe the request complexity.",
            },
        }
    questions["high_risk"] = {
        "type": "noul",
        "instructions": "Does this developer request carry blast radius?",
        "criteria": {
            "true": pack["risk_definition"],
            "false": "This request is low-risk routine work.",
        },
    }
    return {"model": model, "questions": questions, "state": prompt}


def live_responder(
    pack,
    model="respan/span-01-lite",
    timeout_s=30,
    api_key=None,
    http=None,
    retries=3,
):
    import os
    import time as _time
    import urllib.error

    key = api_key if api_key is not None else os.environ.get("SPAN_API_KEY", "")
    if not key:
        raise MissingKeyError("set SPAN_API_KEY to an OpenRouter key for --live")
    post = http or _urllib_post

    def respond(prompt):
        t0 = time.monotonic()
        body = build_span_request(pack, prompt, model)
        body["_key"] = key
        try:
            last = None
            for attempt in range(retries):
                try:
                    payload = post(OPENROUTER_URL, body, timeout_s)
                    out = _normalize_live_payload(payload)
                    break
                except urllib.error.HTTPError as e:
                    last = e
                    if e.code and 500 <= e.code < 600 and attempt < retries - 1:
                        _time.sleep(2**attempt)
                        continue
                    raise
            else:
                raise last
        finally:
            body.pop("_key", None)
        out["_latency_ms"] = round((time.monotonic() - t0) * 1000, 1)
        return out

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
            err = f"parse: {e}"
        except Exception as e:
            predicted = {}
            err = f"transport: {type(e).__name__}: {str(e)[:120]}"
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


RULES_BASELINE = {"accuracy": 499 / 500, "negation_correct": False}


def log_verify_run(path=None, n=0, verdict="UNKNOWN", pack_version="v1"):
    """Append-only record of every verify-split scoring (leakage discipline)."""
    import datetime

    dest = Path(path) if path else ROOT / ".factory" / "span-trial.log"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest, "a") as f:
        f.write(
            f"{datetime.datetime.now(datetime.timezone.utc).isoformat()} "
            f"pack={pack_version} n={n} verdict={verdict}\n"
        )
    return str(dest)


def _pct(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


def score_report(results, baseline, pack=None):
    """Score a trial against the pre-registered promotion bar.

    Bar legs (spec section 7): (a) accuracy >= baseline AND adv-negation
    correct; (b) p95 latency <= 1000 ms on live timings; (c) cost/decision
    <= $0.001 (Lite is free, tallied $0). Dry-run (fixture) timings fail
    leg (b) by construction - promotion requires a live run.
    """
    pack = pack or load_pack()
    coarse = pack["coarse_map"]
    ok = [r for r in results if not r["error"]]
    fine = (
        (
            sum(
                1 for r in ok if r["predicted"].get("task") == r["expected"].get("task")
            )
            / len(ok)
        )
        if ok
        else 0.0
    )
    coarse_acc = (
        (
            sum(
                1
                for r in ok
                if coarse.get(r["predicted"].get("task"))
                == coarse.get(r["expected"].get("task"))
            )
            / len(ok)
        )
        if ok
        else 0.0
    )
    neg = next((r for r in ok if r["id"] == "adv-negation"), None)
    neg_ok = bool(
        neg
        and neg["predicted"].get("task") == "implementation"
        and neg["predicted"].get("risk") == "low"
    )
    lats = [r["latency_ms"] for r in ok]
    p95 = _pct(lats, 0.95)
    live = any(r["latency_ms"] > 5 for r in ok)
    legs = {
        "accuracy_ge_baseline": fine >= baseline["accuracy"],
        "negation_correct": neg_ok,
        "p95_within_budget": (p95 is not None and p95 <= 1000) if live else False,
        "cost_within_budget": True,
    }
    return {
        "n": len(results),
        "accuracy_fine": round(fine, 4),
        "accuracy_coarse": round(coarse_acc, 4),
        "negation_correct": neg_ok,
        "p50_ms": _pct(lats, 0.5),
        "p95_ms": p95,
        "est_cost_usd": 0.0,
        "legs": legs,
        "bar_verdict": "PASS" if all(legs.values()) else "FAIL",
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--split", default="all", choices=["train", "verify", "fresh", "all"]
    )
    ap.add_argument("--dry-run", action="store_true", default=True)
    ap.add_argument("--live", action="store_true", default=False)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv)
    pack = load_pack()
    cases = load_cases(args.split)
    if args.limit:
        cases = cases[: args.limit]
    if args.live:
        try:
            responder = live_responder(pack)
        except MissingKeyError as e:
            print(f"live unavailable: {e} (dry-run instead)")
            return 0
    else:
        responder = fixture_responder(pack)
    results = run_trial(cases, responder, pack)
    print(format_report(results))
    if args.live:
        rep = score_report(results, RULES_BASELINE, pack)
        print(
            f"accuracy_fine={rep['accuracy_fine']} "
            f"accuracy_coarse={rep['accuracy_coarse']} "
            f"negation={rep['negation_correct']} "
            f"p50={rep['p50_ms']}ms p95={rep['p95_ms']}ms "
            f"est_cost=${rep['est_cost_usd']}"
        )
        print(f"bar_verdict={rep['bar_verdict']} legs={rep['legs']}")
    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=1))
    if args.split == "verify" and not args.live:
        print("(dry-run verify: no log written; live verify runs are logged)")
    if args.split == "verify" and args.live:
        rep = score_report(results, RULES_BASELINE, pack)
        print(f"bar_verdict={rep['bar_verdict']} legs={rep['legs']}")
        log_verify_run(
            n=rep["n"],
            verdict=rep["bar_verdict"],
            pack_version=pack.get("version", "v1"),
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
