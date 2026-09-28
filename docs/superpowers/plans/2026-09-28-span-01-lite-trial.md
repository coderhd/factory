# Span-01 Lite Shadow Trial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dry-runnable shadow-trial harness that scores Span-01 Lite against the rules baseline on the eval corpus without touching live routing.

**Architecture:** One Span call per prompt (16-way Choice + 4-level complexity Score + risk Noul, batched), mapped back to our task taxonomy by a versioned question pack; scoring reuses the 80/20 split discipline with a pre-registered promotion bar.

**Tech Stack:** Python 3 stdlib only (`urllib`, no new deps), OpenRouter `respan/span-01-lite`, existing eval JSON corpora.

**Spec:** `docs/superpowers/specs/2026-09-28-s1s2-routing-design.md` (§7 challenger bench & promotion protocol)

## Global Constraints

- `DecisionModel` stays generic; no new decision-model types in live code paths.
- Span-01 Lite stays shadow-only; rules remain the live path regardless of trial outcome.
- No credentials in the repo; live leg reads `SPAN_API_KEY` (OpenRouter key) from env, human-provisioned.
- Dry-run is the default; live network calls never run in CI gates.
- Do not modify live routing files (`router.ts`, `index.ts`) in this plan.
- Python stdlib only; follow the existing `scripts/test-router-eval.py` mirror-and-gate pattern.

## Review Focus

- 16-way criteria text exceeding Lite's 4K context — expect the pack-size test to pin total prompt bytes under budget.
- Malformed or partial Span responses (missing answers, wrong keys) — expect parsed-or-skipped with per-case error records, never a crash.
- Missing API key — expect dry-run fallback with a clear message, never a stack trace in the gate.
- Verify-set leakage from criteria tuning — expect the verify-run logger to record every verify scoring with timestamp.
- Mapping drift between the question pack and the scorer — expect the mapping table to live in one JSON file both use.

---

## File Structure

- `scripts/span-trial-questions.json` — versioned question pack: coarse/fine Choice criteria text, complexity Score levels, risk Noul wording, and the fine→coarse + score→complexity + noul→risk mapping tables. Single source of truth for pack and scorer.
- `scripts/span-trial.py` — CLI harness: `--split train|verify|all`, `--dry-run` (default), `--live`, `--limit N`; corpus loader, OpenRouter client, scorer, report printer, verify-run logger.
- `scripts/span-trial-fixtures.json` — 3 canned Span responses exercising parsing, mapping, and one malformed response.
- `scripts/test-span-trial.py` — deterministic unit tests (mapping, report math, dry-run path); no network.
- Modify: `scripts/check-router.sh` — append dry-run trial gate line.
- Logs (gitignored runtime output): `.factory/span-trial.log` (verify-run records only).

## Task 1: Question pack + mapping tables

**Files:**
- Create: `scripts/span-trial-questions.json`
- Test: `scripts/test-span-trial.py` (mapping tests only; harness stubbed in Task 2)

**Interfaces:**
- Consumes: 16 task names from `router.ts` `TaskType`; train/verify corpus shape `{id, prompt, expected{task,complexity,risk,context}}`.
- Produces: `load_pack(path) -> dict` with keys `choice_criteria` (16 entries), `coarse_map` (16 task -> 5 families: build/investigate/decide/review/consult), `complexity_levels` (4 strings), `risk_question` (string), `version` (string like `"v1"`); consumed by Tasks 2–4.

- [ ] **Step 1: Write the failing test**

```python
def test_coarse_map_covers_all_tasks():
    pack = load_pack("scripts/span-trial-questions.json")
    assert set(pack["coarse_map"]) == set(ALL_16_TASKS)
    assert set(pack["coarse_map"].values()) <= {"build", "investigate", "decide", "review", "consult"}
```

```python
def test_pack_prompt_budget():
    pack = load_pack("scripts/span-trial-questions.json")
    assert prompt_bytes(pack) < 12_000  # headroom under Lite 4K-token context
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 scripts/test-span-trial.py`
Expected: FAIL with `ModuleNotFoundError` (no harness yet) or missing file.

- [ ] **Step 3: Implement `load_pack` + write `span-trial-questions.json` v1**

