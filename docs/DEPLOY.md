# Reflow Deployment Guide

**Status: this Dockerfile and fly.toml have NOT been tested with `docker build`
or `fly deploy`. Review and validate before your first deploy.**

This document covers deploying the Reflow delivery server to production.
The server handles both the delivery API (`/api/*`) and — when `SERVE_STATIC=true`
— the built Vite frontend from the same process.

## Architecture

```
Browser → Fly.io TLS proxy → Bun server (:8080)
                                  ├── GET /healthz          → { ok, network, poolId }
                                  ├── GET|POST /api/*       → DeliveryCore
                                  └── GET /* (static mode)  → dist/ assets + SPA fallback
```

## Single-instance requirement

The nonce store is in-memory. Running two instances will accept challenges on
one machine and attempt session validation on another, causing spurious "unknown
nonce" errors. Always deploy with `--ha=false` and keep exactly one machine:

```sh
fly deploy --ha=false ...
fly scale count 1
```

The `fly.toml` sets `auto_stop_machines = "off"` and `min_machines_running = 1`
so the single instance stays alive permanently (no cold-start nonce loss between
requests).

## Private artifact

The private artifact (`server/private/arc-activity-report-v1.json`) is COPIED
into the Docker image at build time. This means:

- The artifact must be present in your local `server/private/` folder when you
  run `fly deploy` (the build step asserts its presence and fails the build if
  it is missing).
- The final image is PRIVATE (Fly.io's built-in registry is private by default).
- **Never push this image to Docker Hub or any public registry.**
- The artifact is gitignored and must never be committed to source control.

## Prerequisites

- [Fly.io CLI](https://fly.io/docs/hands-on/install-flyctl/) installed and
  logged in (`fly auth login`).
- Bun installed locally (`curl -fsSL https://bun.sh/install | bash`).
- The private artifact file at `server/private/arc-activity-report-v1.json`.

## First-time setup

### 1. Create the app

```sh
fly apps create reflow-delivery --region iad
```

Replace `reflow-delivery` with your chosen app name and update `fly.toml`:

```toml
app = "reflow-delivery"
```

### 2. Set secrets

All sensitive values are set as Fly.io secrets — never in `fly.toml`.

```sh
fly secrets set \
  HMAC_SECRET=$(openssl rand -hex 32) \
  REFLOW_POOL_ID=<pool-id> \
  PUBLIC_ORIGIN=https://reflow-delivery.fly.dev \
  DOMAIN=reflow-delivery.fly.dev

# Optional: pin network explicitly (default is testnet)
fly secrets set REFLOW_NETWORK=testnet
```

### 3. Deploy

The `--build-arg` flags bake the public SPA config into the image at build
time. `assert-build-env.ts` validates them before the Vite build runs — the
image build fails fast with a clear message if any value is invalid (wrong
network, missing contract, testnet contract on mainnet, etc.).

```sh
fly deploy --ha=false \
  --build-arg VITE_REFLOW_NETWORK=testnet \
  --build-arg VITE_REFLOW_CONTRACT=0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9 \
  --build-arg VITE_REFLOW_POOL_ID=2 \
  --build-arg VITE_REFLOW_FROM_BLOCK=68201692
```

On success, verify the health endpoint:

```sh
curl https://reflow-delivery.fly.dev/healthz
# {"ok":true,"network":"testnet","poolId":"2"}
```

## Redeploying after a contract or pool change

Secrets are re-read from environment at server startup and do not need a
redeploy for pool/contract changes that are only server-side (e.g. a new
`REFLOW_POOL_ID`). For changes that must be baked into the SPA (contract
address, pool id shown in the UI, network), pass them as `--build-arg` again:

```sh
fly secrets set REFLOW_POOL_ID=<new-id>
fly deploy --ha=false \
  --build-arg VITE_REFLOW_NETWORK=testnet \
  --build-arg VITE_REFLOW_CONTRACT=0x<new> \
  --build-arg VITE_REFLOW_POOL_ID=<new-id> \
  --build-arg VITE_REFLOW_FROM_BLOCK=<deploy-block>
```

## Rotating the HMAC secret

Rotating the secret invalidates all currently valid delivery tokens (members
will need to re-unlock their files):

```sh
fly secrets set HMAC_SECRET=$(openssl rand -hex 32)
fly deploy --ha=false \
  --build-arg VITE_REFLOW_NETWORK=testnet \
  --build-arg VITE_REFLOW_CONTRACT=0x... \
  --build-arg VITE_REFLOW_POOL_ID=2 \
  --build-arg VITE_REFLOW_FROM_BLOCK=68201692
```

## Local Docker build (optional verification)

To verify the build locally before deploying to Fly.io:

```sh
docker build \
  --build-arg VITE_REFLOW_NETWORK=testnet \
  --build-arg VITE_REFLOW_CONTRACT=0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9 \
  --build-arg VITE_REFLOW_POOL_ID=2 \
  --build-arg VITE_REFLOW_FROM_BLOCK=68201692 \
  -t reflow-delivery .

docker run -p 8080:8080 \
  -e HMAC_SECRET=$(openssl rand -hex 32) \
  -e REFLOW_POOL_ID=2 \
  -e PUBLIC_ORIGIN=http://localhost:8080 \
  -e DOMAIN=localhost \
  reflow-delivery

curl http://localhost:8080/healthz
```

## Environment variable reference

| Variable | Where | Required | Default | Description |
|---|---|---|---|---|
| `VITE_REFLOW_NETWORK` | build-arg + secret | No | `testnet` | `testnet` or `mainnet` |
| `VITE_REFLOW_CONTRACT` | build-arg | Yes | — | ReflowPools contract address |
| `VITE_REFLOW_POOL_ID` | build-arg | Yes | — | Pool id baked into the SPA |
| `VITE_REFLOW_FROM_BLOCK` | build-arg | No | — | Indexer start block |
| `REFLOW_POOL_ID` | secret | Yes | — | Pool id read by the server |
| `REFLOW_NETWORK` | secret | No | `testnet` | Server network override |
| `HMAC_SECRET` | secret | Yes | — | 32+ byte hex token signing key |
| `PUBLIC_ORIGIN` | secret | Yes | — | Canonical HTTPS origin |
| `DOMAIN` | secret | Yes | — | Hostname for SIWE messages |
| `DELIVERY_PORT` | env | No | `8080` | Server listen port |
| `SERVE_STATIC` | env | No | `true` | Serve built SPA from server |
| `TRUSTED_PROXY` | env | No | `true` | Trust `X-Forwarded-For` |
