# Factory Architecture — Skeptical Review

## Status

Architecture review checkpoint.

This document is an adversarial review of the frozen Root / Factory architecture and the additive agentic/context architecture.

It does not reopen the architectural decisions already frozen. It identifies where implementation should remain deliberately simple.

---

# 1. Core principle

## KISS — Keep It Simple, Stupid

> **The architecture may anticipate complexity; the implementation must earn it.**

A component should not be implemented merely because:

- it is fashionable,
- another platform uses it,
- it makes the architecture look more sophisticated,
- it may be useful someday,
- or the architecture already has a place for it.

The implementation should introduce complexity only when a real workload, measured failure, or customer requirement justifies it.

---

# 2. The architecture is broader than the MVP

The conceptual architecture currently includes:

- Prompt Engineering
- Context Engineering
- Loop Engineering
- Graph Engineering
- System 1
- System 2
- Decision Models
- RAG
- vector retrieval
- memory systems
- agent runtimes
- MCP
- self-improvement
- graph evolution

All are potentially useful.

None should automatically become MVP infrastructure.

---

# 3. Software Factory MVP

The simplest useful implementation remains approximately:

```text
User
  ↓
Work Order
  ↓
Factory Server
  ├── State
  ├── Policy
  ├── Planner
  ├── DecisionModel
  ├── Worker Manager
  ├── Verification
  └── Evidence
  ↓
Worker
  ↓
Herdr / Coding Harness
  ↓
Change Set
  ↓
Verification
  ↓
Evidence
  ↓
Human Gate
  ↓
PR
```

Initial persistence:

```text
SQLite
+
Git/worktrees
+
filesystem knowledge/artifacts
```

This is sufficient to prove the product thesis.

---

# 4. What should NOT be built merely because the architecture supports it

Do not introduce by default:

```text
Vector database
Graph database
Graph runtime
LangGraph
Google ADK
Mem0
OpenViking
MemPalace
Autonomous scaffold mutation
Model fine-tuning
Root Runtime
Kubernetes
Redis
Postgres
S3
Multi-tenancy
Multiple Git providers
Multiple deployment runtimes
```

These remain candidates.

The burden of proof is on the complexity.

---

# 5. Graph Engineering

Graph Engineering is a useful implementation concept, but the Factory does not need a generalized graph platform for MVP.

The Software Factory already has:

```text
Task dependency DAG
```

That is enough initially.

Do not build:

```text
Graph DB
+
Graph DSL
+
Graph execution engine
+
Graph optimizer
```

until a real workload demonstrates the need.

The Factory's durable state machine should remain ordinary application state.

Graph topology can later become an evaluated artifact if evidence shows that changing topology materially improves verified outcomes or human leverage.

---

# 6. Agent frameworks

The Factory should not become a LangGraph or Google ADK application merely because those frameworks provide agent orchestration capabilities.

Initial execution may simply be:

```text
Factory
  ↓
Worker
  ↓
Herdr
  ↓
coding harness
```

An explicit AgentRuntime abstraction should itself be introduced only when multiple execution runtimes create a concrete integration problem.

When needed, possible implementations include:

- lightweight custom loop
- LangGraph
- Google ADK
- another agent runtime

The framework remains subordinate to Factory control.

---

# 7. System 1 / System 2

Keep this distinction in the architecture.

Do not build two large platforms.

Use an implementation-neutral:

```text
DecisionModel
```

and allow it to represent:

```text
rules
ML/statistical model
System 1
System 2 / LLM
ensemble
human
```

Example:

```text
Task
  ↓
deterministic constraints
  ↓
candidate set
  ↓
DecisionModel
  ↓
Factory assignment
```

Jev/System One is a candidate implementation for bounded System 1 decisions.

It is not an MVP dependency.

---

# 8. Retrieval, vector search, and RAG

The primary system of record remains structured Factory state.

Use:

```text
Relational DB = authoritative state
Files/Git     = canonical knowledge where appropriate
Indexes       = derived retrieval representations
```

MVP can begin with simple lexical/structured retrieval.

Add embeddings when actual workloads show semantic retrieval is necessary.

Add hybrid retrieval when lexical + semantic retrieval materially improves results.

Add graph retrieval only when explicit relationship queries justify it.

---

# 9. Memory systems

OpenViking, Mem0, MemPalace, and similar systems are candidates for implementation experiments.

They should not define the architecture.

Use an interface conceptually equivalent to:

```text
Context / Memory Provider
```

and evaluate implementations against actual Factory workloads.

Memory is not:

- State
- Authority
- Policy
- Evidence

Those remain separately governed.

---

# 10. Context optimization

Context optimization is valuable, but it does not need to start as a separate service.

MVP can implement something as simple as:

```text
assembleContext(task, budget)
```

with straightforward rules:

- task context
- relevant repository material
- required skills
- selected knowledge
- selected previous evidence

