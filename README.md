# Reflow

Shared-purchase settlement for digital goods on Arc. The first buyer pays the provider the full price; later buyers pay an equal share and the difference flows back to earlier buyers as claimable rebates, so everyone converges to the same net cost. Built with [Arc Studio](https://studio.arc.io/app/29b3248b-8871-4fa5-81ec-96da70644dff) for the Arc Microgrants: Built with Arc Studio grant.

## Live on Arc Mainnet (chain id 5042)

| | |
|---|---|
| Contract `ReflowPools` | [`0x8EB21094f6cEF274a2e4E31C86CA9027f3b5F3F8`](https://explorer.arc.io/address/0x8EB21094f6cEF274a2e4E31C86CA9027f3b5F3F8) |
| Deployment tx | [`0xb3c26593…a6eab`](https://explorer.arc.io/tx/0xb3c26593931e5a1dc37ae5a4de0c874bb5e244f64108508decbae4dfea4a6eab) |
| Pool 1 creation tx | [`0xc2fd7685…7abd7`](https://explorer.arc.io/tx/0xc2fd768536a52647b53ae5feb17b5e3c58714d771295d4a9fa12004e1957abd7) (price 1.20 USDC, cap 4) |
| Example purchase tx (1.20 USDC, buyer to provider through the contract) | [`0xcccfa726…bfd320`](https://explorer.arc.io/tx/0xcccfa726b24fdefd09439a91fdf89539a514aa6e29e721426a5cc7529cbfd320) |
| USDC | `0x3600000000000000000000000000000000000000` |

The pool sells a public-data Arc activity report. Its hash and the license terms are committed on chain at pool creation (`public/report-mainnet-v1/`). The report file itself is private and released to pool members by the delivery server after a wallet signature that is checked against the chain; it is not in this repository, but the open generator is (`report/generate_report_v2.py`).

## What is here

- `contracts/ReflowPools.sol`: the settlement contract (Solidity 0.8.28, OpenZeppelin 5.1, no owner, no upgrade path, no admin sweep) and its Foundry tests.
- `src/`: the React app, including the transaction-safety layer (`src/lib/TxOrchestrator.ts`) and network guards (`src/lib/network.ts`).
- `server/`: the delivery service (single-use nonces, signature and on-chain membership checks, artifact-hash binding).
- `tools/verify_deployment.py`: read-only check that a deployed address runs exactly the reviewed build (`forge build` first).
- `Dockerfile`, `fly.toml`, `docs/DEPLOY.md`: hosting files (the image build has not been run; see `docs/DEPLOY.md`).

## Run and test

```sh
bun install
bun run dev                                  # app (set VITE_REFLOW_* in .env)
bunx tsc --noEmit -p tsconfig.json           # client typecheck
bunx vitest run src/tests/                   # client tests
bunx vitest run --config vitest.server.config.ts   # server tests
forge test                                   # contract tests
```

At the last verified export: 86 contract tests, 419 client tests and 163 server tests pass, and the app typechecks and builds. Three test files (`src/tests/deliveryClient.test.ts`, `src/tests/m3b.test.ts`, `server/tests/delivery.test.ts`) read the private report files from `server/private/`, which are not published; without them those files fail with ENOENT and everything else passes (310 client, 103 server tests).

## Honest limits

Unaudited code that handles real USDC; use small amounts. The delivery service accepts only externally owned account signatures. USDC itself can be paused or blocklisted by its issuer. Reflow is independent of Circle and Arc.
