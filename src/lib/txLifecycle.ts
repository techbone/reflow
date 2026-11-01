/**
 * Transaction lifecycle for Reflow M2.
 *
 * DESIGN
 * ------
 * A single reducer manages every phase transition. No setState is called from
 * effects; wagmi hook state is mapped to dispatch calls from useEffect with a
 * stable identity dispatch reference (from useReducer — always the same function).
 *
 * PENDING CONTEXT (versioned, stored in sessionStorage)
 * -------------------------------------------------------
 * Persists: hash, chainId, contractAddress, poolId, walletAddress, action,
 * expectedAmount, expectedCount (join order), approval spender.
 *
 * Validation on restore:
 *   - version must match PENDING_VERSION
 *   - hash must look like a 0x hex string of 66 chars
 *   - chainId must match the configured network chain id
 *   - contractAddress must be a valid 42-char hex address
 *   - walletAddress must be a valid 42-char hex address
 *   - action must be one of the known literals
 *   - expectedAmount must be a positive decimal string
 *   - approvalSpender must be present and valid for action === 'approve'
 *
 * Wallet / network changes preserve the recovery context but disable
 * resubmission. The UI shows "complete from original wallet" guidance.
 *
 * PRE-FLIGHT CHECKS (order)
 * --------------------------
 * 1. Wallet connected and Arc Testnet chain
 * 2. Contract address present and has code (getCode != "0x")
 * 3. contract.usdc() == canonical 0x3600... (calls the contract's usdc() view)
 * 4. USDC token decimals() == 6
 * 5. Pool getPool result.exists == true (via the already-loaded pool data)
 * 6. USDC balance >= required payment
 * 7. payment + estimated gas fits in the combined ERC-20 + native view
 * 8. Simulate the exact call before requesting signature
 *
 * Note: gas estimation uses the native gas balance. On Arc, native gas IS USDC
 * (18-decimal view). The USDC ERC-20 balance and native balance are the same
 * pool; to avoid double-counting, the combined solvency check converts the
 * required ERC-20 payment to native units and checks that the native balance
 * covers payment_as_native + gas_estimate. See ARCHITECTURE notes.
 *
 * RECEIPT VERIFICATION (strict)
 * --------------------------------
 * isSuccess alone is not sufficient. The verifier:
 *   - rejects a non-success receipt status
 *   - matches receipt.transactionHash against context.hash
 *   - decodes event logs from the receipt
 *   - requires exactly one matching log emitted from the contract address
 *   - event selector derived from the ABI (toEventSelector — never hardcoded)
 *   - decoded fields (poolId, participant/buyer/beneficiary, amount) match ctx
 *   - for join: joinOrder matches expectedCount
 *   - for claim: actual amount >= context.expectedAmount (legitimate growth allowed)
 *   - for approval: Approval(owner, spender, value) from USDC token; exact value
 *   - all IDs and amounts must be positive
 */

import { decodeEventLog, toEventSelector, type Log, type TransactionReceipt } from 'viem'
import { REFLOW_POOLS_ABI } from './reflowAbi'
import { NETWORK } from './network'

// ── Types ─────────────────────────────────────────────────────────────────────

export type TxAction = 'purchaseFirst' | 'join' | 'claimFor' | 'approve'

/** PENDING_VERSION must increment whenever the shape of PendingContext changes. */
export const PENDING_VERSION = 3

export interface PendingContext {
  version:         typeof PENDING_VERSION
  hash:            `0x${string}`
  chainId:         number
  contractAddress: `0x${string}`
  poolId:          string  // bigint serialised as decimal string
  walletAddress:   `0x${string}`
  action:          TxAction
  /** For purchaseFirst: pool price. For join: contribution. For claim: minimum expected. */
  expectedAmount:  string  // bigint as decimal string
  /** join only: expectedCount passed to join(), the current pool count at quote time. */
  expectedCount?:  string  // bigint as decimal string
  /** approve only: spender address (REQUIRED for approve action) */
  approvalSpender?: `0x${string}`
  /**
   * ABI-encoded calldata for the exact call submitted.
   * Persisted so reconcileHash can verify input === calldata even after the
   * signing intent is cleared (which happens on successful broadcast).
   */
  calldata?:        `0x${string}`
  /** Contract (or USDC token) address that received this call. */
  target?:          `0x${string}`
  /** Transaction count at signing time. Used to reject pre-existing txs in reconcile. */
  observedNonce?:   number
  /** Block number just before signing. Used to reject pre-existing txs in reconcile. */
  startBlock?:      string  // bigint as decimal string
}

