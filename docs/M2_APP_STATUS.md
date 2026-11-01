# Reflow M2/M3 — Application Status

## Actual check results (M3 defect fix — manifest path routing)

| Check | Result |
|-------|--------|
| `oxlint` (type-aware + standard) | 0 errors, 1 warning (acceptable pre-existing) |
| `tsc --noEmit` (client) | 0 errors |
| `tsc --noEmit --project server/tsconfig.json` | 0 errors |
| `bun run test:client` (vitest) | **419/419 pass** (80 txLifecycle + 75 TxOrchestrator + 28 adminPool + 7 cssVarAudit + 21 statTiles + 52 deliveryClient + 76 network + 57 m3b + 23 networkCopy) |
| `bun run test:server` (vitest, Node env) | **163/163 pass** (20 chainAdapter + 60 delivery + 22 validateConfig + 31 staticServing + 30 assertBuildEnv) |
| `forge test -v` | **86/86 pass** |
| `bun run build` (vite build) | production build succeeds (15 s) |
| `docker build` / `fly deploy` | NOT performed — see `docs/DEPLOY.md` |
| Browser wallet / live testnet | NOT performed (sandbox environment) |

## M3 Step A — Network Abstraction + validateServerConfig

`src/lib/network.ts` is the single source of truth for which network is active.

### resolveNetwork changes (M3 corrections)

- **Throws on invalid values**: any `REFLOW_NETWORK` / `VITE_REFLOW_NETWORK` value other than `''`, `'testnet'`, or `'mainnet'` (after trim+lowercase) throws, naming the bad value. Fixes bug D: `"mainet"` (typo) no longer silently becomes testnet.
- **Both-set-differ is fatal**: if `REFLOW_NETWORK` and `VITE_REFLOW_NETWORK` are both set to non-empty different values, throws with a clear message.
- **Server key wins**: `REFLOW_NETWORK` takes precedence over `VITE_REFLOW_NETWORK`; if only one is set it is used.
- **Client reads VITE_ only**: in browser/Vite context, only `VITE_REFLOW_NETWORK` is populated in `import.meta.env`.

### server/validateConfig.ts (new)

Pure `validateServerConfig({ env, rpcChainId })` function that:
- Collects ALL fatal errors before any side-effects.
- Wraps resolveNetwork so invalid-value errors are surfaced as error strings, not uncaught throws.
- Checks: missing VITE_REFLOW_CONTRACT, missing REFLOW_POOL_ID, mainnet-known-testnet-contract (case A), network REPORTS null (case B — now only reachable if a network has no configured report), testnet-hash-on-mainnet, RPC chain-id mismatch (case C).
- `server/index.ts` calls it synchronously BEFORE `Bun.serve`. Chain-id check uses a second call after `getChainId()` resolves, also BEFORE port bind. Verified by source-order test SI2.

### import.meta.env typing fix

`network.ts` now accesses `import.meta.env` through a local `ImportMetaWithEnv` interface cast, avoiding `no-unsafe-assignment` lint errors and the `Property 'env' does not exist on type 'ImportMeta'` typecheck error under `server/tsconfig.json`. `typecheck:server` is now in `check.sh`.

### Bug fixes
- Case A: mainnet + testnet contract → `validateServerConfig` errors before `Bun.serve`.
- Case B: network + `REPORTS[network.key]` null → `validateServerConfig` errors before `Bun.serve`. Both networks are now configured so this case is not reachable in normal operation, but the guard remains.
- Case C: RPC chain-id mismatch → checked before port bind, not after.
- Case D: typo `"mainet"` → `resolveNetwork` throws naming the bad value.
- Case E: normal testnet → unchanged (passes with 0 errors).

## File inventory

### Transaction orchestration (new in M2 final)

