# Factory Lifecycle and Qualification

```text
DISCOVERED → REGISTERED → COMPATIBILITY_CHECK → QUALIFYING → QUALIFIED → AUTHORIZED → ACTIVE → SUSPENDED / DEPRECATED / RETIRING → RETIRED
```

Qualification demonstrates suitability. Authorization delegates power. Activation permits operation in the relevant environment.

## Environments
**Staging** is the qualification environment. **Production** carries real authority, resources and Work. Production promotion is therefore a governed qualification transition, not merely deployment.

Factory identity is stable; releases are versioned; an environment points to a release. Root tracks this relationship but does not become the Factory deployment system.