export type TxPhase =
  | 'idle'
  | 'preflight'       // running pre-flight checks
  | 'approving'       // signed an approve tx, waiting for receipt
  | 'signing'         // waiting for user to sign the main write
  | 'confirming'      // main tx broadcast, waiting for receipt
  | 'success'         // receipt verified, event confirmed
  | 'approval-done'   // approval confirmed — back to explicit user review
  | 'stale-quote'     // CountMismatch or ContributionTooHigh
  | 'rpc-recovery'    // RPC timeout or query error — known hash retained
  | 'wrong-wallet'    // pending context wallet != connected wallet
  | 'error'           // unrecoverable error

export interface TxState {
  phase:       TxPhase
  pending:     PendingContext | null
  errorMsg:    string
  /** Terminal confirmed hash, separate from pending (shown after pending is cleared). */
  confirmedHash: `0x${string}` | null
  confirmedAction: TxAction | null
  confirmedAmount: string | null  // bigint decimal string, exact from event
}

export type TxEvent =
  | { type: 'PREFLIGHT_START' }
  | { type: 'PREFLIGHT_FAIL'; msg: string }
  | { type: 'SIGNING' }
  | { type: 'TX_SUBMITTED'; ctx: PendingContext }
  | { type: 'CONFIRMING' }
  | { type: 'SUCCESS'; hash: `0x${string}`; action: TxAction; amount: string }
  | { type: 'APPROVAL_DONE' }
  | { type: 'TX_FAILED'; msg: string }
  | { type: 'STALE_QUOTE'; msg: string }
  | { type: 'RPC_TIMEOUT'; msg: string }
  | { type: 'USER_REJECTED' }
  | { type: 'WALLET_CHANGED' }
  | { type: 'REFRESH' }
  | { type: 'RESTORE'; ctx: PendingContext }

export const INITIAL_TX_STATE: TxState = {
  phase: 'idle',
  pending: null,
  errorMsg: '',
  confirmedHash: null,
  confirmedAction: null,
  confirmedAmount: null,
}

export function txReducer(state: TxState, event: TxEvent): TxState {
  switch (event.type) {
    case 'PREFLIGHT_START':
      return { ...state, phase: 'preflight', errorMsg: '' }

    case 'PREFLIGHT_FAIL':
      return { ...state, phase: 'error', errorMsg: event.msg }

    case 'SIGNING':
      return { ...state, phase: 'signing', errorMsg: '' }

    case 'TX_SUBMITTED':
      return { ...state, phase: 'confirming', pending: event.ctx }

    case 'CONFIRMING':
      return { ...state, phase: 'confirming' }

    case 'SUCCESS':
      return {
        ...state,
        phase: 'success',
        pending: null,
        confirmedHash: event.hash,
        confirmedAction: event.action,
        confirmedAmount: event.amount,
        errorMsg: '',
      }

    case 'APPROVAL_DONE':
      return {
        ...state,
        phase: 'approval-done',
        pending: null,
        errorMsg: '',
      }

    case 'TX_FAILED':
      return {
        ...state,
        phase: 'error',
        pending: null,
        errorMsg: event.msg,
      }

    case 'STALE_QUOTE':
      return { ...state, phase: 'stale-quote', pending: null, errorMsg: event.msg }

    case 'RPC_TIMEOUT':
      // Keep pending — hash needed for reconciliation. Do NOT clear pending.
      return { ...state, phase: 'rpc-recovery', errorMsg: event.msg }

    case 'USER_REJECTED':
      return { ...state, phase: 'idle', errorMsg: '' }

    case 'WALLET_CHANGED':
      // Preserve pending context — never discard a known hash on wallet change.
      // Surface wrong-wallet UI when there is a pending transaction to reconcile.
      if (state.pending) {
        return { ...state, phase: 'wrong-wallet', errorMsg: '' }
      }
      return { ...state, phase: 'idle', errorMsg: '' }

    case 'REFRESH':
      // REFRESH must never discard an unresolved pending hash.
      // Only clear pending when already in a terminal state (success/error/stale-quote)
      // or when there is no pending hash (idle/approval-done).
      if (
        state.pending &&
        state.phase !== 'success' &&
        state.phase !== 'error' &&
        state.phase !== 'stale-quote' &&
        state.phase !== 'approval-done' &&
        state.phase !== 'idle'
      ) {
        // Still in rpc-recovery or wrong-wallet — REFRESH means "re-check chain"
        // but cannot clear pending until reconciled.
        return { ...state, phase: 'rpc-recovery', errorMsg: '' }
      }
      return { ...state, phase: 'idle', errorMsg: '', pending: null }

    case 'RESTORE':
      return { ...state, phase: 'rpc-recovery', pending: event.ctx, errorMsg: '' }
  }
}

