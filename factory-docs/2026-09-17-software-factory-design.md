# Software Factory Design Specification

**Date:** 2026-09-17  
**Status:** Architecture approved; implementation not yet started  
**Primary product thesis:** Verification is the product.

---

## 1. Purpose

The Software Factory is a verification-first control plane for autonomous software delivery.

Its north star is:

> A small team can give the Factory a real software Work Order, walk away, and receive a verified Change Set + Evidence Bundle requiring materially less human effort than normal AI-assisted development.

The Factory is not primarily a coding-agent wrapper. Models, agent harnesses, orchestration techniques, memory systems, and individual coding tools are interchangeable infrastructure. The durable product value is the ability to turn autonomous execution into **verified, attributable, auditable software changes**.

Primary metric:

> **Verified throughput per human hour**

The system is designed first for small IT agencies with approximately 5–20 developers, where liability, billable hours, review capacity, and repeatable delivery create a clear economic incentive. Funded startups are a secondary segment. Solopreneurs are primarily a top-of-funnel/free segment.

---

# 2. Architectural Principles

1. **Verification IS the product.**
2. **Work Order is the central primitive**, not Agent, Task, Session, or Chat.
3. **Factory owns state transitions.**
4. **Workers execute; workers do not govern.**
5. **Planner proposes; Factory commits.**
6. **Writer ≠ Verifier ≠ Promoter.**
7. **No completion without durable completion evidence.**
8. **Human attention is spent at decision boundaries, not on watching agents.**
9. **Git/GitHub remains the source of truth for source code.**
10. **Factory remains the source of truth for execution state.**
11. **Knowledge and state are separate planes.**
12. **External information retrieval and external side effects are separate capabilities.**
13. **Isolation is mandatory at the Git worktree level.**
14. **Failures affect execution Attempts/capabilities before they affect durable Work.**
15. **Evidence survives retries, replans, failures, and restarts.**
16. **Autonomy is earned through evidence and policy, not assumed.**
17. **Architecture is empirically self-evaluating.**

---

# 3. ADR Summary

## ADR-001 — Verification is the Product

Models and orchestration commoditize. Trust-with-receipts is the intended moat.

Every completed Work Order should produce a durable Evidence Bundle mapping acceptance criteria to concrete evidence.

## ADR-002 — Sequence Personal Pipeline → Concierge → Product

Development sequence:

1. Run the user's own pipeline for approximately four weeks.
2. Operate a concierge model with 3–5 paying design partners at approximately $500–$1,500/month.
3. Productize only workflows that have been operated successfully by hand.

Do not build a universal workspace before the operational workflow is proven.

## ADR-003 — Initial Customer Segment

Primary:

- Small IT agencies
- Approximately 5–20 developers

Secondary:

- Funded startups

TOFU/free:

- Solopreneurs

The initial wedge is liability reduction and billable-hour leverage, not generic AI productivity.

## ADR-004 — Delegates With Receipts

Avoid framing agents as employees.

Agents are scoped delegates with:

- scoped keypairs/identity
- owner-signed authorizations
- explicit capabilities
- bounded accountability

Accountability terminates at humans.

Buzz's identity model may be used as a conceptual reference, but Buzz is not the system of record.

## ADR-005 — Configuration and Authorization

Configuration classes:

- policy
- preference
- grant

Semantics are monotonic/intersection-based.

Effective verification must be at least as strict as the organization-root floor.

Configuration resolution is explainable and performed at spawn/assignment. Agents receive only their effective slice.

## ADR-006 — Four-Tier Verification

Verification composes:

1. Deterministic
2. Behavioral
3. Semantic
4. Evidence & attestation

Deterministic checks include:

- typecheck
- lint
- tests
- build
- static/security/dependency checks

Behavioral checks include:

- Playwright
- visual checks
- API/contract tests
- database assertions
- E2E tests

Semantic checks include:

- independent LLM judge
- adversarial reviewer
- fresh context
- preferably a different model family
- Stryker/mutation testing where useful
- red-team verification where appropriate

Evidence & attestation maps:

- acceptance criteria
- proof
- gate results
- model/prompt provenance
- verification tier sign-off

**No self-merge. Writer ≠ sole verifier.**

## ADR-007 — Memory Files First

