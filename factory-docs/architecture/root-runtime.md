# Root Runtime

Root Runtime is the ecosystem governance substrate used when multiple autonomous Factories need coordinated governance. It is not required for a standalone Factory.

It is a separate deployable service/API boundary, though it may initially share physical infrastructure.

## Responsibilities
Identity, Factory Registry, lifecycle, qualification, ecosystem authority/policy, shared resource accounting, cross-Factory Operations, Decisions and Evidence, ecosystem Events, observability, audit, human control and ecosystem recovery/governance.

## Adoption
```text
Standalone Factory → Root Protocol → Root Runtime
```

Root Runtime must not become the hidden owner of Factory-local execution.
