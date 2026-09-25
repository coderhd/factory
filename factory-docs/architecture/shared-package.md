# Shared Package Architecture

Common semantics are shared without making every Factory dependent on Root Runtime.

## Initial repository strategy
Single monorepo/workspace initially, with independently versioned packages:
- `factory-core`
- `root-protocol`
- `factory-sdk`

## factory-core
Demonstrated cross-Factory semantic types such as identity, capability, authority, policy, resource, work, evidence, operation and event, plus validation/provenance utilities.

## root-protocol
Interoperability contracts and wire semantics. No Root Runtime implementation.

## factory-sdk
Optional clients/adapters/helpers. Protocol compatibility must not require this SDK.

## Extraction rule
Extract only demonstrated cross-Factory reuse or an explicit Root contract. Do not build a speculative universal abstraction.