Initial knowledge system:

```text
wiki/index.md
wiki/log.md
entities/
concepts/
decisions/
AGENTS.md
```

Do not introduce qmd until knowledge exceeds approximately 100 pages.

OpenViking is internal-only unless licensing is reviewed.

Mem0/Graphiti are candidates behind an adapter if structured memory is later required.

Principle:

> Free to download ≠ free to deploy.

## ADR-008 — Communication Is Not the System of Record

Buzz is a communication reference only.

The Factory Server remains authoritative.

Hermes3D may be used as an optional visualization layer.

Work remains where work happens.

## ADR-009 — Vertical-First

The first product is focused on software engineering.

Legal/finance and other verticals are deferred.

## ADR-010 — Empirical Self-Evaluation

Every Factory run should produce telemetry sufficient to evaluate the Factory itself.

Architectural changes must eventually be benchmarked against representative Work Orders.

Optimization target:

> Verified outcomes and human leverage, not raw model activity.

---

# 4. Product Scope

## 4.1 MVP North Star

A real Work Order should be able to traverse:

```text
GitHub
  ↓
Work Order
  ↓
Planning / DAG
  ↓
Demand-driven Workers
  ↓
Execution / Interaction
  ↓
Verification
  ↓
Evidence Bundle
  ↓
Human Gate
  ↓
GitHub PR
  ↓
Merge
```

## 4.2 MVP External Integration

GitHub is the only external system in the MVP.

No:

- Slack
- Buzz
- Teams
- Jira
- GitLab
- Linear
- Kubernetes
- Postgres
- S3
- Redis
- multi-tenancy
- billing
- multiple Git providers
- multiple deployment runtimes

Those remain behind internal interfaces where appropriate.

---

# 5. Core Domain Model

## 5.1 Work Order

The Work Order is the central primitive.

It contains:

- Intent
- Acceptance Criteria
- Risk Tier
- Constraints
- Out of Scope
- Repository
- Branch/worktree policy
- Required verification

Lifecycle:

```text
DRAFT
  ↓
READY
  ↓
PLANNING
  ↓
EXECUTING
  ↕
WAITING_INPUT
  ↓
VERIFYING
  ↓
FAILED → REWORK
  ↓
EVIDENCE_READY
  ↓
HUMAN_GATE
  ├── REWORK
  ├── REJECTED
  └── APPROVED
          ↓
        MERGED
```

Agents can request WAITING_INPUT.

Agents cannot approve their own work.

The Factory owns the state machine.

## 5.2 Task

Tasks form a dependency DAG.

Task lifecycle:

```text
PLANNED
  ↓
READY
  ↓
ASSIGNED
  ↓
RUNNING
  ├── WAITING_INPUT
  └── SUCCESS
        ↓
     VERIFYING
        ├── VERIFIED
        └── FAILED
              ↓
            REWORK
              ↓
           RUNNING
```

Each execution is represented by a first-class Attempt.

## 5.3 Attempt

An Attempt records:

- model
- worker
- context
- skills
- task
- change/diff
- artifacts
- interactions
- verification results
- environment
- outcome
- failure/recovery history

Repeated failures are evidence for replanning or escalation.

## 5.4 Evidence Bundle

The Evidence Bundle is the receipt for a Change Set.

It is a curated projection of durable execution history, not a giant transcript.

It contains:

- acceptance criterion mapping
- concrete evidence
- verification results
- relevant logs/screenshots/traces
- model/model-version provenance
- skill provenance
- retrieval provenance
- policy decisions
- risk classification
- attempt/rework history
- execution environment
- human decision

---

# 6. Execution Architecture

```text
HUMAN
  ↓
Factory Client / Interaction adapters
  ↓
FACTORY API
  ↓
FACTORY SERVER
  ├── Work Orders
  ├── State & Scheduling
  ├── Model + Skill Routing
  ├── Policy + Risk
  ├── Interaction
  ├── Worker Manager
  ├── Retrieval Gateway
  ├── Verification
  ├── Evidence
  └── Events / Telemetry
  ↓
Herdr / Worker / Worker
  ↓
Git / Worktrees
  ↓
CI
  ↓
Verification
  ↓
Evidence Bundle
  ↓
Human Gate
  ↓
GitHub
```

