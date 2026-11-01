# Reflow — Arc Studio Project

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

Reflow: a shared-purchase settlement application. Providers offer reusable digital reports under a fixed cohort license. The first buyer pays the full price once; later buyers pay a decreasing fair share and earlier buyers accumulate rebate credits, claimable at any time. Demo price: $1.20 USDC, 4 members each converge to $0.30. Providers create pools; the first buyer pays full price C directly to the provider; each subsequent buyer pays a decreasing share and the difference is credited to all earlier members, claimable at any time via `claimFor`. Equal-share formula: `floor(C/n) + (i < C%n ? 1 : 0)`. No fees, no upgrades, no admin sweep.

## M1 Status

Completed. All 6 review gaps addressed and corrections verified. 86/86 tests passing (forge test, solc 0.8.28, OZ 5.1.0).
See `docs/M1_REVIEW.md` for the full review report.

**Contract:** `contracts/ReflowPools.sol`
**Unit tests:** `contracts/test/ReflowPools.t.sol` (54 tests, 2 fuzz suites)
**Regression tests:** `contracts/test/ReflowReview.t.sol` (32 tests, 2 fuzz suites)

**Deployed on Arc Testnet:**
- Address: `0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9`
- Deploy tx: `0x6ef3023f4ddfec7e6f5c42e586c7fb6907214ba0c8432446f907f4fdb8129b32`
- Deploy block: 68,201,692
- Explorer: https://explorer.testnet.arc.io/address/0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9
- Constructor arg: `usdcToken = 0x3600000000000000000000000000000000000000` (Arc Testnet USDC, 6 decimals)
- On-chain verified: `usdc()` = `0x3600000000000000000000000000000000000000`, `nextPoolId()` = 1

The constructor validates that the token is a contract with `decimals() == 6`. Mainnet would use the same USDC address.

## M2 Status

Application UI complete. Contract deployed to Arc Testnet. Pools 1 (test placeholder) and 2 (real report pool) exist on the deployed contract. Pool 2 was purchased and the unlock flow exercised live by wallet `0xe3e7...959a`; downloaded file keccak256 matches `ARTIFACT_HASH` on-chain.

**Actual checks (M3 defect fix — production-build env resolution):**
- `oxlint`: 0 errors, 1 warning (pre-existing)
- `tsc --noEmit` (client): 0 errors
- `tsc --noEmit --project server/tsconfig.json` (`typecheck:server`): 0 errors
- `bun run test:client` (vitest): **419/419 pass** (unchanged)
- `bun run test:server` (vitest, Node): **171/171 pass** (163 previous + 8 new viteBuild tests: 4 VB_UNIT + 4 VB_BUILD)
- `forge test -v`: **86/86 pass** (unchanged)
- `bun run build` (vite build): production build succeeds

**Architecture:**
- `src/lib/TxOrchestrator.ts` — plain TypeScript class, no React. ALL storage goes through the injected `StorageAdapter` (both intent and pending keys). Tests import and drive this class directly with deterministic adapters.
- `src/lib/TxController.tsx` — thin React wrapper, owns ONE orchestrator instance per provider lifetime.
- `PurchaseRoom.tsx` — purely presentational. No write hooks, no reducer, no busy ref.

**Structural correctness (post-corrections):**
- Latch `_locked` (plain boolean) acquired synchronously before any `await`. Two concurrent calls cannot both pass.
- `boot()` reads both storage keys on provider mount. Valid or corrupt records in either key lock the orchestrator and surface recovery state. Nothing silently drops.
- `abandonRecovery()` removed. Only proven terminal outcomes (verified success, proven revert) or USER_REJECTED release the latch.
- `WalletAdapter.currentAccount()` called immediately before each wallet write to detect account/chain switch during async preflight.
- Signing intent persisted BEFORE wallet call. Storage failure before wallet = zero wallet calls. Storage failure after broadcast = real hash retained, truthful message.
- Allowance checked BEFORE any gas estimation. Zero-allowance path submits only `approve`; purchase/join never estimated with zero allowance.
- All gas estimates mandatory (approve, purchaseFirst, join, claimFor). No fallbacks. Gas price and native balance failures are PREFLIGHT_FAIL.
- Nonce and startBlock read failures are PREFLIGHT_FAIL (not silently 0).
- `PendingContext` (v3) carries `calldata`, `target`, `observedNonce`, `startBlock` — reconciliation fields survive intent clearance.
- `reconcileHash` same-hash fast-path: if hash === ctx.hash, skip tx fetch and go straight to receipt. Different hash: ALL of from/to/calldata/nonce(exact)/block must match; null `to` always rejected; reverted unrelated hash NEVER releases.
- Outer `execute()` catch: keeps latch when `_intentInStorage` is true (wallet may have been called).
- `onReceiptSuccess` with wrong event stays locked in `rpc-recovery`. Only `receipt.status === 'reverted'` releases.
- REFRESH, WALLET_CHANGED, navigation cannot unblock an unresolved hash.

