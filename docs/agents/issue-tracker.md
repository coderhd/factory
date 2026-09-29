# Issue tracker

GitHub Issues in `coderhd/factory` + user Project `Factory Server v0.1` (private, #2). See `gh issue list --repo coderhd/factory`.

## Workflow

- Roadmap: issue #1 `[Roadmap] Factory Server v0.1`
- Epics: issues #2–#9 (E1,E3,E4,E2,E5,E7,E6,E8 in dependency order)
- Ticket body fields (Span-admission portable): `spec:`, `plan:`, `complexity:`, `model:`, `confidence:`, `disputed:`, `Blocked by:`, `What to build:`, `Acceptance:`
- Blocking: recorded in body `Blocked by:` (gh `--blocked-by` available for native edges on next pass)
- Project: `gh project item-list 2 --owner "@me"`; add via `gh issue create --project "Factory Server v0.1"` or `gh project item-add 2 --owner "@me" --url <issue-url>`
- Frontier (unblocked, start now): #2 E1 only; #3 E3 and #4 E4 unblock when #2 closes.

## Domain docs

Single-context. Spec: `factory-docs/2026-09-17-software-factory-design.md`. Deltas: `factory-docs/architecture/`, `factory-docs/decisions/adr-index.md`, `factory-docs/implementation/roadmap.md`, `factory-docs/architecture-skeptical-review.md`, `docs/superpowers/specs/2026-09-28-s1s2-routing-design.md`. Plan: `docs/superpowers/plans/2026-09-29-factory-server-v01.md`.
