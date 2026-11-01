/**
 * Unit tests for txLifecycle.ts
 *
 * Tests use real ABI-encoded log data via viem's encodeEventTopics and
 * encodeAbiParameters — the same ABI entries the live verifier uses.
 * No RPC mocking, no wagmi hooks, no hand-copied selector constants.
 *
 * Fixtures are explicitly labelled as synthetic — not real network data.
 * Tests must exercise the EXACT helpers used by the live UI; a test that
 * copies an implementation's wrong constant proves nothing.
 */

import { describe, it, expect } from 'vitest'
import { encodeEventTopics, encodeAbiParameters, erc20Abi } from 'viem'
import { REFLOW_POOLS_ABI } from '../lib/reflowAbi'
import {
  txReducer,
  INITIAL_TX_STATE,
  validatePendingContext,
  verifyReceipt,
  classifyError,
  PENDING_VERSION,
  savePendingContext,
  clearPendingContext,
  restorePendingContext,
  type PendingContext,
  type TxEvent,
} from '../lib/txLifecycle'
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC } from '../lib/reflowConfig'

// ── Test fixtures ──────────────────────────────────────────────────────────────

const CONTRACT  = '0x1111111111111111111111111111111111111111' as `0x${string}`
const WALLET    = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`
const POOL_ID   = 1n
const PRICE     = 1_200_000n
const TX_HASH   = ('0x' + 'ab'.repeat(32)) as `0x${string}`

function makePending(overrides: Partial<PendingContext> = {}): PendingContext {
  return {
    version:         PENDING_VERSION,
    hash:            TX_HASH,
    chainId:         ARC_TESTNET_CHAIN_ID,
    contractAddress: CONTRACT,
    poolId:          POOL_ID.toString(),
    walletAddress:   WALLET,
    action:          'purchaseFirst',
    expectedAmount:  PRICE.toString(),
    ...overrides,
  }
}

function makeReceipt(
  status: 'success' | 'reverted',
  logs: { address: `0x${string}`; topics: `0x${string}`[]; data: `0x${string}` }[],
  txHash?: `0x${string}`,
) {
  return { status, logs, transactionHash: txHash ?? TX_HASH } as unknown as import('viem').TransactionReceipt
}

/**
 * Encode a FirstPurchased log using the real ABI via encodeEventTopics.
 *
 * FirstPurchased(uint256 indexed poolId, address indexed buyer, uint256 amount)
 * Indexed:     topic[0] = selector, topic[1] = poolId, topic[2] = buyer
 * Non-indexed: data = abi.encode(amount)
 */
function encodeFirstPurchasedLog(poolId: bigint, buyer: `0x${string}`, amount: bigint) {
  const topics = encodeEventTopics({
    abi: REFLOW_POOLS_ABI,
    eventName: 'FirstPurchased',
    args: { poolId, buyer },
  }) as `0x${string}`[]
  const data = encodeAbiParameters(
    [{ name: 'amount', type: 'uint256' }],
    [amount],
  )
  return { address: CONTRACT, topics, data }
}

/**
 * Encode a Joined log using the real ABI via encodeEventTopics.
 *
 * Joined(uint256 indexed poolId, address indexed participant, uint256 joinOrder, uint256 contribution)
 * Indexed:     topic[0] = selector, topic[1] = poolId, topic[2] = participant
 * Non-indexed: data = abi.encode(joinOrder, contribution)
 */
function encodeJoinedLog(
  poolId: bigint, participant: `0x${string}`, joinOrder: bigint, contribution: bigint,
) {
  const topics = encodeEventTopics({
    abi: REFLOW_POOLS_ABI,
    eventName: 'Joined',
    args: { poolId, participant },
  }) as `0x${string}`[]
  const data = encodeAbiParameters(
    [{ name: 'joinOrder', type: 'uint256' }, { name: 'contribution', type: 'uint256' }],
    [joinOrder, contribution],
  )
  return { address: CONTRACT, topics, data }
}

/**
 * Encode a RebateClaimed log using the real ABI via encodeEventTopics.
 *
 * RebateClaimed(uint256 indexed poolId, address indexed beneficiary, uint256 amount)
 * Indexed:     topic[0] = selector, topic[1] = poolId, topic[2] = beneficiary
 * Non-indexed: data = abi.encode(amount)
 */
function encodeRebateClaimedLog(poolId: bigint, beneficiary: `0x${string}`, amount: bigint) {
  const topics = encodeEventTopics({
    abi: REFLOW_POOLS_ABI,
    eventName: 'RebateClaimed',
    args: { poolId, beneficiary },
  }) as `0x${string}`[]
  const data = encodeAbiParameters(
    [{ name: 'amount', type: 'uint256' }],
    [amount],
  )
  return { address: CONTRACT, topics, data }
}

/**
 * Encode an ERC-20 Approval log using erc20Abi via encodeEventTopics.
 *
 * Approval(address indexed owner, address indexed spender, uint256 value)
 */
function encodeApprovalLog(owner: `0x${string}`, spender: `0x${string}`, value: bigint) {
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: 'Approval',
    args: { owner, spender },
  }) as `0x${string}`[]
  const data = encodeAbiParameters(
    [{ name: 'value', type: 'uint256' }],
    [value],
  )
  return { address: ARC_TESTNET_USDC as `0x${string}`, topics, data }
}

// ── Reducer tests ──────────────────────────────────────────────────────────────

describe('txReducer', () => {
  it('starts in idle', () => {
    expect(INITIAL_TX_STATE.phase).toBe('idle')
  })

  it('PREFLIGHT_START → preflight', () => {
    const s = txReducer(INITIAL_TX_STATE, { type: 'PREFLIGHT_START' })
    expect(s.phase).toBe('preflight')
    expect(s.errorMsg).toBe('')
  })

  it('PREFLIGHT_FAIL → error with message', () => {
    const s = txReducer(INITIAL_TX_STATE, { type: 'PREFLIGHT_FAIL', msg: 'bad config' })
    expect(s.phase).toBe('error')
    expect(s.errorMsg).toBe('bad config')
  })

  it('TX_SUBMITTED stores context', () => {
    const ctx = makePending()
    const s = txReducer(INITIAL_TX_STATE, { type: 'TX_SUBMITTED', ctx })
    expect(s.phase).toBe('confirming')
    expect(s.pending?.hash).toBe(TX_HASH)
  })

  it('SUCCESS clears pending and stores confirmed hash', () => {
    const withPending = txReducer(INITIAL_TX_STATE, { type: 'TX_SUBMITTED', ctx: makePending() })
    const s = txReducer(withPending, { type: 'SUCCESS', hash: TX_HASH, action: 'purchaseFirst', amount: PRICE.toString() })
    expect(s.phase).toBe('success')
    expect(s.pending).toBeNull()
    expect(s.confirmedHash).toBe(TX_HASH)
    expect(s.confirmedAmount).toBe(PRICE.toString())
  })

  it('RPC_TIMEOUT keeps pending hash intact — no resubmission bypass', () => {
    const ctx = makePending()
    let s = txReducer(INITIAL_TX_STATE, { type: 'TX_SUBMITTED', ctx })
    s = txReducer(s, { type: 'RPC_TIMEOUT', msg: 'timeout' })
    expect(s.phase).toBe('rpc-recovery')
    expect(s.pending?.hash).toBe(TX_HASH)  // hash preserved for reconciliation
  })

  it('REFRESH during rpc-recovery keeps pending hash — must not discard unresolved hash', () => {
    const ctx = makePending()
    let s = txReducer(INITIAL_TX_STATE, { type: 'TX_SUBMITTED', ctx })
    s = txReducer(s, { type: 'RPC_TIMEOUT', msg: 'timeout' })
    expect(s.phase).toBe('rpc-recovery')
    expect(s.pending?.hash).toBe(TX_HASH)
    // REFRESH from rpc-recovery must NOT drop the hash
    s = txReducer(s, { type: 'REFRESH' })
    expect(s.phase).toBe('rpc-recovery')
    expect(s.pending?.hash).toBe(TX_HASH)
  })

  it('REFRESH from idle clears pending normally', () => {
    const s = txReducer(INITIAL_TX_STATE, { type: 'REFRESH' })
    expect(s.phase).toBe('idle')
    expect(s.pending).toBeNull()
  })

  it('TX_FAILED clears pending', () => {
    const ctx = makePending()
    let s = txReducer(INITIAL_TX_STATE, { type: 'TX_SUBMITTED', ctx })
    s = txReducer(s, { type: 'TX_FAILED', msg: 'reverted' })
    expect(s.phase).toBe('error')
    expect(s.pending).toBeNull()
  })

  it('USER_REJECTED → idle, no error', () => {
    const s = txReducer({ ...INITIAL_TX_STATE, phase: 'signing' }, { type: 'USER_REJECTED' })
    expect(s.phase).toBe('idle')
    expect(s.errorMsg).toBe('')
  })

  it('WALLET_CHANGED with pending → wrong-wallet, pending preserved', () => {
    const ctx = makePending()
    let s = txReducer(INITIAL_TX_STATE, { type: 'TX_SUBMITTED', ctx })
    s = txReducer(s, { type: 'WALLET_CHANGED' })
    expect(s.phase).toBe('wrong-wallet')
    expect(s.pending).not.toBeNull()  // preserved for recovery — never discarded on wallet change
    expect(s.pending?.hash).toBe(TX_HASH)
  })

  it('WALLET_CHANGED without pending → idle', () => {
    const s = txReducer(INITIAL_TX_STATE, { type: 'WALLET_CHANGED' })
    expect(s.phase).toBe('idle')
  })

  it('STALE_QUOTE clears pending', () => {
    const ctx = makePending({ action: 'join', expectedCount: '1' })
    let s = txReducer(INITIAL_TX_STATE, { type: 'TX_SUBMITTED', ctx })
    s = txReducer(s, { type: 'STALE_QUOTE', msg: 'count changed' })
    expect(s.phase).toBe('stale-quote')
    expect(s.pending).toBeNull()
  })

  it('APPROVAL_DONE clears pending', () => {
    const ctx = makePending({ action: 'approve', approvalSpender: CONTRACT })
    let s = txReducer(INITIAL_TX_STATE, { type: 'TX_SUBMITTED', ctx })
    s = txReducer(s, { type: 'APPROVAL_DONE' })
    expect(s.phase).toBe('approval-done')
    expect(s.pending).toBeNull()
  })

  it('isBusy phases: preflight/signing/confirming all block duplicate submissions', () => {
    const busyPhases: TxEvent['type'][] = ['PREFLIGHT_START', 'SIGNING', 'CONFIRMING']
    for (const evType of busyPhases) {
      const s = txReducer(INITIAL_TX_STATE, { type: evType } as TxEvent)
      expect(['preflight', 'signing', 'confirming']).toContain(s.phase)
    }
  })
})

// ── PendingContext validation ──────────────────────────────────────────────────

describe('validatePendingContext', () => {
  it('accepts a valid purchaseFirst context', () => {
    expect(validatePendingContext(makePending())).not.toBeNull()
  })

  it('accepts a valid approve context with approvalSpender', () => {
    expect(validatePendingContext(makePending({ action: 'approve', approvalSpender: CONTRACT }))).not.toBeNull()
  })

  it('rejects approve context missing approvalSpender', () => {
    const ctx = { ...makePending(), action: 'approve' }
    delete (ctx as Partial<PendingContext>).approvalSpender
    expect(validatePendingContext(ctx)).toBeNull()
  })

  it('rejects wrong version', () => {
    expect(validatePendingContext({ ...makePending(), version: 1 })).toBeNull()
  })

  it('rejects wrong chainId', () => {
    expect(validatePendingContext({ ...makePending(), chainId: 1 })).toBeNull()
  })

  it('rejects bad tx hash (too short)', () => {
    expect(validatePendingContext({ ...makePending(), hash: '0xdeadbeef' })).toBeNull()
  })

  it('rejects bad contract address', () => {
    expect(validatePendingContext({ ...makePending(), contractAddress: '0xinvalid' })).toBeNull()
  })

  it('rejects unknown action', () => {
    expect(validatePendingContext({ ...makePending(), action: 'hack' })).toBeNull()
  })

  it('rejects non-decimal poolId', () => {
    expect(validatePendingContext({ ...makePending(), poolId: 'abc' })).toBeNull()
  })

  it('rejects zero poolId (non-positive)', () => {
    expect(validatePendingContext({ ...makePending(), poolId: '0' })).toBeNull()
  })
})

// ── Pending sessionStorage round-trip ─────────────────────────────────────────

describe('pending sessionStorage', () => {
  it('saves and restores a valid context', () => {
    const ctx = makePending()
    savePendingContext(ctx)
    const restored = restorePendingContext()
    expect(restored).not.toBeNull()
    expect(restored?.hash).toBe(ctx.hash)
    expect(restored?.walletAddress).toBe(WALLET)
    clearPendingContext()
  })

  it('returns null after clear', () => {
    savePendingContext(makePending())
    clearPendingContext()
    expect(restorePendingContext()).toBeNull()
  })

  it('returns null when storage has garbage', () => {
    sessionStorage.setItem('reflow_pending_v2', 'not-json{')
    expect(restorePendingContext()).toBeNull()
    clearPendingContext()
  })

  it('returns null when context has wrong version', () => {
    sessionStorage.setItem('reflow_pending_v2', JSON.stringify({ ...makePending(), version: 99 }))
    expect(restorePendingContext()).toBeNull()
    clearPendingContext()
  })
})

// ── Receipt verification — purchaseFirst ──────────────────────────────────────

describe('verifyReceipt — purchaseFirst', () => {
  it('accepts correct FirstPurchased event (ABI-encoded)', () => {
    const ctx = makePending()
    const log = encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(true)
    expect(result.amount).toBe(PRICE.toString())
  })

  it('rejects reverted receipt despite success-looking args', () => {
    const ctx = makePending()
    const log = encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE)
    const receipt = makeReceipt('reverted', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/reverted/i)
  })

  it('rejects wrong pool ID in event', () => {
    const ctx = makePending()
    const log = encodeFirstPurchasedLog(999n, WALLET, PRICE)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/poolId/i)
  })

  it('rejects wrong buyer address', () => {
    const ctx = makePending()
    const otherWallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`
    const log = encodeFirstPurchasedLog(POOL_ID, otherWallet, PRICE)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/buyer/i)
  })

  it('rejects wrong amount', () => {
    const ctx = makePending()
    const log = encodeFirstPurchasedLog(POOL_ID, WALLET, 999n)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/amount/i)
  })

  it('rejects event from wrong emitter address', () => {
    const ctx = makePending()
    const log = { ...encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE), address: '0x9999999999999999999999999999999999999999' as `0x${string}` }
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/not found/i)
  })

  it('rejects receipt with no matching logs', () => {
    const ctx = makePending()
    const receipt = makeReceipt('success', [])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
  })

  it('rejects receipt whose txHash does not match context', () => {
    const ctx = makePending()
    const log = encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE)
    const wrongHash = ('0x' + 'cc'.repeat(32)) as `0x${string}`
    const receipt = makeReceipt('success', [log], wrongHash)
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/transaction hash/i)
  })
})