**Event selectors verified with `viem.toEventSelector` against the ABI**
- `RebateCredited` ABI param is `participant` (not `beneficiary`) and `amount` (not `credit`)
- See `docs/M2_APP_STATUS.md` for full file list, configuration, and remaining integration tasks

### Verified event selectors (keccak256 of canonical ABI signatures)
| Event | Selector |
|-------|----------|
| FirstPurchased(uint256,address,uint256) | `0x754069691ea9a7afd0c431ac02baa6da42ae597453e1eab93f59a6b6ac00d2eb` |
| Joined(uint256,address,uint256,uint256) | `0xd759c3ee7768434a6bd039daf120a916dc49b4c2b7e4a2d86dfeba6a06a5e32a` |
| RebateCredited(uint256,address,uint256) | `0x1873b25effcd876e2cbc1e2deddce9e54b8b90bddd7e2a9550aa7aaed80cde25` |
| RebateClaimed(uint256,address,uint256)  | `0x664046989647942cef0d27bdf8ca8461401b8b0b47f5cf66f9a034761b633d56` |

**Environment variables:**
- `VITE_REFLOW_CONTRACT=0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9` — set in `.env`
- `VITE_REFLOW_FROM_BLOCK=68201692` — set in `.env`
- `VITE_REFLOW_POOL_ID=2` — set in `.env` (pool 2 on Arc Testnet, real report pool)
- `VITE_REFLOW_NETWORK` — omit for testnet (default). Set to `mainnet` to enable Arc mainnet mode.

Pool 2 (real testnet report pool) was created and purchased live; a real member wallet has `isMember = true` onchain. The unlock flow was exercised live; downloaded file keccak256 matches `ARTIFACT_HASH`.

## M3 Step A — Network Abstraction (corrections applied)

`src/lib/network.ts` is the single source of truth for which network is active.

**How it works:**
- `resolveNetwork(env)` reads `REFLOW_NETWORK` first (server key), then `VITE_REFLOW_NETWORK` (client key). Falls back to `testnet`.
  - Both set and differing → THROWS (fatal misconfiguration, named in error).
  - Any value other than `''`, `'testnet'`, or `'mainnet'` (after trim+lowercase) → THROWS naming the bad value.
- Returns a `NetworkConfig` with `key`, `chainId`, `usdc`, `name`, `isMainnet`, `isTestnet`, `rpcUrls`, `compassKey`.
- `NETWORK` is a module-level singleton resolved at import time from the live env.
- `REPORTS` in `reportManifest.ts` maps each network key to its report constants. Both `testnet` and `mainnet` entries are non-null (both reports are committed).

**`server/validateConfig.ts` (new):**
- Pure `validateServerConfig({ env, rpcChainId })` collects ALL fatal errors before any side-effects.
- Covers: invalid network, both-set-differ, missing VITE_REFLOW_CONTRACT/REFLOW_POOL_ID, mainnet known-testnet-contract, network REPORTS null, mainnet testnet hashes, RPC chain-id mismatch.
- `server/index.ts` calls `validateServerConfig` BEFORE `Bun.serve` (asserted by source-order test SI2).
- Separate sync + async phases: sync checks run at startup, chain-id check runs after `getChainId()` resolves, both before port bind.