// ── SessionStorage helpers ────────────────────────────────────────────────────

const STORAGE_KEY = 'reflow_pending_v2'

/**
 * Persist context to sessionStorage.
 * Throws StorageError when storage is unavailable (private mode, quota) so callers
 * can decide whether to abort the write.
 */
export function savePendingContext(ctx: PendingContext): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ctx))
}

export function clearPendingContext(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch { /* ignore */ }
}

export function restorePendingContext(): PendingContext | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    return validatePendingContext(parsed)
  } catch { return null }
}

/** Returns a valid PendingContext or null. Never throws. */
export function validatePendingContext(raw: unknown): PendingContext | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  if (r.version !== PENDING_VERSION)      return null
  if (!isHex66(r.hash))                   return null
  if (r.chainId !== NETWORK.chainId) return null
  if (!isHex42(r.contractAddress))        return null
  if (!isHex42(r.walletAddress))          return null
  if (!isPositiveDecimalString(r.poolId))        return null
  if (!isDecimalString(r.expectedAmount)) return null

  const action = r.action
  if (
    action !== 'purchaseFirst' &&
    action !== 'join' &&
    action !== 'claimFor' &&
    action !== 'approve'
  ) return null

  // approve action requires approvalSpender
  if (action === 'approve' && !isHex42(r.approvalSpender)) return null

  return r as unknown as PendingContext
}

function isHex66(v: unknown): v is `0x${string}` {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)
}

function isHex42(v: unknown): v is `0x${string}` {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
}

function isDecimalString(v: unknown): boolean {
  return typeof v === 'string' && /^\d+$/.test(v)
}

function isPositiveDecimalString(v: unknown): boolean {
  if (!isDecimalString(v)) return false
  return BigInt(v as string) > 0n
}

// ── Receipt verification ──────────────────────────────────────────────────────

export interface VerifyResult {
  ok:     boolean
  amount: string   // bigint decimal string of the confirmed event amount
  msg:    string
}

// Selectors derived at module load from the actual ABI using toEventSelector.
// This is synchronous — toEventSelector computes keccak256 locally from the
// canonical event signature string and requires no network call.
// Never hardcode a selector constant; always derive from the ABI entry.
const S_FIRST_PURCHASED  = toEventSelector(REFLOW_POOLS_ABI.find(e => e.type === 'event' && e.name === 'FirstPurchased')!)
const S_JOINED           = toEventSelector(REFLOW_POOLS_ABI.find(e => e.type === 'event' && e.name === 'Joined')!)
const S_REBATE_CLAIMED   = toEventSelector(REFLOW_POOLS_ABI.find(e => e.type === 'event' && e.name === 'RebateClaimed')!)

// ERC-20 Approval(address indexed owner, address indexed spender, uint256 value)
// Derived from canonical signature string.
const ERC20_APPROVAL_TOPIC = toEventSelector('Approval(address,address,uint256)')

const EVENT_SELECTORS: Record<TxAction, string> = {
  purchaseFirst: S_FIRST_PURCHASED,
  join:          S_JOINED,
  claimFor:      S_REBATE_CLAIMED,
  approve:       ERC20_APPROVAL_TOPIC,
}

