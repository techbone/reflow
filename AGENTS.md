# Reflow

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

Reflow M1: a Solidity settlement contract for shared purchases where later buyers reimburse earlier ones. Providers create pools; the first buyer pays full price C directly to the provider; each subsequent buyer pays a decreasing share and the difference is credited to all earlier members, claimable at any time via `claimFor`. Equal-share formula: `floor(C/n) + (i < C%n ? 1 : 0)`. No fees, no upgrades, no admin sweep.

## M1 Status

Completed. All 6 review gaps addressed and corrections verified. 86/86 tests passing (forge test, solc 0.8.28, OZ 5.1.0).
See `docs/M1_REVIEW.md` for the full review report.

**Contract:** `contracts/ReflowPools.sol`
**Unit tests:** `contracts/test/ReflowPools.t.sol` (54 tests, 2 fuzz suites)
**Regression tests:** `contracts/test/ReflowReview.t.sol` (32 tests, 2 fuzz suites)

NOT YET deployed. Real deployments must use Arc USDC: `0x3600000000000000000000000000000000000000` (Arc Testnet / Arc Mainnet). The constructor validates that the token is a contract with `decimals() == 6`; USDC identity verification is a separate deployment responsibility.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## To Run

```bash
bun install
bun run dev
```
