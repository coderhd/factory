# Factory Server image (spec §20). Builds the image `compose.yaml` pins, so the
# pinned ref has a real build path instead of pointing at an unbuilt registry
# tag. Runtime is Bun (this repo has no compile step: Bun runs the TypeScript
# CLI directly).
#
# Build (from the repo root):
#   docker build -t ghcr.io/coderhd/factory:0.1.0 .
#
# Base image is pinned to the repo's Bun version, never `latest`.
FROM oven/bun:1.4.2-slim

# curl is needed by the compose healthcheck (`/api/health`); the slim image has
# no HTTP client.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The whole runtime tree: no dependencies are declared today (the CLI imports
# only `node:*`, `bun:*` and repo sources), so the runtime sources plus
# `factory.yaml` are the complete image. `.dockerignore` keeps caches and local
# state out.
COPY src ./src
COPY factory.yaml ./factory.yaml

# Factory state, artifacts and knowledge live on volumes (compose.yaml mounts
# them onto the `.factory/*` paths `factory.yaml` declares), not in the image.
RUN mkdir -p /app/.factory/state /app/.factory/artifacts /app/.factory/knowledge

EXPOSE 8787

# Foreground server: `__serve` is the non-detached entry (`factory start`
# daemonises a child and would exit immediately in the container). The bind
# address is `--hostname`, so the mapped port is reachable from the host; the
# loopback default in `factory.yaml` is for local dev.
CMD ["bun", "run", "src/cli/factory.ts", "__serve", "--dir", "/app", "--port", "8787", "--hostname", "0.0.0.0"]
