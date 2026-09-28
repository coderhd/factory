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


class MissingKeyError(RuntimeError):
    """Raised when no API key is available; callers fall back to dry-run."""


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


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
    """Accept likely Span-on-OpenRouter shapes; return {"behaviors": {...}}.

    Tries top-level behaviors, then JSON embedded in a chat message.
    Raises ValueError when nothing parses (recorded per case, never raised
    into the scorer beyond the error record).
    """
    if isinstance(payload, dict) and isinstance(payload.get("behaviors"), dict):
        return {"behaviors": payload["behaviors"]}
    try:
        content = payload["choices"][0]["message"]["content"]
        parsed = json.loads(content) if isinstance(content, str) else content
        if isinstance(parsed, dict) and isinstance(parsed.get("behaviors"), dict):
            return {"behaviors": parsed["behaviors"]}
    except (KeyError, IndexError, TypeError, ValueError):
        pass
    raise ValueError(f"unrecognized span payload keys: {list(payload)[:5]}")


def build_span_request(pack, prompt, model):
    defs = [f"- {k}: {v}" for k, v in pack["task_definitions"].items()]
    defs += [
        f"- complexity:{k}: {v}" for k, v in pack["complexity_definitions"].items()
    ]
    defs += [f"- high_risk: {pack['risk_definition']}"]
    return {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": (
                    "Developer request to classify:\n"
                    + prompt
                    + "\n\nScore each definition (present/absent/not_observable) "
                    'and return JSON {"behaviors": {id: {present, absent, '
                    "not_observable}}}.\nDefinitions:\n" + "\n".join(defs)
                ),
            }
        ],
    }


def live_responder(
    pack, model="respan/span-01-lite", timeout_s=30, api_key=None, http=None
):
    import os

    key = api_key if api_key is not None else os.environ.get("SPAN_API_KEY", "")
    if not key:
        raise MissingKeyError("set SPAN_API_KEY to an OpenRouter key for --live")
    post = http or _urllib_post

    def respond(prompt):
        t0 = time.monotonic()
        body = build_span_request(pack, prompt, model)
        body["_key"] = key
        try:
            payload = post(OPENROUTER_URL, body, timeout_s)
            out = _normalize_live_payload(payload)
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
    ap.add_argument("--live", action="store_true", default=False)
    ap.add_argument("--limit", type=int, default=0)
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