Criteria text per task in plain task language (e.g. debugging: "something is broken, failing, or crashing and needs diagnosis and repair"). Complexity levels: `["trivial tweak", "straightforward change", "standard task", "complex or ambiguous work"]`. Risk noul: `"this task carries production, security, billing, or data-loss blast radius"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 scripts/test-span-trial.py`
Expected: PASS (mapping + budget tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/span-trial-questions.json scripts/test-span-trial.py
git commit -m "feat: add span trial question pack v1 with mapping tests"
```

## Task 2: Harness skeleton with dry-run path

**Files:**
- Create: `scripts/span-trial.py`
- Create: `scripts/span-trial-fixtures.json`
- Test: `scripts/test-span-trial.py` (dry-run tests)

**Interfaces:**
- Consumes: `load_pack` from Task 1; corpus JSONs (same loader shape as `test-router-eval.py`, honoring `--split` and `known-limitation` neutrality).
- Produces: `run_trial(cases, responder) -> list[CaseResult]` where `responder(prompt) -> span_response_dict`; `format_report(results) -> str`; consumed by Tasks 3–4. `CaseResult = {id, expected, predicted{task,complexity,risk}, latency_ms, error?}`.

- [ ] **Step 1: Write the failing test**

```python
def test_dry_run_scores_fixture_corpus():
    results = run_trial(load_cases("train")[:3], responder=fixture_responder)
    assert len(results) == 3
    assert all("predicted" in r for r in results)
```

```python
def test_malformed_fixture_records_error_not_crash():
    results = run_trial([MALFORMED_CASE], responder=fixture_responder)
    assert results[0]["error"] is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 scripts/test-span-trial.py`
Expected: FAIL with `ModuleNotFoundError: scripts/span-trial.py` (import by path).

- [ ] **Step 3: Implement `scripts/span-trial.py` CLI skeleton**

`--split train|verify|all` (default `all`), `--dry-run` (default on), `--limit N`, fixture responder reading `scripts/span-trial-fixtures.json` (2 valid + 1 malformed response). No network code in this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 scripts/test-span-trial.py && python3 scripts/span-trial.py --dry-run --limit 3`
Expected: PASS; trial prints a 3-case report.

- [ ] **Step 5: Commit**

```bash
git add scripts/span-trial.py scripts/span-trial-fixtures.json scripts/test-span-trial.py
git commit -m "feat: add span trial harness skeleton with dry-run path"
```

## Task 3: Live OpenRouter client

**Files:**
- Modify: `scripts/span-trial.py` (add live responder)
- Test: `scripts/test-span-trial.py` (stubbed-HTTP tests)

**Interfaces:**
- Consumes: `run_trial(cases, responder)` from Task 2.
- Produces: `live_responder(pack, model="respan/span-01-lite", timeout_s=30)` honoring `SPAN_API_KEY`; raises `MissingKeyError` when unset; returns per-call `latency_ms`. Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

```python
def test_missing_key_raises_not_crashes():
    with pytest_raises(MissingKeyError):
        live_responder(PACK)(PROMPT)
```

```python
def test_live_responder_parses_stubbed_http():
    resp = live_responder(PACK, http=stub_ok)(PROMPT)
    assert resp["answers"]["route"]["choice"] in ALL_16_TASKS
```

(Implement `http` as an injectable callable defaulting to `urllib`; no test may touch the network.)

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 scripts/test-span-trial.py`
Expected: FAIL with missing names (`live_responder`, `MissingKeyError`).

- [ ] **Step 3: Implement `live_responder` + `MissingKeyError` in `scripts/span-trial.py`**

POST OpenRouter chat-compatible endpoint for `respan/span-01-lite` with one batched request (Choice + Score + Noul), 30 s timeout, per-call latency timing, HTTP errors mapped to per-case `error` records (never raised into the scorer).

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 scripts/test-span-trial.py`
Expected: PASS; and `SPAN_API_KEY= python3 scripts/span-trial.py --live --limit 1` prints the missing-key message with exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/span-trial.py scripts/test-span-trial.py
git commit -m "feat: add live openrouter responder with missing-key guard"
```

## Task 4: Scoring, report, and promotion-bar check

**Files:**
- Modify: `scripts/span-trial.py` (add `score_report`)
- Test: `scripts/test-span-trial.py` (scoring tests)

**Interfaces:**
- Consumes: `CaseResult` list from Task 2; pack `version` from Task 1.
- Produces: `score_report(results, baseline) -> dict` with keys `n, accuracy_fine, accuracy_coarse, negation_correct (bool), p50_ms, p95_ms, est_cost_usd, bar_verdict (PASS/FAIL with per-leg results)`; printed report consumed by humans/CI logs.

- [ ] **Step 1: Write the failing test**

```python
def test_report_computes_bar_legs():
    rep = score_report(FIXTURE_RESULTS, BASELINE_86_87)
    assert set(rep) >= {"accuracy_fine", "negation_correct", "p95_ms", "est_cost_usd", "bar_verdict"}
    assert rep["bar_verdict"] in ("PASS", "FAIL")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 scripts/test-span-trial.py`
Expected: FAIL with missing `score_report`.

- [ ] **Step 3: Implement `score_report` in `scripts/span-trial.py`**

Bar legs from the spec: (a) verify accuracy ≥ rules baseline AND `adv-negation` correct; (b) p95 ≤ 1000 ms; (c) cost/decision ≤ $0.001 (Lite free → tally $0 and note it). Coarse accuracy reported alongside fine for the hierarchy-fallback analysis.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 scripts/test-span-trial.py && python3 scripts/span-trial.py --dry-run`
Expected: PASS; dry-run report prints all legs (latency/cost legs marked N/A in dry-run).

- [ ] **Step 5: Commit**

```bash
git add scripts/span-trial.py scripts/test-span-trial.py
git commit -m "feat: add trial scoring with pre-registered promotion bar"
```

## Task 5: Verify-run discipline, gate wiring, close-out

**Files:**
- Modify: `scripts/span-trial.py` (verify-run logger), `scripts/check-router.sh` (append dry-run gate)
- Test: `scripts/test-span-trial.py` (logger test)

**Interfaces:**
- Consumes: everything above.
- Produces: `.factory/span-trial.log` append-only records; extended gate. No downstream consumers.

- [ ] **Step 1: Write the failing test**

```python
def test_verify_run_is_logged(tmp_path):
    log_verify_run(path=tmp_path / "span-trial.log", n=16, verdict="FAIL")
    assert "verdict=FAIL" in (tmp_path / "span-trial.log").read_text()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 scripts/test-span-trial.py`
Expected: FAIL with missing `log_verify_run`.

- [ ] **Step 3: Implement `log_verify_run` + gate line**

`--split verify` appends `{timestamp, pack_version, n, verdict}` to `.factory/span-trial.log` (gitignored runtime output). Append to `scripts/check-router.sh`: `python3 scripts/span-trial.py --dry-run --limit 3` after the eval gate — dry-run only, never live.

- [ ] **Step 4: Run full gate to verify it passes**

Run: `sh scripts/check-router.sh && bun test ./.opencode/plugins/factory-guard/router.test.ts`
Expected: exit 0, trial dry-run line present, 22/22 bun tests pass, eval still 86/87.

- [ ] **Step 5: Commit**

```bash
git add scripts/span-trial.py scripts/test-span-trial.py scripts/check-router.sh
git commit -m "feat: wire span trial dry-run into router gate with verify logging"
```

## Self-Review

1. **Spec coverage:** §7 challenger bench → Tasks 1–5 (pack, harness, live client, bar scoring, discipline/logging). §2 constraints (generic DecisionModel, shadow-only, no creds, stdlib, no live-file edits) → Global Constraints + Task scoping (no task touches `router.ts`/`index.ts`). Promotion bar (§7) → Task 4 legs verbatim. Dry-run-without-credentials (§10) → Tasks 2–3 + gate. Admission/pinning/verification sections (§4–6) intentionally untouched — trial-only plan, no transcript gap.
2. **Step scan:** each test step names assertions with exact values; each code step gives file + signature + spec-pinned values; bodies appear only where signatures underdetermine (OpenRouter POST shape, report math) — kept to one line of approach, no transcripts.
3. **Type consistency:** `load_pack`, `run_trial`, `CaseResult`, `live_responder`, `MissingKeyError`, `score_report`, `log_verify_run` named identically across tasks; `CaseResult` fields fixed once in Task 2.
4. **Review Focus:** all five lines pinned — pack budget (Task 1 test), malformed responses (Task 2 test), missing key (Task 3 test), verify leakage (Task 5 test + logger), mapping drift (single JSON source, Task 1 test).
5. **Proportion:** plan shorter than spec; code blocks are test assertions and shell commands only, no implementation bodies.