// ── Receipt verification — join ───────────────────────────────────────────────

describe('verifyReceipt — join', () => {
  it('accepts correct Joined event (ABI-encoded)', () => {
    const ctx = makePending({ action: 'join', expectedAmount: '600000', expectedCount: '1' })
    // joinOrder == expectedCount (1n) — the contract uses the count as joinOrder
    const log = encodeJoinedLog(POOL_ID, WALLET, 1n, 600_000n)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(true)
    expect(result.amount).toBe('600000')
  })

  it('rejects wrong participant', () => {
    const ctx = makePending({ action: 'join', expectedAmount: '600000', expectedCount: '1' })
    const other = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`
    const log = encodeJoinedLog(POOL_ID, other, 1n, 600_000n)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/participant/i)
  })

  it('rejects wrong contribution amount', () => {
    const ctx = makePending({ action: 'join', expectedAmount: '600000', expectedCount: '1' })
    const log = encodeJoinedLog(POOL_ID, WALLET, 1n, 500_000n)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/contribution/i)
  })

  it('rejects mismatched joinOrder vs expectedCount', () => {
    // Context says expectedCount=1 (i.e. joinOrder should be 1n)
    // but the event has joinOrder=2n — indicates a race condition or stale quote
    const ctx = makePending({ action: 'join', expectedAmount: '400000', expectedCount: '1' })
    const log = encodeJoinedLog(POOL_ID, WALLET, 2n, 400_000n)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/joinOrder/i)
  })
})

// ── Receipt verification — claimFor ──────────────────────────────────────────

describe('verifyReceipt — claimFor', () => {
  it('accepts claim amount equal to expected minimum', () => {
    const ctx = makePending({ action: 'claimFor', expectedAmount: '600000' })
    const log = encodeRebateClaimedLog(POOL_ID, WALLET, 600_000n)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(true)
    expect(result.amount).toBe('600000')
  })

  it('accepts legitimately larger claim (another join mined first)', () => {
    const ctx = makePending({ action: 'claimFor', expectedAmount: '600000' })
    const log = encodeRebateClaimedLog(POOL_ID, WALLET, 700_000n)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(true)
    expect(result.amount).toBe('700000')
    expect(BigInt(result.amount)).toBeGreaterThan(600_000n)
  })

  it('rejects claim amount below pre-flight minimum', () => {
    const ctx = makePending({ action: 'claimFor', expectedAmount: '600000' })
    const log = encodeRebateClaimedLog(POOL_ID, WALLET, 100_000n)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/below expected/i)
  })

  it('rejects wrong beneficiary', () => {
    const ctx = makePending({ action: 'claimFor', expectedAmount: '600000' })
    const other = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`
    const log = encodeRebateClaimedLog(POOL_ID, other, 600_000n)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/beneficiary/i)
  })

  it('rejects wrong pool ID in claim event', () => {
    const ctx = makePending({ action: 'claimFor', expectedAmount: '600000' })
    const log = encodeRebateClaimedLog(999n, WALLET, 600_000n)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/poolId/i)
  })
})