The Factory Server is a single deployable service for MVP.

---

# 7. Planning and Scheduling

## 7.1 Planning

The LLM planner proposes a DAG.

The Factory validates and commits it.

Planner authority is therefore:

```text
LLM → proposal
Factory → state transition
```

DAG versions are preserved.

Example:

```text
DAG v1
   ↓
failure / missing information
   ↓
REPLAN
   ↓
DAG v2
```

Neither version is silently overwritten.

## 7.2 Scheduling

Independent tasks run concurrently.

Dependent tasks remain blocked.

MVP target:

- 2–3 concurrent workers

Scheduling is capacity- and policy-aware.

---

# 8. Model, Skill, and Worker Routing

Routing is:

> **Hybrid, policy-constrained, evidence-fed routing.**

Deterministic constraints define the allowed candidate set.

An LLM may rank candidates.

The Factory makes the actual assignment.

Routing factors include:

- task capability
- complexity
- risk
- repository policy
- model availability
- compatibility
- budget
- latency
- privacy/data requirements
- worker availability
- required skills
- model capacity/quota

Routing recommendations are recorded.

Factory state transitions authorize assignments.

Long-term routing should learn from verified outcomes.

---

# 9. Independent Development and Verification Models

The development/writer model and semantic verification model are separate roles.

Core invariant:

> The model/agent that generates a change must not be the sole authority that verifies that change.

Preferred semantic verification topology:

```text
Work Order
    ↓
Developer / Writer Model A
    ↓
Change Set
    ↓
Independent Verifier Model B
    ↓
Evidence Bundle
    ↓
Human Gate
```

The verifier should receive a fresh context containing:

- Work Order
- acceptance criteria
- repository/change set
- deterministic verification results
- relevant evidence
- verification rubric

It should not be anchored on the developer's reasoning transcript.

Preferred independence:

- different model instance
- preferably different model family
- independent prompt/context
- independent verification procedure

Different model family is a preference, not an absolute correctness guarantee. The stronger requirement is independent verification and independent evidence.

The Evidence Bundle records:

```text
generator provider/model/version
verifier provider/model/version
model_different
family_different
fresh_context
```

Deterministic verification remains foundational because it provides evidence that is not dependent on model agreement.

---

# 10. Context and Knowledge Plane

State and knowledge are separate.

```text
State Plane
  = execution truth

Knowledge Plane
  = reusable organizational knowledge
```

Context pipeline:

```text
Task
 ↓
Context Router
 ↓
Task context
Knowledge
Skills
History
 ↓
Context Assembler
 ↓
Worker Agent
```

Five context layers:

1. Task
2. Repository
3. Knowledge
4. Skills
5. History

Available context is not automatically injected context.

Progressive disclosure:

```text
L0 = summary
L1 = relevant details
L2 = source material
```

Optimize for **optimal context**, not minimum context.

Agents may request additional context through controlled Factory retrieval tools.

Knowledge write-back happens only through explicit rituals.

Agents may propose knowledge updates; canonical knowledge is updated only after evaluation.

---

# 11. External Retrieval Gateway

External information retrieval is distinct from external side effects.

```text
Agent
  ↓
retrieve()
  ↓
Factory Retrieval Gateway
  ↓
Policy
  ↓
Approved source/tool
  ↓
Result + provenance
```

Retrieval can access:

- official documentation
- package documentation
- current versions
- security advisories
- GitHub issues
- standards
- vendor documentation

Trust levels:

- T1: authoritative
- T2: strong secondary
- T3: community
- T4: untrusted

Trust affects what can safely be concluded.

High risk does not necessarily prohibit learning.

High risk primarily restricts what the agent can **do**.

External side effects require separate authorization.

Retrieval results include:

- source ID
- source type
- authority
- title
- locator
- retrieved timestamp
- relevant excerpt

Relevant retrieval evidence can enter the Evidence Bundle.

---

# 12. Interaction System

Interaction is a first-class control-flow primitive.

Types:

- QUESTION
- CONSULT
- APPROVAL
- INTERVENTION

An InteractionRequest includes:

- actor
- recipient
- type
- context
- question/proposal
- options
- required response
- deadline
- status
- response

Recipients can be:

- human
- agent
- knowledge
- Factory

Agent-to-agent communication goes through Factory Interaction rather than arbitrary direct messaging.

This provides provenance and policy control.

## Human Q&A

A worker can create:

```text
QUESTION
```

Factory persists it.

Task enters:

```text
WAITING_INPUT
```

The human answers asynchronously.

Factory resumes the task.

Q&A is distinct from an approval gate.

---

# 13. Risk and Policy

Risk Classification and Policy Enforcement are separate subsystems.

## 13.1 Risk Tiers

### Low

- autonomous execution
- deterministic verification
- automatic rework
- promotion according to policy

### Medium

- autonomous execution
- stronger verification
- semantic review where appropriate
- human approval before promotion

### High

- constrained execution
- approved capabilities/models
- mandatory semantic/security verification
- explicit human approval
- no automatic promotion

Everything starts at Yellow.

Green is earned after evidence.

Red never auto-promotes.

## 13.2 Policy

Policy hierarchy:

```text
Organization
    ↓
Project
    ↓
Work Order
    ↓
Task
    ↓
Effective Policy
```

More specific policy can narrow authority but cannot expand beyond its parent.

Policy dimensions:

- repository
- path/resource
- action
- data
- environment
- reversibility

Capabilities are explicit:

```text
repo.read
repo.write
branch.create
pr.create
ci.run
production.read
production.write
deploy.execute
secrets.read
```

Sensitive actions are checked at runtime.

Decision:

```text
ALLOW
DENY
REQUIRE_HUMAN
```

Policy decisions are durable events containing:

- task
- action
- risk
- decision
- rules
- policy version

MVP policy source of truth is versioned YAML.

Factory Client provides a UI/editor over the same configuration.

---

# 14. Verification Architecture

Verification is a separate subsystem from execution.

```text
Change Set
  ↓
Verification Engine
  ├── Deterministic
  ├── Behavioral
  └── Semantic
  ↓
Evidence Bundle
  ↓
Human Gate
```

## 14.1 Deterministic

Examples:

- typecheck
- lint
- unit tests
- integration tests
- build
- static analysis
- security checks
- dependency checks

## 14.2 Behavioral

Examples:

- Playwright
- API/contract checks
- visual checks
- database assertions
- E2E tests

## 14.3 Semantic

Examples:

- independent verifier
- adversarial reviewer
- fresh context
- preferably different model family
- mutation testing
- red-team review

Semantic verification must attempt to falsify acceptance criteria rather than merely confirm the developer's narrative.

## 14.4 Evidence

Each acceptance criterion maps to concrete evidence.

Agent self-assessment is advisory.

Authoritative verifier results are evidence.

Verification failure is structured with:

- category
- criterion
- verifier
- evidence
- diagnosis
- suggested action

The verifier never modifies implementation.

---

# 15. Worker Runtime

Herdr is the first worker adapter.

The Factory defines a small Worker API:

```text
provision
start
stop
pause
resume
status
execute
collect_artifacts
destroy
```

Future adapters:

- Local
- Docker
- Remote
- Kubernetes

Workers receive Factory-issued identity and scoped capabilities.

## Git Worktrees

Git worktrees are mandatory baseline isolation for implementation Tasks.

Each Task receives:

- isolated branch
- isolated worktree
- known base commit

Worktrees do not provide complete isolation of:

- ports
- databases
- credentials
- external services

Those are separately governed.

---

# 16. Worker Provisioning

Worker population is demand-driven.

Factory starts with zero workers.

Example:

```yaml
workers:
  provisioning:
    enabled: true
  capacity:
    min: 0
    max: 5
  idle_timeout: 10m
  default_profile: herdr
```

`max` is a capacity ceiling, not an initial worker count.

Idle workers may be reclaimed.

Worker Manager/Provisioner is a Factory-level service.

---

# 17. Worker Execution Envelope

Factory → Worker:

```text
work_order_id
task_id
attempt_id
repository
base_commit
branch
worktree
authorization capabilities
initial context
retrieval endpoint
skills
required verification
```

Worker → Factory:

```text
status
commits
artifacts
interactions
observations
verification requests
```

Environment information is captured for Evidence:

- OS
- runtime
- package manager
- worker runtime
- model
- model version
- skills
- Factory version

