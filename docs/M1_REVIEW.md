# Reflow M1 Review Report

**Date:** 2026-10-18 (revised after independent local verification)
**Scope:** `contracts/ReflowPools.sol` (M1 implementation)
**Compiler:** solc 0.8.28 (Foundry, evm_version paris, optimizer 200 runs)
**OpenZeppelin:** 5.1.0 (pinned in `package.json`)
**Test command:** `forge test -v`
**Result:** 86 / 86 passed, 0 failed
  — 54 tests in `ReflowPools.t.sol` (2 fuzz suites)
  — 32 tests in `ReflowReview.t.sol` (2 fuzz suites)
  — 4 fuzz suites total × 256 runs each

---

## Summary of Changes

Six concrete gaps were identified and fixed in `contracts/ReflowPools.sol`. No new contract
features were added. The equal-share formula, fixed recipients, unique participants,
immutable terms, no-fees, and no-upgrade invariants are preserved.

---

## Gap 1 — `purchaseFirst` unguarded; CEI violated in both `purchaseFirst` and `join`

**Finding:** `purchaseFirst` lacked `nonReentrant`. Both `purchaseFirst` and `join` in the
original code called `safeTransferFrom` / `safeTransfer` before recording all effects. A
callback inside `transferFrom` could have re-entered `purchaseFirst` to register a second
"first buyer", or re-entered `join` while membership was only partially written.

**Fix:**
- Added `nonReentrant` to `purchaseFirst`.
- Moved all state writes in `purchaseFirst` (`members`, `_memberByOrder`, `pool_.count = 1`)
  to the Effects phase before `safeTransferFrom`.
- Moved `_distributeCredits` and all membership writes in `join` to the Effects phase before
  `safeTransferFrom`. (The original `join` also had a CEI violation: credits and membership
  were written after the token pull.)

**Tests added (ReflowReview.t.sol):**
`test_Reentrancy_PurchaseFirst_AttemptsPurchaseFirst` — reentry into same pool, exact selector.
`test_Reentrancy_PurchaseFirst_AttemptsJoinOnEmptyPool` — reentry into purchaseFirst on a
second real empty pool; exact `ReentrancyGuardReentrantCall` selector; no phantom membership.
`test_Reentrancy_Join_AttemptsJoinSamePool` — reentry into join on same pool, exact selector.
`test_Reentrancy_Join_AttemptsPurchaseFirstOnEmptyPool` — reentry into purchaseFirst on a
second empty pool during join's transferFrom; exact selector; no phantom membership.
`test_Reentrancy_ClaimFor_AssertsSelectorAndNoDoublePayment` — reentry into claimFor during
outbound transfer; exact selector; buyer receives exactly one payment.

All five assert: (a) callback fired, (b) outer call succeeded, (c) reentry rejected,
(d) exact `ReentrancyGuardReentrantCall()` selector, (e) no phantom count or membership.

---

## Gap 2 — Constructor accepted EOAs and wrong-decimal tokens

**Finding:** The constructor only checked `address(0)`. An EOA, or any contract without a
`decimals()` returning 6, was silently accepted.

**Fix:**
- `extcodesize` check before the decimals call → `TokenNotContract` for EOAs.
  (Zero address is caught first by `ZeroAddress`, so `TokenNotContract` is only reached
  for non-zero addresses that are not contracts.)
- `try IERC20Metadata(usdcToken).decimals()` with `catch` → `TokenMissingDecimalsInterface`
  when the call reverts or the function is absent.
- `if (dec != 6) revert TokenDecimalsNot6(dec)`.

**Note:** This is a correctness guard, not USDC authentication. A token can implement
`decimals()` returning 6 while lying about transfers. Verifying the canonical USDC contract
address remains a separate deployment responsibility.

**Tests added:** `test_Constructor_ZeroAddress`, `test_Constructor_EOA`,
`test_Constructor_NoDecimalsInterface`, `test_Constructor_RevertingDecimalsInterface`,
`test_Constructor_WrongDecimals_18`, `test_Constructor_ValidSixDecimalToken`.

