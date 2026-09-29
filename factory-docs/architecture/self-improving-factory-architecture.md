# Self-Improving Factory Architecture

## Status
Additive architecture for controlled Factory evolution.

## Definition

Self-improvement means:

> The Factory can identify weaknesses, propose changes to itself, evaluate those changes against evidence, qualify the candidate, and promote or reject it under policy.

It does not inherently mean changing LLM weights.

## Four levels

### Level 1 — Runtime adaptation
Temporary adaptation inside an Attempt.

### Level 2 — Experience / memory improvement
Experience becomes future context without changing model weights.

### Level 3 — Scaffold improvement
The Factory improves prompts, skills, retrieval, context policies, routing, verifier rubrics, tool selection, or graph topology.

### Level 4 — Model improvement
Fine-tuning, adaptation, specialized training, or replacement of the model itself.

## Improvement is Work

```text
Improvement proposal
       ↓
Work Order
       ↓
implementation / experiment
       ↓
evaluation
       ↓
evidence
       ↓
qualification
       ↓
promotion decision
```

The Factory should never silently mutate production behavior.

## Candidate versions

Examples:

```text
Planner v2
Retriever v3
Skill pack v5
DecisionModel v4
Verification rubric v3
Agent graph v7
Model adapter v2
```

## Benchmarking

Compare baseline and candidate on representative workloads.

Measure:

- verified outcome
- failure rate
- human effort
- token cost
- latency
- resource usage
- verification quality
- policy violations
- recovery behavior

## Graph improvement

Graph topology itself may be an evaluated artifact.

```text
v1: Planner → Implementer → Verifier

v2: Planner → Researcher → Implementer → Test → Verifier
```

The Factory can benchmark candidate topologies and qualify the better one for appropriate workloads.

## Routing improvement

```text
Attempts
 ↓
Evaluation
 ↓
routing telemetry
 ↓
DecisionModel candidate
 ↓
Benchmark
 ↓
Qualification
 ↓
Promotion
```

## Model replacement

A new external model version is treated as another candidate and does not automatically receive production authority.

## Model-weight updates

Future Factory-managed training/adaptation can follow:

```text
experience/data
 ↓
training/adaptation
 ↓
candidate model
 ↓
qualification benchmark
 ↓
model registry
 ↓
promotion
```

This should follow, not precede, reliable evaluation and qualification infrastructure.

## No uncontrolled self-modification

The Factory must not allow an agent to modify production control logic, change policy to permit itself, grant itself authority, bypass verification, silently replace models, or erase negative evidence.

## Core principle

**Autonomy is delegated authority. Improvement is evaluated change.**

The ability to propose an improvement does not itself grant permission to deploy or operate it.