| File | Purpose |
|------|---------|
| `src/lib/TxOrchestrator.ts` | Plain TypeScript class. Owns the latch, preflight, intent persistence, wallet dispatch, receipt handling, manual reconciliation. Injected adapters: `StorageAdapter`, `RpcAdapter`, `WalletAdapter`. |
| `src/lib/TxController.tsx` | Thin React wrapper. Creates one `TxOrchestrator` instance per provider lifetime via `useRef`. Mounts above all routes. |
| `src/lib/txLifecycle.ts` | Reducer (`txReducer`), `PendingContext` types/validators, `savePendingContext`/`restorePendingContext`, `verifyReceipt`, `classifyError`. |

### Components

| File | Notes |
|------|-------|
| `src/components/PurchaseRoom.tsx` | Presentational only. Calls `useTxController().execute()`. No own reducer, no write hooks. |
| `src/components/ReceiptView.tsx` | Live event indexer via `useEventIndexer`. Public route (no wallet required). |
| `src/components/ShareExample.tsx` | Interactive illustrative example with CostBar. |
| `src/components/CostBar.tsx` | Fixed: open slots shown as separate flex segments, not as an overlay obscuring paid member shares. |
| `src/components/HowItWorks.tsx` | Educational content. |
| `src/components/Header.tsx` | Nav: Explore / My purchases / Receipts / How it works. |

### Hooks / utilities

| File | Notes |
|------|-------|
| `src/hooks/useReflowPool.ts` | Pool data, member data, quote, USDC balance/allowance, outstanding credit. |
| `src/hooks/useEventIndexer.ts` | Bounded `eth_getLogs` by page, pool-ID topic filter, ABI decoding, dedup, deterministic sort. |
| `src/hooks/useContractVerification.ts` | Runtime `usdc()` address match + `decimals()` == 6. |
| `src/lib/shareCalc.ts` | `shareOf`, `fmtUsdc`. All USDC amounts in live money displays use `fmtUsdc(value, 6)` to preserve micro-USDC. |

### Client delivery (Part 2)

| File | Purpose |
|------|---------|
| `src/lib/reportManifest.ts` | `REAL_ARTIFACT_HASH`, `REAL_TERMS_HASH`, `REAL_MANIFEST_PATH`, `REAL_PREVIEW_PATH`, `selectTerms`, `classifyArtifact`, `hashBytes`, `ReportManifest`, `ReportPreview` types. |
| `src/lib/TermsController.ts` | Framework-free terms verifier. Injected `FetchAdapter` + `HasherAdapter`. States: idle, loading, verified, mismatch, unknown-hash, fetch-error. |
| `src/lib/DeliveryController.ts` | Framework-free unlock flow: membership → challenge → sign → session → download → hash verify → blob URL. Injected adapters. Latch, reset, error codes. Exports `makeMembershipAdapter(readContract, contractAddress)` — calls `getMember` live via the injected RPC client at unlock time, never from cached React state. |
| `src/components/ResourceCard.tsx` | Real/test/unknown badge; fetches `preview.json` headline + `manifest.json` facts for real pools only. |
| `src/components/PurchaseRoom.tsx` | `TermsPanel` (verifies on mount, blocks buy on mismatch/unknown); `DeliveryPanel` (unlock flow, per-phase labels, retry); `DeliveryController` instantiated per pool above route via hook. |
| `src/components/AdminView.tsx` | Mode toggle (test / real-report-pool). Real mode: fetches `/api/report/commitment`, verifies against committed constants, fetches and hashes `terms.md`, blocks if any mismatch. Success message shows `VITE_REFLOW_POOL_ID` + `REFLOW_POOL_ID` for real mode. |

### Tests