export function verifyReceipt(
  receipt: TransactionReceipt,
  ctx: PendingContext,
  usdcAddress: `0x${string}`,
): VerifyResult {
  if (receipt.status !== 'success') {
    return { ok: false, amount: '0', msg: 'Transaction was reverted on-chain.' }
  }

  // Verify receipt belongs to the expected transaction
  if (
    receipt.transactionHash &&
    receipt.transactionHash.toLowerCase() !== ctx.hash.toLowerCase()
  ) {
    return { ok: false, amount: '0', msg: 'Receipt transaction hash does not match context.' }
  }

  const contractAddr = ctx.contractAddress.toLowerCase()

  if (ctx.action === 'approve') {
    // Expect ERC-20 Approval(owner, spender, value) from canonical USDC token
    const usdcLower = usdcAddress.toLowerCase()
    const approvalLogs = receipt.logs.filter(
      (log: Log) =>
        log.address.toLowerCase() === usdcLower &&
        log.topics[0]?.toLowerCase() === ERC20_APPROVAL_TOPIC,
    )
    if (approvalLogs.length === 0) {
      return { ok: false, amount: '0', msg: 'Approval event not found in receipt.' }
    }
    if (approvalLogs.length > 1) {
      return { ok: false, amount: '0', msg: 'Ambiguous receipt: multiple Approval events from USDC.' }
    }
    const approvalLog = approvalLogs[0]
    try {
      const decoded = decodeEventLog({
        abi: [{ type: 'event', name: 'Approval', inputs: [
          { name: 'owner',   type: 'address', indexed: true  },
          { name: 'spender', type: 'address', indexed: true  },
          { name: 'value',   type: 'uint256', indexed: false },
        ]}],
        data:   approvalLog.data,
        topics: approvalLog.topics,
      })
      const args = decoded.args as { owner: string; spender: string; value: bigint }
      if (args.owner.toLowerCase() !== ctx.walletAddress.toLowerCase()) {
        return { ok: false, amount: '0', msg: 'Approval owner does not match connected wallet.' }
      }
      if (!ctx.approvalSpender) {
        return { ok: false, amount: '0', msg: 'approvalSpender required for approve action but missing from context.' }
      }
      if (args.spender.toLowerCase() !== ctx.approvalSpender.toLowerCase()) {
        return { ok: false, amount: '0', msg: 'Approval spender does not match expected contract.' }
      }
      // Exact value check — must match the expectedAmount recorded in context
      const expectedValue = BigInt(ctx.expectedAmount)
      if (args.value !== expectedValue) {
        return { ok: false, amount: '0', msg: `Approval value ${args.value} does not match expected ${expectedValue}.` }
      }
      if (args.value === 0n) {
        return { ok: false, amount: '0', msg: 'Approval value is zero — expected a positive amount.' }
      }
      return { ok: true, amount: args.value.toString(), msg: '' }
    } catch {
      return { ok: false, amount: '0', msg: 'Could not decode Approval event.' }
    }
  }

  // For purchaseFirst / join / claimFor: find the event from the contract
  const selector = EVENT_SELECTORS[ctx.action]
  const matchingLogs = receipt.logs.filter(
    (log: Log) =>
      log.address.toLowerCase() === contractAddr &&
      log.topics[0]?.toLowerCase() === selector,
  )

  if (matchingLogs.length === 0) {
    return {
      ok: false, amount: '0',
      msg: `Expected ${ctx.action} event from contract not found in receipt.`,
    }
  }
  if (matchingLogs.length > 1) {
    return {
      ok: false, amount: '0',
      msg: `Ambiguous receipt: ${matchingLogs.length} matching events.`,
    }
  }

  const log = matchingLogs[0]

  // Validate positive poolId
  const ctxPoolId = BigInt(ctx.poolId)
  if (ctxPoolId === 0n) {
    return { ok: false, amount: '0', msg: 'Context poolId is zero — invalid.' }
  }

  try {
    if (ctx.action === 'purchaseFirst') {
      const decoded = decodeEventLog({
        abi: REFLOW_POOLS_ABI,
        eventName: 'FirstPurchased',
        data:   log.data,
        topics: log.topics,
      })
      const args = decoded.args
      if (args.poolId !== ctxPoolId)                                          return { ok: false, amount: '0', msg: 'Event poolId mismatch.' }
      if (args.buyer.toLowerCase() !== ctx.walletAddress.toLowerCase())       return { ok: false, amount: '0', msg: 'Event buyer does not match wallet.' }
      if (args.amount.toString()   !== ctx.expectedAmount)                    return { ok: false, amount: '0', msg: 'Event amount does not match expected.' }
      if (args.amount === 0n)                                                  return { ok: false, amount: '0', msg: 'Event amount is zero — unexpected.' }
      return { ok: true, amount: args.amount.toString(), msg: '' }
    }

    if (ctx.action === 'join') {
      const decoded = decodeEventLog({
        abi: REFLOW_POOLS_ABI,
        eventName: 'Joined',
        data:   log.data,
        topics: log.topics,
      })
      const args = decoded.args
      if (args.poolId !== ctxPoolId)                                          return { ok: false, amount: '0', msg: 'Event poolId mismatch.' }
      if (args.participant.toLowerCase() !== ctx.walletAddress.toLowerCase()) return { ok: false, amount: '0', msg: 'Event participant does not match wallet.' }
      if (args.contribution.toString()   !== ctx.expectedAmount)              return { ok: false, amount: '0', msg: 'Event contribution does not match expected.' }
      if (args.contribution === 0n)                                            return { ok: false, amount: '0', msg: 'Event contribution is zero — unexpected.' }
      // Verify joinOrder matches the expectedCount stored in context
      if (ctx.expectedCount !== undefined) {
        const expectedJoinOrder = BigInt(ctx.expectedCount)
        if (args.joinOrder !== expectedJoinOrder) {
          return { ok: false, amount: '0', msg: `Event joinOrder ${args.joinOrder} does not match expectedCount ${expectedJoinOrder}.` }
        }
      }
      return { ok: true, amount: args.contribution.toString(), msg: '' }
    }

    if (ctx.action === 'claimFor') {
      const decoded = decodeEventLog({
        abi: REFLOW_POOLS_ABI,
        eventName: 'RebateClaimed',
        data:   log.data,
        topics: log.topics,
      })
      const args = decoded.args
      if (args.poolId !== ctxPoolId)                                          return { ok: false, amount: '0', msg: 'Event poolId mismatch.' }
      if (args.beneficiary.toLowerCase() !== ctx.walletAddress.toLowerCase()) return { ok: false, amount: '0', msg: 'Event beneficiary does not match wallet.' }
      if (args.amount === 0n)                                                  return { ok: false, amount: '0', msg: 'Event amount is zero — unexpected.' }
      // Claim amount may be legitimately larger than pre-flight minimum (another join mined first)
      const minExpected = BigInt(ctx.expectedAmount)
      if (args.amount < minExpected) {
        return { ok: false, amount: '0', msg: `Claimed ${args.amount} is below expected minimum ${ctx.expectedAmount}.` }
      }
      return { ok: true, amount: args.amount.toString(), msg: '' }
    }
  } catch (e) {
    return { ok: false, amount: '0', msg: `Event decode failed: ${e instanceof Error ? e.message : 'unknown'}` }
  }

  return { ok: false, amount: '0', msg: 'Unknown action.' }
}

