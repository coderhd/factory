# Deployment and Environment Architecture

Factories are independently deployable and initially Docker-first. Software Factory retains its existing deployment baseline.

Root Runtime is separately deployable with an API boundary. Physical co-location is allowed initially; logical coupling is not.

Avoid Kubernetes, Redis, Postgres, S3/object storage, multi-tenancy and multiple deployment runtimes until justified.

Production-capable systems need persistent state, health checks, configuration validation, backups, secrets, TLS/authentication, logs and upgrade/rollback/restart recovery.

Staging exists to establish qualification evidence; production carries real consequences.
