# Context, Memory, Retrieval and Token Optimization Architecture

## Status
Additive implementation architecture for the frozen Software Factory design.

## Four distinct concepts

### State
Authoritative current execution truth. Relational Factory state remains the system of record.

### Knowledge
Reusable organizational/domain information such as documentation, decisions, standards, and procedures.

### Memory
Prior experience that may improve future work, such as successful approaches, failures, and lessons.

### Evidence
Durable proof of what happened and what was evaluated.

Memory is not Evidence, and retrieval indexes are not State.

## Retrieval architecture

```text
Agent / Decision Model
        ↓
Retrieval Gateway
        ↓
Policy + scope filters
        ↓
candidate retrieval
 ├── lexical/exact
 ├── structured
 ├── vector
 └── optional graph
        ↓
reranking
        ↓
provenance + freshness
        ↓
Context Optimizer
        ↓
Model context
```

## Why hybrid retrieval

Lexical retrieval is strong for exact identifiers, filenames, symbols, versions, and error messages.

Vector retrieval is strong for semantic similarity and paraphrased concepts.

Structured filters are strong for scope, repository, project, time, environment, and policy.

Graph retrieval is useful for explicit relationships when a workload justifies it.

No single retrieval method should become universal.

## Canonical storage rule

```text
Canonical state/content
        ↓
Indexing
 ├── lexical
 ├── vector
 └── optional graph
```

Indexes are derived representations.

## Context Router

Determines which sources are worth considering using signals such as Task, repository scope, diff, risk, prior Attempts, required skills, model capability, and context budget.

## Context Optimizer

Selects what actually enters the prompt.

Conceptually:

```text
maximize expected decision usefulness
subject to:
  token budget
  latency budget
  policy/privacy
  freshness
```

Signals can include relevance, authority, confidence, recency, redundancy, expected utility, and token cost.

## Progressive disclosure

```text
L0 = summary/index
L1 = relevant details
L2 = source material
```

Agents can request deeper context when necessary.

## Memory lifecycle

```text
capture → evaluate → consolidate → retrieve → reinforce → decay/archive → retract
```

## Candidate implementations

Potential implementations include a native relational/files approach, vector databases, OpenViking, Mem0, MemPalace, and other context/memory systems.

These should sit behind Factory interfaces.

## Token optimization

Useful techniques include progressive disclosure, semantic chunking, deduplication, query-specific retrieval, reranking, relevance thresholds, caching, summaries/indexes, memory consolidation, explicit budgets, and avoiding duplicate metadata.

Optimization must not remove information required for safety, verification, policy, authority, or reproducibility.

## Context provenance

```text
ContextItem
├── source
├── type
├── relevance
├── confidence
├── freshness
├── token_cost
└── inclusion_reason
```

## Metric

A useful Factory metric is:

> **Verified outcome per 1,000 context tokens.**

## Invariant

**State remains authoritative and structured. Knowledge and memory may have multiple indexes. Retrieval is a capability; context is an optimized product assembled for the current decision.**