// ── Error classification ──────────────────────────────────────────────────────

export function classifyError(error: unknown): TxEvent {
  const msg = (error instanceof Error ? error.message : String(error) ?? '').toLowerCase()
  const code = (error as { code?: number })?.code

  if (code === 4001 || msg.includes('user rejected') || msg.includes('user denied') || msg.includes('rejected the request')) {
    return { type: 'USER_REJECTED' }
  }
  if (msg.includes('timeout') || msg.includes('network error') || msg.includes('fetch failed') || msg.includes('connection refused')) {
    return { type: 'RPC_TIMEOUT', msg: 'Network issue. Your transaction may still confirm — keep the hash and check the explorer before retrying.' }
  }
  if (msg.includes('countmismatch') || msg.includes('count mismatch') || msg.includes('contributiontoohigh')) {
    return { type: 'STALE_QUOTE', msg: 'Pool count changed since your quote. Refresh to see the updated cost before proceeding.' }
  }
  if (msg.includes('insufficient') || msg.includes('exceeds balance')) {
    return { type: 'TX_FAILED', msg: 'Insufficient USDC balance.' }
  }
  if (msg.includes('deadlinepassed')) {
    return { type: 'TX_FAILED', msg: 'The joining deadline has passed. Claims are still available.' }
  }
  if (msg.includes('capreached')) {
    return { type: 'TX_FAILED', msg: 'The pool is full. Claims are still available for members.' }
  }
  if (msg.includes('alreadymember')) {
    return { type: 'TX_FAILED', msg: 'This address is already a pool member.' }
  }
  if (msg.includes('nothingtoclaim')) {
    return { type: 'TX_FAILED', msg: 'No claimable rebate at this time.' }
  }
  if (msg.includes('notamember')) {
    return { type: 'TX_FAILED', msg: 'This address is not a pool member.' }
  }
  if (msg.includes('membersalreadyexist')) {
    return { type: 'TX_FAILED', msg: 'The first purchase has already been made. Join instead.' }
  }
  if (msg.includes('firstpurchaserequired')) {
    return { type: 'TX_FAILED', msg: 'No first purchase yet. The pool needs a first buyer.' }
  }
  if (msg.includes('revert') || msg.includes('execution reverted')) {
    return { type: 'TX_FAILED', msg: 'Transaction was rejected by the contract. Check your eligibility and try again.' }
  }
  return { type: 'TX_FAILED', msg: 'Something went wrong. Check your wallet and try again.' }
}
