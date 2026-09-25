# Implementation Roadmap

## Phase 0 — Architecture capture
Complete. Architecture, vocabulary, Protocol/Runtime split, Factory boundary, package strategy, Worker model, lifecycle and deployment relationship are frozen.

## Phase 1 — Software Factory v0.1
Implement the existing baseline: Factory Server, Client, CLI, Work Orders, planning/DAG, GitHub, SQLite, event log, Markdown/Git knowledge, routing, Worker abstraction, Herdr, demand-driven workers, worktrees, interactions, WAITING_INPUT, policy/risk, deterministic + semantic verification, Evidence Bundle, human gates, PR/merge, recovery, Observatory, Docker Compose, `factory.yaml`, backup/restore.

Do not turn this into a Root implementation.

## Phase 2 — Extract demonstrated common semantics
Identify genuine cross-Factory types and move them into `factory-core` without changing Factory behavior.

## Phase 3 — Quant Factory
Implement Quant as an independent product and prove its boundary with real research/backtest workloads.

## Phase 4 — Root Protocol
Implement only the interoperability needed for Software + Quant coordination, complementing existing standards.

## Phase 5 — Root Runtime
Build ecosystem governance only after multiple Factories create a real need.

## Phase 6 — Third-party Factory qualification
Support discover → register → compatibility check → qualify → authorize → activate.

## Deferred
Kubernetes, Redis, Postgres, S3, multi-tenancy, billing, multiple Git providers, multiple runtimes, universal workspace, SuperFactory, broad legal/finance verticals, advanced memory, advanced autoscaling and advanced semantic verification.