Workers are stateless from the Factory perspective.

Durable ownership:

```text
Factory → state
Git → code
Knowledge Plane → knowledge
Worker → execution environment
```

---

# 18. Failure Recovery and Operational Safety

## 18.1 Worker Failure

Worker/process failure interrupts the Attempt.

It does not automatically fail the Task.

Factory may:

- reconnect
- restart
- retry
- create a new Attempt
- reassign
- replan
- escalate

## 18.2 Recovery

Automatic recovery is bounded.

There is no blind universal retry.

Structured failure classification drives recovery.

Repeated failures become signals for replanning/escalation.

## 18.3 Factory Server Crash

On restart:

1. load durable state
2. load event history
3. identify RUNNING Attempts
4. reconcile worker leases
5. reconnect where valid
6. interrupt/recover where worker is gone
7. retry/replan/escalate according to policy

No execution is considered successful without completion evidence.

## 18.4 Worktree Recovery

Default:

> clean-worktree recovery

Failed Attempt diffs/state remain available as evidence/recovery artifacts.

New Attempt starts from a clean known baseline.

Future resume-from-worktree behavior may be added explicitly but is not the default.

## 18.5 Worker Liveness

Worker state:

```text
HEALTHY
  ↓
SUSPECT
  ↓
UNREACHABLE
```

Heartbeat loss enters a grace period.

Lease expiry triggers reconciliation/recovery.

Worker heartbeat is not equivalent to:

- agent progress
- task completion

## 18.6 Cancellation

Cancellation is a first-class state transition:

```text
RUNNING
  ↓
CANCELLING
  ↓
CANCELLED
```

Graceful cancellation is requested first.

Forceful termination is a recovery mechanism.

`CANCELLED`, `FAILED`, and `INTERRUPTED` remain distinct.

## 18.7 Idempotency

Every Attempt and consequential action receives a durable execution/idempotency identity.

Duplicate delivery must not create:

- duplicate Attempts
- unsafe duplicate actions

Arbitrary underlying actions are not magically idempotent.

Non-repeatable external side effects require explicit idempotency handling or human authorization.

## 18.8 Verification/Integration Failure

Preserve the Change Set.

Create a new Attempt for bounded rework.

Every verification run is immutable evidence.

Verifier never modifies implementation.

## 18.9 External Dependencies

Dependency states:

```text
AVAILABLE
  ↓
DEGRADED
  ↓
UNAVAILABLE
  ↓
RECOVERING
  ↓
AVAILABLE
```

Use bounded exponential backoff with jitter.

Persistent failures open a circuit.

Only operations requiring the dependency block.

## 18.10 Model Quota and Subscription Exhaustion

Treat provider quota exhaustion as resource capacity, not worker failure.

Classify:

- transient rate limit
- provider outage
- quota/subscription exhausted
- authentication failure
- unavailable model

Affected capacity becomes unavailable.

Alternative routing is allowed only when it satisfies the Work Order's policy and capability requirements.

The Attempt may enter:

```text
WAITING_RESOURCE
```

rather than FAILED.

Changing provider/model creates a new Attempt when appropriate.

No silent downgrade when a specific model class is required.

Relevant events include:

```text
MODEL_REQUEST
MODEL_RESPONSE
MODEL_RATE_LIMITED
MODEL_QUOTA_EXHAUSTED
MODEL_AUTH_FAILED
MODEL_UNAVAILABLE
```

## 18.11 Emergency Controls

Factory-level:

```text
pause
resume
emergency-stop
```

Emergency stop:

- blocks new assignments
- blocks new worker provisioning
- blocks external side effects
- requests graceful cancellation
- preserves state/evidence
- requires explicit human resume

It does not destroy state or blindly kill everything.

---

# 19. Persistence and Durability

MVP persistence is hybrid:

```text
SQLite
  = current authoritative Factory state

Append-only event log
  = immutable execution history

Filesystem/object artifacts
  = evidence and large artifacts

Git/GitHub
  = source code truth

Git/filesystem
  = Knowledge Plane
```

SQLite uses WAL mode.

Postgres is deferred.

Redis is deferred.

Interfaces should exist now:

```text
StateStore
KnowledgeStore
ArtifactStore
MessageBus / Queue
```