Later improvements may add:

- semantic ranking
- reranking
- token budgeting
- deduplication
- caching
- System 1 selection
- learned context policy

The goal is:

> **Smallest useful, sufficiently complete context.**

A potential metric is:

> **Verified outcome per 1,000 context tokens.**

---

# 11. Self-improvement

Avoid the phrase "self-improving" without defining the level.

### Level 1 — Runtime adaptation

Temporary change inside an Attempt.

### Level 2 — Experience / memory improvement

Future runs benefit from accumulated experience.

### Level 3 — Scaffold improvement

Persistent changes to:

- prompts
- skills
- retrieval
- context policy
- routing
- verification rubrics
- tool selection
- graph topology

### Level 4 — Model improvement

- fine-tuning
- adaptation
- specialized training
- model replacement

Only Levels 1–2 are naturally compatible with the earliest MVP.

Persistent self-improvement should follow:

```text
Observe
  ↓
Propose
  ↓
Change
  ↓
Benchmark
  ↓
Qualify
  ↓
Promote / Reject
```

## Critical rule

> **Self-improvement is itself Work.**

The Factory should not silently modify production behavior.

---

# 12. Do not confuse a better external model with self-improvement

A new LLM released by a vendor is simply a new candidate model.

The Factory becomes self-improving when it can:

```text
evaluate candidate
      ↓
compare with baseline
      ↓
qualify
      ↓
authorize
      ↓
promote
```

Model-weight updates are optional future mechanisms, not the definition of self-improvement.

---

# 13. Root skepticism

Root Runtime should remain deferred.

The Root architecture is intentionally frozen conceptually, but implementation should wait until multiple real Factories create a real ecosystem-level problem.

Do not implement Root Runtime merely because:

```text
Software Factory exists
+
Quant Factory is planned
```

Implement the minimum Root capabilities needed when actual cross-Factory coordination exists.

---

# 14. Quant Factory skepticism

Quant Factory has accumulated many attractive ideas:

```text
research
AI agents
System 1
System 2
RAG
memory
backtesting
OOS validation
walk-forward
robustness
paper trading
live trading
risk
brokers
promotion
self-improvement
```

That is too large for an MVP.

The next Quant design pass should first prove a much smaller thesis:

```text
Hypothesis
  ↓
Experiment
  ↓
Backtest
  ↓
Independent Evaluation
  ↓
Evidence
```

Paper/live execution should come later unless the initial product hypothesis explicitly requires it.

---

# 15. The "boring by default" rule

For every subsystem, ask:

> **Can ordinary application code solve this today?**

Prefer:

| Problem | Default implementation |
|---|---|
| State | SQLite |
| Queue | In-process |
| Knowledge | Markdown/files |
| Retrieval | lexical/structured |
| Agent execution | existing harness |
| Routing | simple DecisionModel |
| Verification | tests + verifier |
| Memory | files/history |
| Graph | Task DAG |
| Communication | Factory API |
| Evidence | structured metadata + artifacts |
| Self-improvement | telemetry + Work Orders |

Introduce specialized infrastructure only after the simple approach fails.

---

# 16. Complexity test

Before adding a subsystem, answer:

1. What concrete problem does it solve?
2. What evidence shows the current approach fails?
3. Can the problem be solved more simply?
4. What operational burden does it introduce?
5. What is the rollback path?
6. How will we measure whether it helped?

If these cannot be answered, defer it.

---

# 17. What must NOT be simplified away

KISS does not mean removing the control boundaries that create the product's value.

Keep:

```text
Factory owns state
Policy constrains action
Authority delegates power
Worker executes
Verifier evaluates independently
Evidence records proof
Human controls consequential gates
```

These are not accidental complexity.

They are the foundation of the verification-first product.

---

# 18. Final skeptical assessment

| Area | Direction |
|---|---|
| Factory boundary | Keep |
| Root boundary | Keep |
| Verification/evidence | Keep |
| Policy/authority separation | Keep |
| System 1/System 2 concept | Keep |
| DecisionModel abstraction | Keep |
| Jev/System One | Candidate only |
| Graph Engineering | Conceptual / Factory-local |
| Agent framework | Candidate implementation |
| Vector DB | Deferred until proven |
| OpenViking / Mem0 / MemPalace | Evaluate behind interfaces |
| Context optimizer | Start as simple code |
| Self-improvement | Future governed capability |
| Model-weight updates | Much later |
| Root Runtime | Deferred |
| Quant MVP | Ruthlessly reduce |

## Final rule

> **Don't build a component because the architecture can accommodate it. Build it because the workload proves we need it.**

The implementation should move from:

```text
simple
  ↓
measure
  ↓
identify bottleneck
  ↓
add complexity
  ↓
measure again
```

not:

```text
complex architecture
  ↓
complex implementation
  ↓
hope it was necessary
```

This is the KISS guardrail for the Root / Factory ecosystem.
