# Reflow architecture

## Pitch
Reflow settles shared purchases on Arc. The first buyer pays the provider the full price; each later buyer pays an equal share of the total; the difference is credited to earlier buyers as rebates they can claim. Net contributions end up equal to within one micro-USDC. The contract has no owner, no upgrade path and no admin sweep.

## Components
- **`ReflowPools` contract** (Solidity 0.8.28, OpenZeppelin 5.1): pools, member records, rebate accounting, claims. `usdc` is immutable and the constructor requires the token's `decimals()` to be 6. The provider cannot buy or join their own pool.
- **React app** (Vite): reads pool and membership from the chain, shows the terms hash verified against the chain before purchase, and drives purchase, join, claim and unlock through a transaction-safety layer.
- **Delivery server** (Bun): releases the private report to members. Single-use nonce, byte-identical signed message, EOA signature check, on-chain membership, on-chain `artifactHash` must equal the hash of the file it holds, short-lived HMAC token, membership re-checked at delivery.
- **Report and terms**: a public manifest, preview and license terms under `public/`; the private file's keccak256 and the terms' keccak256 are committed on chain at pool creation.

## State on chain
`pools[poolId]`: provider, price, artifactHash, termsHash, deadline, cap, member count, exists. `members[poolId][address]`: joinOrder, grossPaid, rebatesAllocated, rebatesClaimed, isMember. Equal share for `n` members and total `C`: `floor(C/n)` plus one micro-USDC for the first `C mod n` members.

## Flows that matter
1. **Create pool**: provider calls `createPool(price, artifactHash, termsHash, deadline, cap)` from the admin screen after a three-way hash check (committed constant, server commitment, browser-computed terms hash).
2. **First purchase**: buyer approves USDC, then `purchaseFirst`; the price goes straight to the provider.
3. **Join and claim**: `join(poolId, expectedCount, maxContribution)` guards against the pool changing under the buyer; `claimFor` pays out credited rebates.
4. **Unlock**: sign, server checks the chain, token, download, the app hashes the file and compares it to the on-chain `artifactHash`.

## Stack and why
Foundry for fast, fuzzable contract tests. viem for typed chain access. Vite for a static build that any host can serve. Bun for a small server with the same TypeScript. USDC is both payment and gas on Arc, so buyers need one asset.

## Out of scope
Fiat on-ramps, smart-contract-wallet signatures for unlock, a multi-instance delivery server, a contract audit, and a hosted delivery service behind the public link.

## Milestones
M1 contract and review on Arc Testnet; M2 app, transaction safety and delivery on Arc Testnet; M3 Arc Mainnet release (deploy, pool, purchase, hosted app); M4 submission.
