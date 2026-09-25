# Architecture Freeze

**Status: frozen. Implementation not yet started for Root.**

## Locked
- Factory independently deployable and standalone.
- Root is ecosystem governance/federation, not a super-factory.
- Root Protocol is independent from Root Runtime.
- Shared packages are independent from Root Runtime.
- Domain behavior remains inside the Factory that owns it.
- Worker is the generic execution boundary.
- Herdr is a Software Factory adapter, not a Root primitive.
- OpenCode/Codex/Claude Code/Pi are execution choices, not Root abstractions.
- Root owns cross-Factory state/governance; Factory owns domain state/governance.
- Third-party Factories may implement Root Protocol independently.
- Root Runtime is a separate deployable service/API boundary.
- Distributed infrastructure is deferred until justified.

## Product hierarchy
```text
Ecosystem
  Root
   Root Protocol
    Shared packages
      Software / Quant / Growth Factories
        Staging / Production
```

## Worker model
```text
Factory → Worker → Execution Runtime
Software: Worker → Herdr → OpenCode/Codex/Claude Code/Pi
Quant: Worker → research/compute runtime
Growth: Worker → browser/API/content runtime
```

## Lifecycle
```text
DISCOVERED → REGISTERED → COMPATIBILITY_CHECK → QUALIFYING → QUALIFIED → AUTHORIZED → ACTIVE → SUSPENDED/DEPRECATED/RETIRING → RETIRED
```

Qualified ≠ Authorized ≠ Active.