// ── Receipt verification — approve ────────────────────────────────────────────

describe('verifyReceipt — approve', () => {
  it('accepts valid Approval event with exact value', () => {
    const ctx = makePending({ action: 'approve', expectedAmount: PRICE.toString(), approvalSpender: CONTRACT })
    const log = encodeApprovalLog(WALLET, CONTRACT, PRICE)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(true)
  })

  it('rejects approval with wrong spender', () => {
    const ctx = makePending({ action: 'approve', expectedAmount: PRICE.toString(), approvalSpender: CONTRACT })
    const wrongSpender = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`
    const log = encodeApprovalLog(WALLET, wrongSpender, PRICE)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/spender/i)
  })

  it('rejects approval with wrong owner', () => {
    const ctx = makePending({ action: 'approve', expectedAmount: PRICE.toString(), approvalSpender: CONTRACT })
    const otherOwner = '0xffffffffffffffffffffffffffffffffffffffff' as `0x${string}`
    const log = encodeApprovalLog(otherOwner, CONTRACT, PRICE)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/owner/i)
  })

  it('rejects approval with wrong exact value (different from context expectedAmount)', () => {
    const ctx = makePending({ action: 'approve', expectedAmount: PRICE.toString(), approvalSpender: CONTRACT })
    // Approve a different amount than expected
    const log = encodeApprovalLog(WALLET, CONTRACT, PRICE + 1n)
    const receipt = makeReceipt('success', [log])
    const result = verifyReceipt(receipt, ctx, ARC_TESTNET_USDC)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(/value/i)
  })
})

// ── Error classification ───────────────────────────────────────────────────────

describe('classifyError', () => {
  it('classifies user rejection', () => {
    expect(classifyError({ code: 4001 })).toMatchObject({ type: 'USER_REJECTED' })
    expect(classifyError(new Error('user rejected the request'))).toMatchObject({ type: 'USER_REJECTED' })
  })

  it('classifies RPC timeout', () => {
    expect(classifyError(new Error('fetch failed: timeout'))).toMatchObject({ type: 'RPC_TIMEOUT' })
  })

  it('classifies stale quote (CountMismatch)', () => {
    expect(classifyError(new Error('execution reverted: CountMismatch'))).toMatchObject({ type: 'STALE_QUOTE' })
  })

  it('classifies stale quote (ContributionTooHigh)', () => {
    expect(classifyError(new Error('ContributionTooHigh'))).toMatchObject({ type: 'STALE_QUOTE' })
  })

  it('classifies insufficient balance', () => {
    expect(classifyError(new Error('insufficient funds'))).toMatchObject({ type: 'TX_FAILED' })
  })

  it('classifies generic revert as TX_FAILED', () => {
    expect(classifyError(new Error('execution reverted'))).toMatchObject({ type: 'TX_FAILED' })
  })

  it('classifies unknown as TX_FAILED', () => {
    expect(classifyError(new Error('something weird'))).toMatchObject({ type: 'TX_FAILED' })
  })
})

// ── shareCalc pure math ────────────────────────────────────────────────────────

import { shareOf, arrivalShare, fmtUsdc, buildShareTable, parseUsdcStr } from '../lib/shareCalc'

describe('shareOf — contract formula', () => {
  it('1 member gets full price', () => {
    expect(shareOf(1_200_000n, 1n, 0n)).toBe(1_200_000n)
  })

  it('2 members: 600_000 each', () => {
    expect(shareOf(1_200_000n, 2n, 0n)).toBe(600_000n)
    expect(shareOf(1_200_000n, 2n, 1n)).toBe(600_000n)
  })

  it('4 members: 300_000 each', () => {
    for (let i = 0n; i < 4n; i++) {
      expect(shareOf(1_200_000n, 4n, i)).toBe(300_000n)
    }
  })

  it('3 members: 400_000 each', () => {
    for (let i = 0n; i < 3n; i++) {
      expect(shareOf(1_200_000n, 3n, i)).toBe(400_000n)
    }
  })

  it('sum of shares equals price for any n in 1..16', () => {
    const C = 1_200_000n
    for (let n = 1; n <= 16; n++) {
      const sum = Array.from({ length: n }, (_, i) => shareOf(C, BigInt(n), BigInt(i)))
        .reduce((a, b) => a + b, 0n)
      expect(sum).toBe(C)
    }
  })

  it('max uint256 — no overflow for any n in 2..16', () => {
    const C = 2n ** 200n  // large but well below uint256 max
    for (let n = 2; n <= 16; n++) {
      const sum = Array.from({ length: n }, (_, i) => shareOf(C, BigInt(n), BigInt(i)))
        .reduce((a, b) => a + b, 0n)
      expect(sum).toBe(C)
    }
  })

  it('throws for n == 0', () => {
    expect(() => shareOf(1_200_000n, 0n, 0n)).toThrow(RangeError)
  })
})

describe('arrivalShare', () => {
  it('member 2 pays 0.60', () => {
    expect(arrivalShare(1_200_000n, 2n)).toBe(600_000n)
  })
  it('member 3 pays 0.40', () => {
    expect(arrivalShare(1_200_000n, 3n)).toBe(400_000n)
  })
  it('member 4 pays 0.30', () => {
    expect(arrivalShare(1_200_000n, 4n)).toBe(300_000n)
  })
})

describe('fmtUsdc — no nonzero digit dropped', () => {
  it('formats 1_200_000 as "1.20" with 2 places', () => {
    expect(fmtUsdc(1_200_000n, 2)).toBe('1.20')
  })
  it('formats 300_000 as "0.30" with 2 places', () => {
    expect(fmtUsdc(300_000n, 2)).toBe('0.30')
  })
  it('retains all 6 nonzero digits when places=6', () => {
    expect(fmtUsdc(1_234_567n, 6)).toBe('1.234567')
  })
  it('formats 1 micro-USDC (minimum unit) with full precision', () => {
    expect(fmtUsdc(1n, 6)).toBe('0.000001')
  })
  // Regression: 16 micro-USDC must not display as 0.00
  it('16 micro-USDC shows as 0.000016 with 6 places, not 0.00', () => {
    expect(fmtUsdc(16n, 6)).toBe('0.000016')
    // 2-decimal display hides it — 6-decimal must be used for financial evidence
    expect(fmtUsdc(16n, 2)).toBe('0.00')
  })
  // Regression: 0.333334 USDC = 333334 micro-USDC — all digits must be visible
  it('0.333334 USDC = 333334 micro-USDC retains all digits with places=6', () => {
    expect(fmtUsdc(333_334n, 6)).toBe('0.333334')
    // 2-decimal display truncates to 0.33 — acceptable for illustration, not for evidence
    expect(fmtUsdc(333_334n, 2)).toBe('0.33')
  })
})

describe('parseUsdcStr (delegates to parseUsdc)', () => {
  it('parses "1.20" to 1_200_000', () => {
    expect(parseUsdcStr('1.20')).toBe(1_200_000n)
  })
  it('parses "0.30" to 300_000', () => {
    expect(parseUsdcStr('0.30')).toBe(300_000n)
  })
  it('rejects over-precision (7 decimal places)', () => {
    expect(() => parseUsdcStr('0.1234567')).toThrow()
  })
  it('parses exact 6 decimal places', () => {
    expect(parseUsdcStr('0.000001')).toBe(1n)
  })
})

describe('buildShareTable', () => {
  it('produces 4 rows for n=4', () => {
    const rows = buildShareTable(1_200_000n, 4)
    expect(rows).toHaveLength(4)
  })
  it('all net costs equal 300_000 for C=1.20, n=4', () => {
    const rows = buildShareTable(1_200_000n, 4)
    rows.forEach(r => expect(r.targetNetCost).toBe(300_000n))
  })
  it('first member gross paid equals full price', () => {
    const rows = buildShareTable(1_200_000n, 4)
    expect(rows[0].grossPaid).toBe(1_200_000n)
  })
})