| File | Count | What is exercised |
|------|-------|------------------|
| `src/tests/txLifecycle.test.ts` | 80 | Reducer, `verifyReceipt` (ABI-encoded logs), `classifyError`, `savePendingContext`/restore round-trip, micro-USDC precision. |
| `src/tests/txController.test.ts` | 75 | `TxOrchestrator` directly, all required regression scenarios R1–R12 with injected adapters. |
| `src/tests/deliveryClient.test.ts` | 35 | TC: TermsController (selection, hash pass/fail, unknown, fetch-error). DC: DeliveryController (happy path, each error code, latch, retry). RA: `buildRealPoolArgs` (mismatch blocks, all 7 scenarios). PR: privacy scan (no server/ import, no server/private reference, no private artifact in public/). |

## TxOrchestrator correctness properties (tested)

| Scenario | Test |
|----------|------|
| R1: Two synchronous `execute()` calls → only one proceeds | [R1] Synchronous duplicate-submission guard |
| R2: New component instance while latch held cannot bypass | [R2] A new orchestrator instance has its own latch |
| R3: Zero allowance → only approve simulated; purchase never estimated | [R3] Zero allowance: approve-first |
| R4: Storage fails before signing → zero wallet calls | [R4] Storage failure before signing |
| R5: Storage fails after broadcast → real hash retained in memory + truthful message | [R5] Storage failure after broadcast |
| R6: Ambiguous send error keeps latch + intent | [R6] Send timeout/ambiguous error |
| R7: Receipt query error preserves pending hash, keeps latch | [R7] Receipt query error |
| R8: Verified revert vs wrong-event receipt are distinct outcomes | [R8] Revert vs wrong-event |
| R9: Wrong emitter/pool/wallet/amount each independently rejected | [R9] Event field validation |
| R10: Chain mismatch, balance, simulation, estimation all prevent wallet call | [R10] Preflight guards |
| USER_REJECTED clears intent; every other error keeps it | [R6] USER_REJECTED test |
| Manual hash reconciliation: verified hash resolves; bad hash stays in recovery | Manual hash reconciliation |

## Deployment

| Field | Value |
|-------|-------|
| Contract | `ReflowPools` |
| Network | Arc Testnet (chain ID 5042002) |
| Address | `0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9` |
| Deploy tx | `0x6ef3023f4ddfec7e6f5c42e586c7fb6907214ba0c8432446f907f4fdb8129b32` |
| Deploy block | 68,201,692 (`0x410acdc`) |
| Deployed at | 2026-10-20T15:29:59.050Z |
| Explorer | https://explorer.testnet.arc.io/address/0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9 |

**On-chain verification (read via `cast call` immediately after deploy):**

| Check | Expected | Actual | Pass |
|-------|----------|--------|------|
| Runtime bytecode present | `0x6080...` | `0x608060405234801561...` | ✓ |
| `usdc()` | `0x3600000000000000000000000000000000000000` | `0x3600000000000000000000000000000000000000` | ✓ |
| `nextPoolId()` | `1` | `1` | ✓ |

**Constructor arg:** `usdcToken = 0x3600000000000000000000000000000000000000` (Arc Testnet canonical USDC, 6 decimals). The constructor validates `decimals() == 6`; any wrong address would have reverted the deploy.

## Environment variables

`VITE_REFLOW_CONTRACT` and `VITE_REFLOW_FROM_BLOCK` are now set in `.env`. `VITE_REFLOW_POOL_ID` is deliberately **not set** — the app shows "Testnet setup pending" and live actions remain disabled until a real pool is created by the provider.

```
VITE_REFLOW_CONTRACT=0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9
VITE_REFLOW_FROM_BLOCK=68201692
# VITE_REFLOW_POOL_ID=   ← set this once the provider creates the real pool
```

## Delivery server

### Files added

