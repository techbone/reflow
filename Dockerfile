# syntax=docker/dockerfile:1
#
# Multi-stage Dockerfile for the Reflow delivery server.
#
# Stage 1 (frontend-builder): validates build args, then builds the Vite SPA.
# Stage 2 (runtime): runs the Bun delivery server.  When SERVE_STATIC=true the
#   server also serves the built SPA from the same process.
#
# Network isolation: ONLY the artifact for the configured network is copied into
# the runtime image.  A testnet image must not contain the mainnet file, and vice
# versa.  The selection is driven by VITE_REFLOW_NETWORK (re-declared as ARG in
# the runtime stage) via a conditional RUN + cp from the builder stage files.
#
# The private artifact file is baked into the image layer.  The image must only
# be pushed to a PRIVATE registry (fly.io's built-in registry is private by
# default).  NEVER push this image to Docker Hub or any public registry.
#
# Usage (Fly.io):
#   fly deploy --ha=false \
#     --build-arg VITE_REFLOW_NETWORK=testnet \
#     --build-arg VITE_REFLOW_CONTRACT=0x... \
#     --build-arg VITE_REFLOW_POOL_ID=2 \
#     --build-arg VITE_REFLOW_FROM_BLOCK=68201692
#
# NOTE: this Dockerfile has NOT been tested by running `docker build` or
# `fly deploy`. Review and validate it before your first deploy.

# ── Stage 1: frontend build ───────────────────────────────────────────────────
FROM oven/bun:1 AS frontend-builder
WORKDIR /build

# Declare ARGs so --build-arg values are visible to RUN commands and baked into
# the SPA via Vite's import.meta.env substitution.
ARG VITE_REFLOW_NETWORK
ARG VITE_REFLOW_CONTRACT
ARG VITE_REFLOW_POOL_ID
ARG VITE_REFLOW_FROM_BLOCK

# Export as ENV so that `bun run scripts/assert-build-env.ts` and
# `bun run build` both see the values (Bun reads process.env, not ARG directly).
ENV VITE_REFLOW_NETWORK=${VITE_REFLOW_NETWORK}
ENV VITE_REFLOW_CONTRACT=${VITE_REFLOW_CONTRACT}
ENV VITE_REFLOW_POOL_ID=${VITE_REFLOW_POOL_ID}
ENV VITE_REFLOW_FROM_BLOCK=${VITE_REFLOW_FROM_BLOCK}

# Install ALL deps (dev deps needed for vite build)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Validate build args before spending time on the build.
# Fails with a clear error if: invalid network, missing contract/pool id,
# mainnet with a known testnet contract, mainnet with REPORTS.mainnet null.
RUN bun run scripts/assert-build-env.ts

# Assert the network-specific private artifact exists.
# assert-build-env.ts also checks this, but this RUN step makes the error surface
# clearly in the Docker layer cache even if assert-build-env is cached.
# Testnet:  VITE_REFLOW_NETWORK=testnet  → arc-activity-report-v1.json
# Mainnet:  VITE_REFLOW_NETWORK=mainnet  → arc-activity-report-mainnet-v1.json
# The assert-build-env script already handles this check; the inline test is belt-and-suspenders.
RUN sh -c ' \
  NET="${VITE_REFLOW_NETWORK:-testnet}"; \
  if [ "$NET" = "mainnet" ]; then \
    FILE="server/private/arc-activity-report-mainnet-v1.json"; \
  else \
    FILE="server/private/arc-activity-report-v1.json"; \
  fi; \
  test -f "$FILE" || { echo "FATAL: $FILE is missing. Provide the private artifact for the $NET build." && exit 1; } \
'

# Build the SPA (writes to dist/)
RUN bun run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# Re-declare the network build arg so it is visible in this stage.
# ARG scope does not cross FROM boundaries unless re-declared.
ARG VITE_REFLOW_NETWORK

# Install production deps only (no dev tooling in the runtime image)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Server source and shared client libraries the server imports at runtime
COPY server/ ./server/
COPY src/lib/ ./src/lib/
COPY remappings.txt ./

# Built SPA (served when SERVE_STATIC=true)
COPY --from=frontend-builder /build/dist ./dist

# Public assets read by the server at runtime (terms.md, manifest.json, etc.)
COPY public/ ./public/

# Private artifact — copy ONLY the file for the configured network.
# IMPORTANT: only push this image to a PRIVATE registry.
# Testnet:  VITE_REFLOW_NETWORK=testnet  → arc-activity-report-v1.json
# Mainnet:  VITE_REFLOW_NETWORK=mainnet  → arc-activity-report-mainnet-v1.json
# A mainnet image must NOT contain the testnet file; a testnet image must NOT
# contain the mainnet file.  We copy the whole private dir from the builder into
# a temp location, then move only the selected file into its final path.
COPY --from=frontend-builder /build/server/private /tmp/private
RUN set -e; \
  NET="${VITE_REFLOW_NETWORK:-testnet}"; \
  mkdir -p server/private; \
  if [ "$NET" = "mainnet" ]; then \
    cp /tmp/private/arc-activity-report-mainnet-v1.json server/private/arc-activity-report-mainnet-v1.json; \
  else \
    cp /tmp/private/arc-activity-report-v1.json server/private/arc-activity-report-v1.json; \
  fi; \
  rm -rf /tmp/private

# Runtime defaults (override with fly secrets / -e flags for secrets)
ENV PORT=8080
ENV DELIVERY_PORT=8080
ENV SERVE_STATIC=true
ENV TRUSTED_PROXY=true
# Set these as fly secrets, not here:
#   PUBLIC_ORIGIN, DOMAIN, HMAC_SECRET,
#   VITE_REFLOW_CONTRACT, REFLOW_POOL_ID,
#   VITE_REFLOW_NETWORK, VITE_REFLOW_FROM_BLOCK

# Health check using the /healthz endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:8080/healthz'); process.exit(r.ok ? 0 : 1)"

EXPOSE 8080

CMD ["bun", "run", "server/index.ts"]