The MessageBus/Queue is initially in-process.

## Core entities

```text
work_orders
tasks
task_dependencies
attempts
workers
assignments
interactions
artifacts
verification_runs
evidence_bundles
policy_decisions
routing_decisions
events
```

Agent is not necessarily a durable top-level entity. Agent sessions belong to Attempts/Workers.

Persist control events always.

Persist execution telemetry selectively.

Large artifacts are stored separately.

---

# 20. Deployment and Self-Hosting

MVP deployment is Docker-first.

`factory.yaml` describes desired Factory deployment.

It is not equivalent to `compose.yaml`.

Deployment manager resolves the desired configuration into runtime configuration.

Docker Compose is the MVP runtime.

## Storage

MVP:

- SQLite persistent volume
- filesystem knowledge
- filesystem artifacts/evidence

Future:

- Postgres
- S3-compatible artifact storage

## Operator Interface

Canonical CLI:

```text
factory init
factory start
factory stop
factory status
factory update
factory backup
factory restore
```

## Production Requirements

- persistent volumes
- restart/health checks
- configuration validation
- backups
- secrets management
- TLS/auth boundary
- logs
- upgrade/rollback procedure

Production images use explicit versions/digests, not `latest`.

## Backup

Factory-level backup contains:

- Factory state
- evidence/artifacts
- knowledge
- configuration
- Factory version
- schema version
- timestamp
- metadata

Git remains source of truth for source code.

Target:

> restore the Factory onto a fresh machine.

## Upgrade

1. mandatory pre-upgrade backup
2. pull new image
3. stop/update
4. migrate schema
5. start
6. readiness checks
7. recover from backup if necessary

Arbitrary binary rollback is not promised.

---

# 21. Public Gateway

Gateway is deployment-specific.

```text
Local
  → no gateway

LAN/trusted
  → optional gateway

Internet-facing
  → TLS gateway expected/recommended
```

Possible technologies:

- Caddy
- Nginx
- future Kubernetes gateway

The gateway is not a Factory dependency.

Factory Server remains the application-level authorization authority.

---

# 22. Factory Client and Human UX

Primary rich client:

> **Tauri desktop application**

Additional clients:

- browser Web Client
- CLI

All clients use the same Factory API.

Clients never directly mutate Factory state.

Factory Server is the sole authority.

## MVP Surfaces

1. Work Orders
2. Run/Trace
3. Human Decisions
4. Observatory

Evidence is integrated into Work Order/Run views initially.

UX principle:

> Surface things requiring human attention; don't make humans watch agents.

Tauri may provide:

- native notifications
- tray
- filesystem integration
- SSH integration
- local connectivity helpers

Tauri does not embed/manage the Factory Server process.

Local Factory is Docker-first.

Connection profiles are identified by Factory Server URL.

Local standard endpoint may be auto-detected.

Handshake provides:

- instance identity
- version
- API version
- capabilities

Credentials are stored outside configuration where appropriate.

Network-wide service discovery is deferred.

---

# 23. Factory Observatory

Observability is a first-class Factory Client capability.

It is a projection of Factory telemetry, not a second source of truth.

Primary metrics:

- verified changes/day
- verified throughput per human hour

Secondary metrics:

- PRs/day
- commits/day
- lines changed
- cumulative verified output
- activity heatmap
- recent changes
- output by project
- output by task
- output by model
- output by worker
- human minutes
- first-pass verification
- rework
- interventions
- escaped defects
- model/tool cost
- verification bottleneck

The dashboard should resemble a software-shipping velocity dashboard but must not optimize for raw PR volume.

A “What landed” section is useful.

“By author” becomes:

- worker
- model
- configuration

with verified outcomes, human effort, and cost rather than raw output.

Drill-down:

```text
Work Order
  ↓
Task
  ↓
Attempt
  ↓
trace
  ↓
verification
  ↓
evidence
  ↓
human decision
```

---

# 24. Telemetry

Telemetry layers:

1. outcome
2. human leverage
3. execution
4. quality
5. economics
6. decision telemetry

Record:

- why a model was selected
- why a skill was selected
- what context was retrieved
- what risk was assigned
- what actions were allowed/denied
- when replanning occurred
- human gate decisions