| Path | Purpose |
|------|---------|
| `server/core/delivery.ts` | Framework-free `DeliveryCore` class with injected `ChainAdapter`/`ClockAdapter`/`RandomAdapter`/`FileAdapter`/`HmacAdapter`. All four endpoints implemented. |
| `server/constants.ts` | Committed `ARTIFACT_HASH`, `TERMS_HASH`, `ARC_TESTNET_CHAIN_ID`, `DELIVERY_ABI`. |
| `server/http.ts` | Thin Bun HTTP wrapper: CORS limited to app origin, per-IP rate limits (challenge: 10/min, session: 5/min), 4 KB body cap, generic error bodies. |
| `server/index.ts` | Entry point. Reads `VITE_REFLOW_CONTRACT`, `REFLOW_POOL_ID`, `PUBLIC_ORIGIN`, `RPC_URL`/proxy vars, `HMAC_SECRET`, `PORT` from env. Startup artifact integrity check. Fails to start if hash mismatches. |
| `server/private/arc-activity-report-v1.json` | THE PAID FILE. Only path: `server/private/`. In `.gitignore`. Never under `public/` or `dist/`. |
| `public/report-v1/manifest.json` | Public manifest (title, block range, artifact hash, terms hash, generator). |
| `public/report-v1/terms.md` | Public licence text (keccak256 committed on-chain as `termsHash`). |
| `public/report-v1/preview.json` | Public free preview (headline numbers). |
| `server/tests/delivery.test.ts` | 42 server tests (Node environment, deterministic injected adapters, SYNTHETIC viem keys). |
| `vitest.server.config.ts` | Server test config (Node environment, `server/tests/**`). |

### Honest limits

- **Server.** `bun run server` starts it beside the Vite dev server. The server can also be containerised and hosted via Fly.io (`SERVE_STATIC=true`). `docker build` and `fly deploy` were not run by Arc Studio; validate `Dockerfile` and `fly.toml` before your first deploy.
- **EOA signatures only.** Smart-contract wallets (EIP-1271) are not supported. The session endpoint returns a clear error explaining this.
- **In-memory nonce store.** Resets on server restart. Outstanding tokens remain valid until their 10-minute expiry.
- **Delivery cannot stop copying.** A member who receives the file can copy it; the licence in `terms.md` is the only restriction.
- **No live delivery test claimed.** Tests drive `DeliveryCore` directly with injected adapters. No real RPC call, no real wallet signature, no real file request from a browser.

### How to run

```sh
# In one terminal — Vite dev server (already running):
bun run dev

# In a second terminal — delivery server:
REFLOW_POOL_ID=<pool-id> bun run server
```

The Vite dev proxy forwards `/api/*` to `http://localhost:${DELIVERY_PORT}` (default 8791). The port is read from `DELIVERY_PORT` in `.env` via `server/serverPort.ts`, which both `server/index.ts` and `vite.config.ts` import — one setting controls both. If 8791 conflicts with another process, set `DELIVERY_PORT=<free-port>` in `.env` and restart both servers. The delivery server exits with a clear EADDRINUSE message if the chosen port is taken.

## Remaining integration work

1. **Create the test pool**: navigate to `#admin`, connect the provider wallet, switch to "Test pool" mode, and click "Create test pool". After success it shows the pool ID and the env line to set.
2. **Configure pool ID**: set `VITE_REFLOW_POOL_ID=<id>` in `.env` and restart the dev server to enable live actions.
3. **Start the delivery server**: `REFLOW_POOL_ID=<id> bun run server`. Both servers must be running for report delivery.
4. **Browser wallet smoke test**: connect MetaMask/ConnectKit, purchase first, verify receipt, unlock report.
5. **Real pool**: navigate to `#admin`, switch to "Real report pool" mode. The flow fetches `/api/report/commitment`, browser-hashes `terms.md`, verifies all hashes against committed constants before sending — any mismatch blocks the transaction. After success it shows `VITE_REFLOW_POOL_ID` and `REFLOW_POOL_ID` env lines.

## Explicit non-claims

- No browser wallet test performed.
- No live testnet transaction submitted (other than the contract deployment itself).
- No pool created; `VITE_REFLOW_POOL_ID` not set.
- No live delivery test performed.
- No funds transferred.