**Guards in network.ts:**
- `assertNotKnownTestnetContract(address, network)` — throws if a known testnet-only contract is used on mainnet.
- `assertNotTestnetHashes(hashes, network, knownSet)` — throws if testnet/test hashes appear on mainnet.
- `checkChainIdMatchesNetwork(rpcChainId, network)` — returns error string on mismatch (used by validateServerConfig).

**Visible changes:**
- Header badge shows resolved network label (not hardcoded "Arc Testnet").
- Amber banner appears on every route when mainnet is active.
- Purchase/join confirmation panels add "real USDC" note on mainnet.
- Admin screen hides test-pool mode on mainnet; pool creation requires typing `CREATE MAINNET POOL`.
- Footer is network-aware (no hardcoded "testnet only" in mainnet mode).

**Source hygiene:**
- No `5042002`, `ARC_TESTNET`, or `arcTestnet` literals outside `network.ts`, `onchain-facts.ts`, and `*.test.ts`. Verified by the source-scan test `N4.4` in `src/tests/network.test.ts`.
- All chain ID, USDC address, and explorer URL references in src/ and server/ resolve through `NETWORK`.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet by default (Chain ID: 5042002); Arc Mainnet (Chain ID: 5042) when `VITE_REFLOW_NETWORK=mainnet`. Both from `viem/chains`.
- Token: USDC (6 decimals, address `0x3600000000000000000000000000000000000000` on both Arc networks)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## To Run

```bash
bun install
bun run dev           # Vite dev server on :5173
# In a separate terminal:
REFLOW_POOL_ID=<id> bun run server   # Delivery server on :8791 (default; override with DELIVERY_PORT=)
```

Vite proxies `/api/*` to the delivery server. The proxy target port is read from `DELIVERY_PORT` (default 8791) via `server/serverPort.ts`, which both `server/index.ts` and `vite.config.ts` import. Set `DELIVERY_PORT=<port>` in `.env` to override both at once.

## Delivery Server

`server/private/arc-activity-report-v1.json` is the paid file. It is gitignored (`server/private/` in `.gitignore`), is NOT under `public/` or `dist/`, and is never imported by client code.

Public report files are served statically from `public/report-v1/`: `manifest.json`, `terms.md`, `preview.json`.

**Committed hashes** (in `server/constants.ts`):
- `ARTIFACT_HASH = 0x9f133dfc1902678ccadff6a874ab99e22e786de98e6c0464ddc6a0c872858d68`
- `TERMS_HASH = 0xcc64d34b5c37803e0c410295d41c5bf83139701d5bb256b8900bcb0c3d146b50`

## M3 Step B Status (current)

**A — Safety gaps (completed):**
- `AdminView.buildRealPoolArgs` accepts `ReportConfig` from `REPORTS[NETWORK.key]`; create button gated on non-null; `assertNotTestnetHashes` called in real mode.
- Server `getCommitment` now returns `network` (key) and `chainId` in the JSON response.
- `DeliveryController.unlock` runs a `commitmentCheck` preflight that compares the server's `network` + `chainId` against `NETWORK.key` + `NETWORK.chainId`; mismatches produce `service-refused` with a diagnostic message.
- `selectTerms` and `classifyArtifact` now read hashes from `REPORTS[networkKey]` rather than hardcoded constants; when `REPORTS[networkKey]` is null, both return `unknown`.

**B — Leftover wording (completed):**
- `SetupPending` title: "Mainnet setup pending" / "Testnet setup pending".
- Loading spinner: "Loading pool from {NETWORK.name}…".
- RPC error: "Could not reach {NETWORK.name}".
- Wrong-chain switch button: "Switch to {NETWORK.name}".
- ResourceCard: description, status badge and license terms use `NETWORK.name`.
- AdminView: title/intro/footnote now mode + network aware.