Trace tree:

```text
Work Order
  ↓
Planning
  ↓
Task
  ↓
Attempt
  ├── model calls
  ├── retrieval
  ├── tool calls
  └── verification
  ↓
Integration
  ↓
Human Gate
```

MVP:

```text
Factory events
  ↓
SQLite
  +
structured logs
  +
minimal metrics
```

Future:

> OpenTelemetry-compatible export.

OpenTelemetry is a transport/data-model boundary, not the Factory domain model.

Factory-specific metrics remain custom semantic metrics.

---

# 25. Benchmarking

Production telemetry is distinct from the benchmark suite.

Benchmark corpus:

- 10–30 representative Lekhan Work Orders

The benchmark must remain distinct from Lekhan dogfooding.

Benchmark representative tasks should include:

- dependency edges
- acceptance criteria
- multiple technical domains
- real-world implementation complexity

Configurations should be compared on the same Work Orders.

Potential baselines:

- single strong agent
- existing human-assisted workflow
- HumanLayer-style workflow
- Machinist/Factory-style workflow
- Software Factory MVP

Metrics:

- verified outcome
- human effort
- wall time
- model/tool cost
- first-pass verification
- rework
- quality
- interventions

Do not optimize solely for public benchmark scores.

The Factory's own production outcomes matter more.

---

# 26. Dogfooding With Lekhan

Lekhan is the primary dogfooding environment.

It is not itself the benchmark.

Extract approximately 5–10 representative Work Orders from the Lekhan roadmap for future benchmark use.

Factory capability should be added when:

1. a real Lekhan Work Order exposes a limitation, or
2. the MVP specification requires it.

Avoid an infinite “build the factory to build Lekhan to build the factory” loop.

Micro-metrics:

- time to merged PR
- human minutes
- model cost
- rework
- verification failures
- questions
- interventions

Macro-metrics:

- percentage of backlog completed by Factory
- human hours saved
- PRs/week
- rework/regressions
- context recovery success
- concurrency
- uptime

---

# 27. End-to-End Acceptance Scenario

The first meaningful acceptance scenario uses a real GitHub-backed Work Order.

Example DAG:

```text
T1
├── T2
│   └── T4
└── T3
    └── T5
```

The scenario should exercise:

1. GitHub import/reconciliation
2. Work Order creation
3. planning
4. DAG validation
5. demand-driven worker provisioning
6. at least two independent concurrent Tasks
7. Git worktree isolation
8. agent execution
9. asynchronous human QUESTION / WAITING_INPUT
10. induced worker failure
11. bounded recovery
12. verification failure
13. rework
14. successful verification
15. Evidence Bundle generation
16. human gate
17. GitHub PR
18. merge
19. Observatory telemetry
20. restart/recovery behavior

Not every failure mode must be exercised in one ticket. The acceptance test should demonstrate the core assurance loop.

---

# 28. End-to-End Ownership Walkthrough

```text
GitHub
  ↓
GitHub Adapter
  ↓
Factory Server
  ↓
Work Order
  ↓
Planner
  ↓
Factory validates DAG
  ↓
Scheduler
  ↓
Worker Manager
  ↓
Herdr Worker
  ↓
Git Worktree
  ↓
Change Set
  ↓
Verification Engine
  ↓
Evidence Bundle
  ↓
Human Gate
  ↓
GitHub PR
  ↓
Merge
```

Ownership:

| Stage | Owner |
|---|---|
| Repository state | GitHub/Git |
| Work Order state | Factory Server |
| Planning proposal | Planner |
| DAG commitment | Factory Server |
| Assignment | Scheduler |
| Worker lifecycle | Worker Manager |
| Code generation | Worker/Developer Agent |
| Verification | Verification Engine |
| Evidence | Factory |
| Approval | Human |
| Repository merge | GitHub under Factory-authorized policy |
| Telemetry | Factory |

---

# 29. Critical Invariants

The architecture is considered internally coherent only while these invariants remain true:

1. Factory owns state transitions.
2. Workers execute; they do not govern.
3. Planner proposes; Factory commits.
4. Writer ≠ verifier ≠ promoter.
5. Developer model is not the sole semantic verifier.
6. Semantic verifier uses fresh context.
7. Different model family is preferred for semantic verification.
8. Deterministic verification remains foundational.
9. Failed Attempts do not automatically fail durable Work.
10. Completion requires durable evidence.
11. Human interaction is asynchronous control flow.
12. GitHub owns source code.
13. Factory owns execution state.
14. Knowledge is not execution state.
15. Retrieval is distinct from side effects.
16. Git worktree isolation is mandatory for implementation tasks.
17. External side effects are policy-controlled.
18. Evidence is immutable once produced.
19. Recovery is bounded and evidence-preserving.
20. No self-merge.
21. High-risk work never auto-promotes.
22. Red never auto-promotes.
23. Model substitution cannot silently violate explicit Work Order requirements.
24. The Factory cannot claim success when completion evidence is missing.

---

# 30. MVP Boundary

## Required

- Factory Server
- Factory Client
- CLI
- Work Orders
- GitHub integration
- persistent SQLite state
- append-only events
- Markdown/Git knowledge
- model routing
- skill routing
- worker abstraction
- Herdr adapter
- demand-driven worker provisioning
- 2–3 concurrent workers
- Git worktrees
- agent-agent interaction
- human WAITING_INPUT
- policy/risk enforcement
- deterministic verification
- semantic verification architecture
- Evidence Bundle
- human gates
- GitHub PR/merge
- basic recovery
- basic Observatory
- Docker Compose
- factory.yaml
- backup/restore

## Deferred

- Slack/Buzz/Teams
- Kubernetes
- Postgres
- S3
- Redis
- multi-tenancy
- billing
- multiple Git providers
- multiple deployment runtimes
- advanced semantic verification
- advanced autoscaling
- universal workspace
- SuperFactory
- broad legal/finance verticals
- advanced memory systems

---

# 31. Implementation Philosophy

Do not implement every abstraction implied by the architecture up front.

Interfaces should exist where they preserve a meaningful future boundary, particularly:

- StateStore
- KnowledgeStore
- ArtifactStore
- Worker
- RetrievalGateway
- ModelRouter
- SkillRouter
- WorkerRouter
- MessageBus/Queue
- GitHub adapter

MVP implementations should remain small.

Avoid:

- Kubernetes before distributed scale exists
- Redis before queue requirements exist
- Postgres before SQLite becomes limiting
- elaborate memory infrastructure before real retrieval needs appear
- multiple external connectors before the GitHub workflow works
- generalized multi-tenancy before customer demand exists

The architecture is deliberately broader than the first implementation.

---

# 32. Future Evolution

Potential future directions:

- Postgres + S3
- Redis-backed distributed queues
- multiple worker runtimes
- multiple Git providers
- richer semantic verification
- model-family diversity policies
- stronger adversarial verification
- OpenTelemetry export
- advanced autoscaling
- richer knowledge systems
- Slack/Buzz/Teams interaction adapters
- multi-tenancy
- billing
- SuperFactory
- additional vertical factories

These should be introduced only when empirical workload or customer requirements justify them.

---

# 33. Final Architectural Statement

The Software Factory is a control plane that turns autonomous software agents into accountable software delivery machinery.

The intended loop is:

```text
Intent
  ↓
Work Order
  ↓
Plan
  ↓
Policy
  ↓
Scoped Execution
  ↓
Change Set
  ↓
Independent Verification
  ↓
Evidence
  ↓
Human Decision
  ↓
Promotion
  ↓
Telemetry
  ↓
Learning
```

The key product promise is not:

> “Our agents write more code.”

It is:

> **“Our Factory can produce software changes with receipts, while reducing the amount of human attention required to safely ship them.”**

The architecture therefore treats execution capacity as replaceable and verification, evidence, policy, recovery, and human leverage as first-class product primitives.

---

# 34. Architecture Review Status

Sections 1–14 were reviewed through an end-to-end scenario covering:

- concurrency
- human Q&A
- worker failure
- bounded recovery
- dynamic replanning
- verification failure
- rework
- independent verification
- evidence
- human approval
- GitHub PR/merge
- telemetry
- server restart recovery

The architecture is ready for implementation planning.

**Implementation has not begun.**

The next artifact should be a detailed implementation plan derived from this specification, with explicit sequencing and verification checkpoints.
