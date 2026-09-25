# Quant Factory Brainstorm — Continuation Point

## Status

This is a product-design and brainstorming capture, not a frozen Quant implementation specification.

The Quant Factory boundary is frozen separately. This document preserves the earlier Quant-system direction so the next Quant thread can continue without reconstructing the original discussion.

## Original product hypothesis

Quant Factory should make quantitative research and controlled strategy deployment increasingly autonomous while keeping evidence, validation, risk, authority, and human decision boundaries explicit.

The intended system is closer to:

```text
Research
  ↓
Hypothesis
  ↓
Experiment
  ↓
Backtest
  ↓
Out-of-sample validation
  ↓
Robustness testing
  ↓
Paper trading
  ↓
Promotion decision
  ↓
Controlled live execution
  ↓
Continuous evaluation
```

## Research loop

```text
Market / research objective
        ↓
Hypothesis generation
        ↓
Experiment design
        ↓
Data selection
        ↓
Backtest / simulation
        ↓
Evaluation
        ↓
Failure analysis
        ↓
Refinement / new hypothesis
        ↓
Independent validation
```

The Factory should preserve experiment provenance rather than allowing conclusions to exist only in model conversations.

## Strategy lifecycle

A conceptual lifecycle is:

```text
IDEA
  ↓
RESEARCH
  ↓
BACKTESTED
  ↓
OUT_OF_SAMPLE_VALIDATED
  ↓
ROBUSTNESS_TESTED
  ↓
PAPER_TRADING
  ↓
PROMOTION_REVIEW
  ↓
AUTHORIZED
  ↓
LIVE
  ↓
MONITORED
  ↓
SUSPENDED / RETIRED
```

The exact Quant state machine remains open.

## Validation philosophy

The system must distinguish:

- profitable historical simulation
- statistically credible strategy
- robust strategy
- paper-trading candidate
- strategy authorized for real capital

Important concerns include:

- overfitting
- multiple testing
- data leakage
- look-ahead bias
- survivorship bias
- transaction costs
- slippage
- liquidity
- execution assumptions
- parameter sensitivity
- regime changes
- out-of-sample performance
- walk-forward validation
- robustness across datasets and periods

These are Quant-domain concerns, not Root requirements.

## Evidence and reproducibility

Potential experiment evidence:

- dataset identity/version
- experiment configuration
- strategy version
- code version
- parameters
- random seeds
- feature definitions
- training configuration
- backtest results
- transaction costs
- slippage assumptions
- validation methodology
- risk measurements
- market regime/context
- model/version provenance
- decision provenance
- execution receipts

The final domain evidence schema belongs to Quant Factory.

## System 1 / System 2

### System 1

Fast, bounded mechanisms for:

- classification
- scoring
- ranking
- filtering
- anomaly detection
- experiment prioritization
- policy/risk classification
- candidate selection

### System 2

Reasoning-heavy mechanisms for:

- hypothesis generation
- research synthesis
- experiment design
- failure diagnosis
- interpreting conflicting evidence
- proposing new strategies
- designing validation plans

Possible topology:

```text
System 2
  ↓
Generate / refine candidate
  ↓
System 1
  ├── cheap filtering
  ├── classification
  ├── ranking
  └── prioritization
  ↓
Expensive experiment / backtest
  ↓
Evaluation
```

This is a Quant research direction, not a Root-mandated architecture.

## Jev / System One

Jev/System One is one candidate implementation of a **Decision Model**.

Potential uses:

- model selection
- worker routing
- experiment prioritization
- candidate strategy classification
- risk classification
- bounded scoring
- verification/gating support

The boundary remains:

```text
Decision Model
      ↓
recommendation / classification / score
      ↓
Policy + Authority
      ↓
Factory decision
      ↓
Operation
```

A Decision Model does not acquire authority merely because it produced a high-confidence result.

## Software Factory connection

The Software Factory already has the conceptual Decision Model boundary.

Its routing model is:

```text
Deterministic constraints
        ↓
Allowed candidate set
        ↓
Decision Model / ranking
        ↓
Factory assignment
```

Jev/System One can fit this slot, but it is **not locked as an MVP dependency**.

## Candidate Quant architecture

```text
Quant Factory
│
├── Research
│   ├── Hypothesis Generation
│   ├── Experiment Design
│   ├── Data
│   └── Research Knowledge
│
├── Decision Models
│   ├── System 1
│   └── System 2
│
├── Simulation
│   ├── Backtesting
│   ├── Cost Model
│   └── Execution Simulation
│
├── Validation
│   ├── OOS
│   ├── Walk-forward
│   ├── Robustness
│   └── Statistical Evaluation
│
├── Risk
├── Paper Trading
├── Live Execution
└── Evidence / Reconciliation
```

This is intentionally not a frozen module decomposition.

## Potential integrations

Potential tools/integrations discussed include:

- Qlib / quantitative research tooling
- research-agent tooling
- broker/execution APIs
- paper-trading environments
- Interactive Brokers
- Alpaca
- market-data providers

Choices remain open.

## Root boundary

Quant Factory should expose cross-Factory semantics such as:

```text
Identity
Capability
Authority
Policy
Resource
Work
Decision
Operation
Result
Evaluation
Evidence
Event
State
```

Root should not prescribe Quant's:

- strategy representation
- research workflow
- backtesting engine
- portfolio model
- market-data architecture
- research graph
- state machine
- broker

## Next Quant-thread questions

- Quant Factory MVP scope
- supported asset classes
- data architecture
- research environment
- experiment schema
- strategy representation
- backtesting engine
- statistical validation framework
- experiment scheduler
- System 1 candidates
- System 2 candidates
- Jev evaluation
- paper-trading architecture
- live execution boundaries
- capital/risk controls
- broker integrations
- promotion criteria
- continuous monitoring
- strategy retirement
- Quant Evidence Bundle
- product/economic model

## Key conclusion

Quant Factory is a real autonomous Factory, not a Software Factory with trading-specific Tasks.

Root provides the common ecosystem contract.

Quant Factory owns the intelligence and execution model.