**C — Hosting files (corrected):**
- `package.json` gained `"build": "vite build"` (Dockerfile uses it; script was missing).
- `Dockerfile`: `oven/bun:1` + `oven/bun:1-slim`; declares four `ARG`/`ENV` for `VITE_` build vars; runs `scripts/assert-build-env.ts` before the Vite build; COPYs `server/private/` into runtime stage (no volume); asserts private file exists at build time (network-aware: testnet → `arc-activity-report-v1.json`; mainnet → `arc-activity-report-mainnet-v1.json`).
- `scripts/assert-build-env.ts`: validates network, contract, pool id, from-block, mainnet-testnet-contract guard, network-specific artifact file present — fails build with clear message on any violation.
- `fly.toml`: `[http_service]` replacing `[[services]]`; no `[[mounts]]`; `force_https=true`, `auto_stop_machines="off"`, `min_machines_running=1`, `/healthz` HTTP check.
- `wrapWithStatic` in `server/http.ts`: 404 for dotfiles, blocked path prefixes (`/server`, `/src`, `/contracts`, `/node_modules`, `/scripts`), unknown extensions, known-extension misses; SPA fallback only for extensionless routes; `/healthz` returns `{ok, network, poolId}`.
- `server/index.ts` passes `{network, poolId}` meta to `wrapWithStatic` and `/healthz` in both static and non-static branches.
- `docs/DEPLOY.md` rewritten: no volume/sftp; `fly deploy --ha=false`; Docker local test instructions; single-instance rationale; env var reference.
- `server/tests/assertBuildEnv.test.ts`: 30 tests (was 25).
- `server/tests/staticServing.test.ts`: 31 tests.

## M3 Step C Status (current)

**Mainnet report wired — all four report files placed and verified.**

**REPORTS.mainnet** is now populated (non-null) with real mainnet hashes and file paths.

**What changed:**
- `src/lib/reportManifest.ts`: `ReportConfig` gained `previewPath`, `artifactFilename`, `downloadFilename`; `REPORTS.mainnet` filled with `MAINNET_ARTIFACT_HASH` + `MAINNET_TERMS_HASH` + correct paths; mainnet guard in `classifyArtifact` and `selectTerms` uses `KNOWN_TESTNET_HASHES.has(h)` (covers test-pool hashes too).
- `server/constants.ts`: added `MAINNET_ARTIFACT_HASH`, `MAINNET_TERMS_HASH`, `ARC_MAINNET_CHAIN_ID` re-export.
- `server/core/delivery.ts`: `DeliveryConfig` gains required `artifactHash` field; `deliverFile` now checks `config.artifactHash` instead of the imported testnet constant.
- `server/index.ts`: picks artifact filename and terms path from `REPORTS[NETWORK.key]`; startup integrity check uses `reportConfig.artifactHash`; `DeliveryCore` receives `artifactHash` from `reportConfig`; fails fast with clear error if REPORTS is null for the active network.
- `server/validateConfig.ts`: "REPORTS.mainnet is null" message is now generic ("Report is not configured for {network}"); mainnet with correct hashes now passes.
- `src/lib/DeliveryController.ts`: default `artifactHash` comes from `REPORTS[NETWORK.key]`; download filename from `REPORTS[NETWORK.key].downloadFilename`.
- `src/components/ResourceCard.tsx`: manifest and preview fetched from `REPORTS[NETWORK.key]` paths, not hardcoded constants.
- `scripts/assert-build-env.ts`: check 6 changed from "REPORTS.mainnet non-null" to "network-specific artifact file present in server/private/".
- `Dockerfile`: artifact assertion is network-aware (sh conditional on `$VITE_REFLOW_NETWORK`).

**Private files (gitignored, verified byte-exact):**
- `server/private/arc-activity-report-v1.json` — testnet, ARTIFACT_HASH = `0x9f133...`
- `server/private/arc-activity-report-mainnet-v1.json` — mainnet, MAINNET_ARTIFACT_HASH = `0x2027...`

**Public files (served statically):**
- `public/report-v1/`: `manifest.json`, `terms.md`, `preview.json` (testnet)
- `public/report-mainnet-v1/`: `manifest.json`, `terms.md`, `preview.json` (mainnet)

**NOT tested:** `docker build` and `fly deploy` have NOT been run. Review `Dockerfile` and `fly.toml` before your first deploy.

**Honest limits:**
- The server can run locally (`bun run server`) or hosted via Fly.io (`SERVE_STATIC=true`). `docker build` and `fly deploy` were not run by Arc Studio; validate `Dockerfile` and `fly.toml` before your first deploy.
- EOA signatures only (viem verifyMessage). EIP-1271 / smart-contract wallets not supported.
- In-memory nonce store. Resets on restart.
- Delivery cannot stop a member from copying the received file.