---

## Gap 3 — `quoteJoin` ignored `participant`; accepted invalid pool states

**Finding:** `quoteJoin` ignored its `participant` argument (the line `participant;` was a
no-op), accepted empty pools, didn't check deadlines, and returned the next count (not the
`expectedCount` that `join` requires).

**Fix:**
- Enforced all `join` eligibility checks: `PoolDoesNotExist`, `DeadlinePassed`,
  `ZeroParticipant`, `SelfParticipant`, `ProviderCannotParticipate`, `AlreadyMember`,
  `FirstPurchaseRequired`, `CapReached`.
- Return value `expectedCount` now returns the current count, which is exactly what
  `join(poolId, expectedCount, ...)` expects.
- Two new errors: `ZeroParticipant` and `SelfParticipant`.

**Tests added:** Seven `test_QuoteJoin_Rejects_*` tests covering each rejection path;
`test_QuoteJoin_ReturnsCurrentCountAsExpectedCount` confirms the returned value feeds
directly into `join` without adjustment; `test_Join_ExactDeadline_Reverts`;
`test_ClaimFor_WorksAfterDeadline`; `test_ClaimFor_WorksAfterCapFilled`.

---

## Gap 4 — No `totalLiability`; global liability tracking missing

**Finding:** Only per-pool `poolLiability` existed. The spec requires a global
`totalLiability` view for cross-pool solvency observability.

**Fix:** Added `uint256 public totalLiability`. It is incremented atomically with
`poolLiability` inside `_distributeCredits` and decremented atomically inside `claimFor`.
No admin sweep or withdrawal was introduced.

**Note:** `totalLiability` improves observability. It does not by itself prevent an
incorrectly configured token from misreporting balances or transfers.

**Tests added:** `test_TwoFundedPools_TotalLiability_InterleavedDonation` verifies
`totalLiability == poolLiability[A] + poolLiability[B]` after every join, every claim,
and a direct token donation. Net cost and token balance reconciliation at each step.
`testFuzz_BoundedLifecycle_16Buyers` checks `totalLiability == poolLiability[poolId]` at
every join and every interleaved claim, including provider balance delta assertion.

---

## Gap 5 — Empty test and swallowed reentrancy result in `ReflowPools.t.sol`

**Finding:**
- `test_Revert_QuoteJoin_CapReached` had no assertions (210 gas body, always passed).
- `test_Reentrancy_ClaimFor` swallowed the reentry result in a `catch {}` block, so it
  passed regardless of whether the guard rejected the callback or not.
- `ReentrantClaimer` was completely empty, unused scaffolding.

**Fixes:**
- Removed `ReentrantClaimer`.
- Replaced the empty `test_Revert_QuoteJoin_CapReached` with a comment; coverage is
  provided by the adjacent `test_Revert_QuoteJoin_CapReached_Dynamic`.
- `ReentrantToken.transfer` now stores `reentryOk` / `reentryErrData` and the test
  asserts callback fired, outer call succeeded, `reentryOk == false`, and selector is
  `ReentrancyGuardReentrantCall()`.

**Tests added:**
`test_ClaimFor_RecipientBlocked_OtherMembersUnaffected` — buyer1 blocked as transfer
recipient throughout; buyer3 and buyer4 join within cap-4; buyer2 claims successfully while
buyer1 remains blocked; buyer1's credit grows correctly; both liabilities correct at every
step; block cleared only at end for recovery claim.
`test_ClaimFor_FalseReturnTransfer_PreservesCredit` — false-returning `transfer` rolls back
via SafeERC20; credit, poolLiability, totalLiability intact; retry succeeds.

---

## Gap 6 — Fuzz lifecycle capped at 6, no interleaving, no `totalLiability` check

**Finding:** `testFuzz_FullLifecycle` in `ReflowPools.t.sol` capped `n` at 6, claimed only
after all joins, and did not assert `totalLiability`.

