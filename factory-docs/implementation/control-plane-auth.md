# Control-plane API authentication (E10.4, GitHub #40)

Config: `factory.yaml` `server.auth: { token: <secret>, actor: <operator> }` (validated; minimum-entropy token, fail-closed — a non-loopback `server.hostname` is refused without it).

## Mechanism (v0.1)

A shared **bearer token**. Every mutating request (non-GET) to the control-plane API requires `Authorization: Bearer <server.auth.token>`; the comparison is constant-time and the credential is never logged. mTLS or reverse-proxy (OIDC) auth are documented alternatives with the same seam (`FactoryServerDeps.auth`); mTLS can also bypass/terminate at the proxy — for v0.1 the shared token is the honest, scoped boundary.

## Trust boundary read-only decision

- **GET routes are public** (`/health`, `/handshake`, status/projections, list reads). They carry no secret-bearing responses beyond operational status, and `compose.yaml` publishes the port to **loopback only** (`127.0.0.1:8787`), so a loopback deployment keeps everything host-local. Widen the bind only with `server.auth` configured.
- **All mutating routes are gated when auth is configured.** Without `server.auth`, a loopback bind is the trust boundary; non-loopback + no auth is a hard config error.

## Attributable receipts

Human actions (approval answers, §12 interaction answers, pause/manual gates, e-stop) record the actor from the **authenticated principal** (`server.auth.actor`). A request-body `actor` field is accepted only in unauthenticated loopback mode and is ignored whenever a valid credential is presented — a caller cannot sign a receipt "as" someone else. The receipt (actor + reason + decision) stays durable in the event log (E7).

## Secret handling

- The token is a **deployment secret**: generate it (`openssl rand -base64 32`), keep it out of version control, template/mount it into `factory.yaml` at deployment, and revoke/rotate by re-configuring the server.
- The server and client never log the token or the `Authorization` header; `runtime.json` (pid/url/port) carries no secret.
- Clients pass the credential as `--token <token>` or the `FACTORY_TOKEN` environment variable.

## What is out of scope here

Per-principal tokens / tokens with distinct identities (#41+), TLS termination, audit of GET reads. A single shared principal is the v0.1 scope for #40.
