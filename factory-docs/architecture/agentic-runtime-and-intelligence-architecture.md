# Agentic Runtime and Intelligence Architecture

## Status
Additive implementation architecture for the frozen Software Factory design. It does not replace the existing Software Factory specification or Root architecture.

## Core split

```text
Factory Control Plane
        │
        ├── Intelligence Plane
        ├── Context / Knowledge Plane
        ├── Worker / Agent Runtime
        └── Verification / Evidence Plane
```

The Factory remains authoritative for Work Orders, Tasks, Attempts, state, scheduling, policy, authority, resources, interactions, verification, evidence, human gates, recovery, and durable events.

## Intelligence

```text
DecisionModel
├── deterministic rules
├── ML/statistical model
├── System 1 model
├── System 2 / LLM reasoning
├── ensemble
└── human
```

System 1 is for fast bounded decisions such as routing, classification, ranking, filtering, risk classification, and candidate selection.

System 2 is for reasoning-heavy work such as planning, decomposition, research, diagnosis, synthesis, and ambiguous evidence interpretation.

Jev/System One is one candidate System 1 implementation; it is not an architectural dependency.

## Graph Engineering

Graph-based execution is Factory-local.

The Software Factory can contain three distinct graph concepts:

### Work Graph
Task dependency graph.

### Control Graph
Durable lifecycle/state transitions.

### Intelligence Graph
Collaboration among planner, retriever, implementer, tests, verifier, and human nodes.

```text
Planner → Retriever → Implementer → Test → Verifier
                                      └→ failure/diagnosis → Implementer
```

These graphs must not collapse into one universal graph. The Control Graph remains authoritative for durable Factory state.

## Agent Runtime

Agents execute inside Workers.

```text
Factory → Worker → Agent Runtime → Model/Tools/Retrieval
```

The runtime may eventually use a lightweight custom loop, LangGraph, Google ADK, or another implementation. The framework remains replaceable and subordinate to the Factory.

## Tools / MCP

MCP may be used for tool/resource interoperability. Tool authorization remains governed by Factory Policy and Authority.

## Agent roles

Conceptual roles include Planner, Researcher, Implementer, Diagnostician, Synthesizer, Router, Classifier, Ranker, Risk Scorer, Candidate Selector, Verifier, and Evidence Curator.

These do not need to be separate long-lived agents; a role can be a model configuration, prompt, tool set, or runtime component.

## Writer / Verifier

Writer and semantic verifier remain separate roles. The verifier should receive fresh context and independent evidence.

## Invariant

**The Factory is the durable control plane. Agent frameworks are execution mechanisms.**