**Fix:** Added `testFuzz_BoundedLifecycle_16Buyers` in `ReflowReview.t.sol`:
- `n` from 2 to 16 (full spec range).
- `claimSeed` drives which members claim between consecutive joins (deterministic from fuzz
  input).
- Asserts `totalLiability == poolLiability[poolId]` and contract balance covers
  `poolLiability` at every step.
- Asserts `usdc.balanceOf(provider) - providerBalBefore == C_` (balance delta snapshot,
  not a proxy via `grossPaid`).
- Net share equality for every member after full drain.

Added `test_ShareOf_MaxUint256_NoOverflow` and `testFuzz_ShareOf_PureMath_WideRange` for
pure share math up to `type(uint256).max` without deploying a token with that supply.

---

## Concrete Additional Issues Found During Review

1. **`block.timestamp` lint warnings:** Foundry emits four warnings on deadline comparisons.
   Expected for any time-gated contract; no fix required for M1.

2. **`uint8` cast lint warning:** `pool_.count = uint8(newCount)` generates a warning.
   Safe by construction: `cap <= 16` is enforced at pool creation and `newCount <= cap`.

3. **`assert` in `_distributeCredits`:** In Solidity 0.8 with the default optimizer and
   EVM >= Berlin, `assert` compiles to a `REVERT` with a `Panic(uint256)` payload — it
   does NOT consume all remaining gas (that was pre-0.8 / pre-Byzantium behavior). The
   two asserts (`memberAddr != address(0)` and `totalCredits == newShare`) are internal
   invariants that cannot fail with valid input; a named-error `revert` would be more
   debuggable in production. Left as `assert` for M1 per spec.

4. **Donation surplus is permanently locked:** Token sent directly to the contract
   accumulates in `balanceOf(address(this))` but is not recoverable. By design for M1
   (no admin sweep). `test_TwoFundedPools_*` asserts the surplus explicitly.

5. **`quoteJoin` staleness:** A quote obtained off-chain may be stale by the time `join`
   is called. `CountMismatch` is the correct protection; callers must handle it. Documented
   in `quoteJoin`'s NatSpec.

6. **Provider cannot purchase their own pool:** Intentional per spec. Enforced in both
   `purchaseFirst` and `join`. Confirmed by existing tests.

---

## Unresolved Integration Checks (out of scope for M1)

- **USDC address authentication:** The constructor validates `decimals() == 6` but not
  identity. Before any deployment, the deployer must independently verify the address against
  the canonical Arc USDC (`0x3600000000000000000000000000000000000000`).
- **Gas cost at 16 members:** `_distributeCredits` is O(n). At n=16 the final join runs the
  loop 15 times. Not profiled against Arc block limits for M1.
- **Upgrade / ownership:** No upgrade mechanism exists by design. Future migrations require
  a new deployment.

---

## Changed Files

| File | Change |
|---|---|
| `contracts/ReflowPools.sol` | All 6 fixes. `nonReentrant` + CEI on `purchaseFirst`. CEI on `join`. `quoteJoin` eligibility enforcement. `totalLiability`. Constructor metadata validation. New errors: `ZeroParticipant`, `SelfParticipant`, `TokenNotContract`, `TokenMissingDecimalsInterface`, `TokenDecimalsNot6`. |
| `contracts/test/ReflowPools.t.sol` | Removed `ReentrantClaimer`. Replaced empty test with comment. `ReentrantToken` records reentry result. `test_Reentrancy_ClaimFor` asserts selector. |
| `contracts/test/ReflowReview.t.sol` | New file. 34 targeted regression tests (2 fuzz suites). |
| `docs/M1_REVIEW.md` | This file. |
| `AGENTS.md` | Project name and M1 status updated. |

---

## What This Review Does NOT Claim

- Production readiness or audit certification.
- Coverage of all possible attack vectors.
- Safety against a malicious token that lies about transfer execution.
