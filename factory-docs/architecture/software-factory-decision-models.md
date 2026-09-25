# Software Factory — Decision Model and System 1 / System 2 Addendum

## Status

Architectural clarification for the existing Software Factory baseline.

The existing `2026-09-17-software-factory-design.md` remains authoritative.

## Decision Model

The Software Factory should expose an implementation-neutral Decision Model abstraction.

A Decision Model may be:

- deterministic rules
- statistical/ML model
- bounded System 1 model
- LLM/System 2 reasoning
- ensemble
- human decision process

The Factory remains authoritative over state transitions and execution.

## System 1 / System 2

### System 1

Fast, bounded decision-making is suitable for:

- classification
- routing
- ranking
- filtering
- risk classification
- model/worker selection
- bounded verification or gating support

### System 2

Reasoning-heavy mechanisms are suitable for:

- planning
- decomposition
- diagnosis
- complex synthesis
- solution generation
- interpreting ambiguous evidence

The split is a capability of the architecture, not a requirement that every task use both systems.

## Jev / System One

Jev/System One is one candidate implementation of the System 1 / Decision Model layer.

It should **not** become a hard dependency of the Software Factory MVP.

Use:

```text
DecisionModel
```

rather than:

```text
JevDecisionModel
```

The implementation can therefore be evaluated experimentally and replaced without changing Factory semantics.

## Routing topology

```text
Task
  ↓
Deterministic policy / capability constraints
  ↓
Candidate set
  ↓
DecisionModel
  ├── System 1 candidate
  ├── System 2 candidate
  ├── ensemble
  └── human
  ↓
Factory assignment decision
  ↓
Worker
```

## Authority invariant

```text
Decision Model ≠ Authority
Decision Model ≠ Policy
Decision Model ≠ Factory
```

A Decision Model can recommend, rank, classify, or score.

Policy determines what is permitted.

Authority determines what may be done.

The Factory commits durable state transitions.

## Verification

Semantic verification can use System 1 or System 2 mechanisms depending on the verification requirement.

The verifier remains subject to the Factory verification contract and must remain independent of the writer where required.

## MVP approach

Keep the interface implementation-neutral.

Evaluate Jev/System One experimentally for:

- routing
- bounded classification
- candidate ranking
- verification support

Adopt it as a default only after evidence from representative Work Orders.

This preserves the architectural direction without prematurely coupling the MVP to a particular decision technology.
