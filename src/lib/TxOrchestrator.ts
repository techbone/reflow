/**
 * TxOrchestrator — pure TypeScript transaction orchestration for Reflow M2.
 *
 * Framework-free; no React imports. TxControllerProvider is a thin wrapper that
 * owns ONE instance of this class for the application lifetime.
 *
 * KEY CONTRACTS
 * ─────────────
 * LATCH: `_locked` is a plain boolean property. `acquireLatch()` is synchronous
 *   and mutates it before returning. Two calls to execute() before the first await
 *   both call acquireLatch(); only the first returns true. The latch is released
 *   ONLY after a proven terminal outcome or a known USER_REJECTED before broadcast.
 *
 * STORAGE: ALL storage goes through the injected StorageAdapter (both the signing
 *   intent key and the pending-context key). This lets tests control everything
 *   without touching sessionStorage at all.
 *
 * BOOT: boot() must be called once at provider mount. It reads both keys and, if
 *   either holds a record (valid or corrupt), locks the orchestrator and surfaces
 *   a recovery state. Unknown/corrupt records never disappear silently.
 *
 * INTENT PERSISTENCE: encoded calldata is persisted in the SigningIntent before
 *   the wallet call so reconciliation can verify from === wallet, to === target,
 *   input === calldata, nonce >= observed, block >= start.
 *
 * SIGNING INTENT SEQUENCE:
 *   1. Preflight reads all authoritative values through RpcAdapter (never cached).
 *   2. Allowance check BEFORE any gas estimate (zero-allowance estimate would revert).
 *   3. Estimate gas for the exact call being submitted. No fallbacks.
 *   4. Nonce + startBlock must both resolve without error.
 *   5. Persist intent through injected adapter — THROWS on failure → no wallet call.
 *   6. Re-verify account + chain via WalletAdapter.currentAccount() immediately
 *      before the wallet write (after all async work above).
 *   7. Wallet write. On USER_REJECTED: clear intent, release latch. Any other
 *      error: keep intent + latch.
 *   8. Upgrade to PendingContext through injected adapter. On failure: hash is
 *      real — dispatch TX_SUBMITTED with the real hash + RPC_TIMEOUT with a
 *      truthful message containing the hash. Never say "not submitted".
 *
 * RECEIPT:
 *   success + correct event  → SUCCESS, release latch, clear both storage keys.
 *   success + wrong event    → rpc-recovery (LOCKED). Not proven failure.
 *   reverted receipt         → TX_FAILED, release latch, clear storage.
 *   no receipt (RPC error)   → RPC_TIMEOUT, keep latch + pending.
 */

import { erc20Abi, encodeFunctionData, decodeEventLog, toEventSelector } from 'viem'
import { REFLOW_POOLS_ABI } from './reflowAbi'
import {
  txReducer, INITIAL_TX_STATE,
  verifyReceipt, classifyError,
  PENDING_VERSION,
  type PendingContext, type TxState, type TxEvent,
} from './txLifecycle'
import { usdcToGasToken, Amount } from '@/onchain-money'
import { fmtUsdc } from './shareCalc'
import { NETWORK } from './network'

export { type TxState, type TxEvent }

// ── Intent storage key ────────────────────────────────────────────────────────
export const INTENT_STORAGE_KEY  = 'reflow_signing_intent_v2'
export const PENDING_STORAGE_KEY = 'reflow_pending_v2'      // mirrors txLifecycle's STORAGE_KEY
const INTENT_VERSION = 2

export interface SigningIntent {
  version:          typeof INTENT_VERSION
  walletAddress:    `0x${string}`
  chainId:          number
  contractAddress:  `0x${string}`
  poolId:           string
  action:           'purchaseFirst' | 'join' | 'claimFor' | 'approve'
  amount:           string   // bigint decimal
  count?:           string   // join: expectedCount bigint decimal
  approvalSpender?: `0x${string}`
  observedNonce:    number
  startBlock:       string   // bigint decimal
  /** ABI-encoded calldata for the exact call being submitted. */
  calldata:         `0x${string}`
  /** Target contract address for this call (USDC for approve, pool contract otherwise). */
  target:           `0x${string}`
}

// ── Injected adapters ─────────────────────────────────────────────────────────

/**
 * StorageAdapter: controls ALL persistent state — intent AND pending context.
 * Tests inject a deterministic in-memory store; the live provider uses
 * sessionStorage. Throwing on setItem causes the orchestrator to abort before
 * calling the wallet.
 */
export interface StorageAdapter {
  setItem(key: string, value: string): void
  getItem(key: string): string | null
  removeItem(key: string): void
}

export const sessionStorageAdapter: StorageAdapter = {
  setItem:    (k, v) => sessionStorage.setItem(k, v),
  getItem:    (k)    => sessionStorage.getItem(k),
  removeItem: (k)    => sessionStorage.removeItem(k),
}

export interface RpcAdapter {
  getChainId():                                                             Promise<number>
  getCode(address: `0x${string}`):                                         Promise<`0x${string}` | null>
  readContract_usdc(contractAddress: `0x${string}`):                       Promise<`0x${string}`>
  readContract_decimals(usdcAddress: `0x${string}`):                       Promise<number>
  readContract_poolExists(contractAddress: `0x${string}`, poolId: bigint): Promise<boolean>
  readContract_balanceOf(
    usdcAddress: `0x${string}`,
    owner: `0x${string}`,
  ): Promise<bigint>
  readContract_allowance(
    usdcAddress: `0x${string}`,
    owner: `0x${string}`,
    spender: `0x${string}`,
  ): Promise<bigint>
  simulateApprove(
    usdcAddress: `0x${string}`,
    spender: `0x${string}`,
    amount: bigint,
    account: `0x${string}`,
  ): Promise<void>
  simulatePurchaseFirst(
    contractAddress: `0x${string}`,
    poolId: bigint,
    maxAmount: bigint,
    account: `0x${string}`,
  ): Promise<void>
  simulateJoin(
    contractAddress: `0x${string}`,
    poolId: bigint,
    expectedCount: bigint,
    maxContribution: bigint,
    account: `0x${string}`,
  ): Promise<void>
  simulateClaim(
    contractAddress: `0x${string}`,
    poolId: bigint,
    beneficiary: `0x${string}`,
    account: `0x${string}`,
  ): Promise<void>
  estimateGas_approve(
    usdcAddress: `0x${string}`,
    spender: `0x${string}`,
    amount: bigint,
    account: `0x${string}`,
  ): Promise<bigint>
  estimateGas_purchaseFirst(
    contractAddress: `0x${string}`,
    poolId: bigint,
    maxAmount: bigint,
    account: `0x${string}`,
  ): Promise<bigint>
  estimateGas_join(
    contractAddress: `0x${string}`,
    poolId: bigint,
    expectedCount: bigint,
    maxContribution: bigint,
    account: `0x${string}`,
  ): Promise<bigint>
  estimateGas_claim(
    contractAddress: `0x${string}`,
    poolId: bigint,
    beneficiary: `0x${string}`,
    account: `0x${string}`,
  ): Promise<bigint>
  getGasPrice():                                         Promise<bigint>
  getTransactionCount(address: `0x${string}`):           Promise<number>
  getBlockNumber():                                      Promise<bigint>
  getTransactionReceipt(hash: `0x${string}`):            Promise<import('viem').TransactionReceipt>
  /** Native USDC balance on Arc (18-decimal view). Throws on failure. */
  getNativeBalance(address: `0x${string}`):              Promise<bigint>
  /** Fetch raw transaction to verify from/to/input/nonce for reconciliation. */
  getTransaction(hash: `0x${string}`): Promise<{
    from: `0x${string}`
    to:   `0x${string}` | null
    input: `0x${string}`
    nonce: number
    blockNumber: bigint | null
  }>
}

export interface WalletAdapter {
  /**
   * Return the currently connected account address and chainId.
   * Called immediately before every wallet write (after all async preflight work)
   * to detect account or chain switches that occurred during the async gap.
   */
  currentAccount(): { address: `0x${string}`; chainId: number }
  writeApprove(
    usdcAddress: `0x${string}`,
    spender: `0x${string}`,
    amount: bigint,
    account: `0x${string}`,
    chainId: number,
  ): Promise<`0x${string}`>
  writePurchaseFirst(
    contractAddress: `0x${string}`,
    poolId: bigint,
    maxAmount: bigint,
    account: `0x${string}`,
    chainId: number,
  ): Promise<`0x${string}`>
  writeJoin(
    contractAddress: `0x${string}`,
    poolId: bigint,
    expectedCount: bigint,
    maxContribution: bigint,
    account: `0x${string}`,
    chainId: number,
  ): Promise<`0x${string}`>
  writeClaim(
    contractAddress: `0x${string}`,
    poolId: bigint,
    beneficiary: `0x${string}`,
    account: `0x${string}`,
    chainId: number,
  ): Promise<`0x${string}`>
}

// ── ExecuteParams ─────────────────────────────────────────────────────────────
// The orchestrator reads authoritative values (balance, allowance, pool existence)
// from RpcAdapter during preflight. These params carry the user-reviewed amounts
// and action intent only — the orchestrator does NOT trust cached UI values for
// security-critical reads.

export interface ExecuteParams {
  action:         'purchaseFirst' | 'join' | 'claimFor'
  /** purchaseFirst: full pool price. join: current contribution quote. */
  price?:         bigint
  contribution?:  bigint
  expectedCount?: bigint  // join: quote-time pool count (used as join() arg)
  minClaim?:      bigint  // claimFor: minimum expected (for context; actual >= this)
}

// ── TxOrchestrator ────────────────────────────────────────────────────────────

export class TxOrchestrator {
  private _state: TxState = { ...INITIAL_TX_STATE }
  /** Synchronous latch. Must be acquired before any await. */
  private _locked = false
  /** Signing intent currently in storage (set/cleared in parallel with storage). */
  private _intentInStorage = false

  constructor(
    private readonly contractAddress: `0x${string}`,
    private readonly poolId: bigint,
    private readonly rpc: RpcAdapter,
    private readonly wallet: WalletAdapter,
    private readonly storage: StorageAdapter,
    private readonly chainId: number = NETWORK.chainId,
    private readonly usdcAddress: `0x${string}` = NETWORK.usdc,
    private readonly onStateChange: (s: TxState) => void = () => { /* noop */ },
    private readonly onSuccess: () => void = () => { /* noop */ },
    /** Human-readable network name used in error messages. Defaults to NETWORK.name. */
    private readonly networkName: string = NETWORK.name,
  ) {}

  get state(): TxState { return this._state }
  isLocked(): boolean  { return this._locked }

  private dispatch(event: TxEvent): void {
    this._state = txReducer(this._state, event)
    this.onStateChange(this._state)
  }

  private acquireLatch(): boolean {
    if (this._locked) return false
    this._locked = true
    return true
  }

  private releaseLatch(): void {
    this._locked = false
  }

  // ── Storage helpers (all go through the injected adapter) ─────────────────

  private saveIntent(intent: SigningIntent): void {
    // Throws on storage failure — callers must catch and abort
    this.storage.setItem(INTENT_STORAGE_KEY, JSON.stringify(intent))
    this._intentInStorage = true
  }

  private clearIntent(): void {
    try { this.storage.removeItem(INTENT_STORAGE_KEY) } catch { /* ignore */ }
    this._intentInStorage = false
  }

  private savePending(ctx: PendingContext): void {
    // Throws on storage failure
    this.storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(ctx))
  }

  private clearPending(): void {
    try { this.storage.removeItem(PENDING_STORAGE_KEY) } catch { /* ignore */ }
  }

  private clearBothStorage(): void {
    this.clearPending()
    this.clearIntent()
  }

  restoreIntent(): SigningIntent | null {
    try {
      const raw = this.storage.getItem(INTENT_STORAGE_KEY)
      if (!raw) return null
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      const r = parsed as Record<string, unknown>
      if (r.version !== INTENT_VERSION) return null
      if (typeof r.walletAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.walletAddress)) return null
      if (typeof r.contractAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.contractAddress)) return null
      if (r.chainId !== this.chainId) return null
      if (typeof r.poolId !== 'string' || !/^\d+$/.test(r.poolId)) return null
      if (typeof r.amount !== 'string' || !/^\d+$/.test(r.amount)) return null
      return parsed as SigningIntent
    } catch { return null }
  }

  private restorePendingFromStorage(): PendingContext | null {
    try {
      const raw = this.storage.getItem(PENDING_STORAGE_KEY)
      if (!raw) return null
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      const r = parsed as Record<string, unknown>
      if (r.version !== PENDING_VERSION) return null
      if (typeof r.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r.hash)) return null
      if (r.chainId !== this.chainId) return null
      if (typeof r.contractAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.contractAddress)) return null
      if (typeof r.walletAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.walletAddress)) return null
      if (typeof r.poolId !== 'string' || !/^\d+$/.test(r.poolId) || BigInt(r.poolId) === 0n) return null
      if (typeof r.expectedAmount !== 'string' || !/^\d+$/.test(r.expectedAmount)) return null
      const action = r.action
      if (action !== 'purchaseFirst' && action !== 'join' && action !== 'claimFor' && action !== 'approve') return null
      if (action === 'approve' && (typeof r.approvalSpender !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.approvalSpender))) return null
      return r as unknown as PendingContext
    } catch { return null }
  }

  /**
   * boot() must be called ONCE at provider mount, BEFORE any execute() call.
   *
   * Reads both storage keys. Priority:
   *   1. Pending (has hash) → lock + RESTORE → rpc-recovery
   *   2. Intent-only (no hash) → lock + rpc-recovery with descriptive message
   *   3. Corrupt raw data in either key → lock + rpc-recovery
   *      (unknown records must never silently disappear)
   *   4. Both empty → do nothing (idle, unlocked)
   */
  boot(): void {
    // Check pending first (has a hash — most recoverable)
    const rawPending = this.storage.getItem(PENDING_STORAGE_KEY)
    if (rawPending !== null) {
      const ctx = this.restorePendingFromStorage()
      if (ctx) {
        this._locked = true
        this.dispatch({ type: 'RESTORE', ctx })
        return
      }
      // Corrupt record — lock and surface
      this._locked = true
      this.dispatch({
        type: 'RPC_TIMEOUT',
        msg: 'A corrupt pending-transaction record was found in storage. Do not submit a new transaction. Clear your browser session storage after confirming no transaction is pending.',
      })
      return
    }

    // Check intent
    const rawIntent = this.storage.getItem(INTENT_STORAGE_KEY)
    if (rawIntent !== null) {
      const intent = this.restoreIntent()
      if (intent) {
        this._locked = true
        this._intentInStorage = true
        this.dispatch({
          type: 'RPC_TIMEOUT',
          msg: `A signing intent was found with no confirmed hash (action: ${intent.action}, amount: ${intent.amount} units, target: ${intent.target}). Your wallet may have a pending or failed transaction. Check your wallet history and reconcile before submitting anything new.`,
        })
        return
      }
      // Corrupt intent record — lock and surface
      this._locked = true
      this.dispatch({
        type: 'RPC_TIMEOUT',
        msg: 'A corrupt signing-intent record was found. Do not submit a new transaction until you have confirmed no transaction is pending.',
      })
    }
  }

  /** Apply a saved pending context directly (used by tests and reconciliation). */
  applyRestore(ctx: PendingContext): void {
    this._locked = true
    this.dispatch({ type: 'RESTORE', ctx })
  }

  /** Notify the orchestrator of a wallet address change. */
  walletChanged(): void {
    this.dispatch({ type: 'WALLET_CHANGED' })
    // Do NOT release the latch — pending context must stay visible.
  }

  /** Dispatch REFRESH — must not unblock an unresolved pending. */
  refresh(): void {
    this.dispatch({ type: 'REFRESH' })
  }

  // ── execute: the single entry point for all writes ────────────────────────

  async execute(params: ExecuteParams, walletAddress: `0x${string}`, walletChainId: number): Promise<void> {
    // SYNCHRONOUS latch acquisition — before any await
    if (!this.acquireLatch()) return

    this.dispatch({ type: 'PREFLIGHT_START' })

    // Outer safety net: unexpected throws before intent is persisted must
    // release the latch with a clean error, not leave an undiscoverable lock.
    // (Each sub-method catches its own errors; this guard handles unforeseen throws
    // in the preflight chain, e.g. a synchronous exception from a mock in tests.)
    try {
      await this._executeInner(params, walletAddress, walletChainId)
    } catch (e) {
      // Only reach here if a sub-method threw past its own catch.
      // If an intent was already persisted before the throw, keep the latch —
      // the wallet may have been called and we cannot know the outcome.
      // If nothing was persisted, release cleanly.
      if (!this._intentInStorage) {
        this.releaseLatch()
      }
      const msg = e instanceof Error ? e.message : 'Unexpected error during preflight.'
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg })
    }
  }

  private async _executeInner(params: ExecuteParams, walletAddress: `0x${string}`, walletChainId: number): Promise<void> {
    // ── Preflight: all reads go through RpcAdapter (no cached UI values) ────

    // Step 1: RPC chain ID
    let rpcChainId: number
    try {
      rpcChainId = await this.rpc.getChainId()
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read chain ID from RPC: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }
    if (rpcChainId !== this.chainId || walletChainId !== this.chainId) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Switch your wallet to ${this.networkName} (chain id ${this.chainId}) before submitting.` })
      return
    }

    // Step 2: Contract bytecode
    let code: `0x${string}` | null
    try {
      code = await this.rpc.getCode(this.contractAddress)
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read contract code: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }
    if (!code || code === '0x') {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Contract address has no deployed code on ${this.networkName}.` })
      return
    }

    // Step 3: USDC address
    let contractUsdc: `0x${string}`
    try {
      contractUsdc = await this.rpc.readContract_usdc(this.contractAddress)
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read contract USDC address: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }
    if (contractUsdc.toLowerCase() !== this.usdcAddress.toLowerCase()) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Contract's USDC (${contractUsdc}) does not match canonical USDC.` })
      return
    }

    // Step 4: USDC decimals
    let decimals: number
    try {
      decimals = await this.rpc.readContract_decimals(this.usdcAddress)
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read USDC decimals: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }
    if (decimals !== 6) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `USDC token reports ${decimals} decimals; expected 6.` })
      return
    }

    // Step 5: Pool existence
    let poolExists: boolean
    try {
      poolExists = await this.rpc.readContract_poolExists(this.contractAddress, this.poolId)
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not verify pool existence: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }
    if (!poolExists) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: 'Pool does not exist on-chain.' })
      return
    }

    // ── Route by action ────────────────────────────────────────────────────

    if (params.action === 'purchaseFirst' || params.action === 'join') {
      const requiredPayment = params.action === 'purchaseFirst'
        ? (params.price ?? 0n)
        : (params.contribution ?? 0n)

      if (requiredPayment === 0n) {
        this.releaseLatch()
        this.dispatch({ type: 'PREFLIGHT_FAIL', msg: 'Required payment is zero — cannot proceed.' })
        return
      }

      await this._executePurchaseOrJoinFull(params, requiredPayment, walletAddress, walletChainId)

    } else if (params.action === 'claimFor') {
      await this._executeClaimFull(params, walletAddress, walletChainId)
    }
  }

  // ── Internal: purchase/join full flow ─────────────────────────────────────

  private async _executePurchaseOrJoinFull(
    params: ExecuteParams,
    requiredPayment: bigint,
    walletAddress: `0x${string}`,
    walletChainId: number,
  ): Promise<void> {
    const isPurchase    = params.action === 'purchaseFirst'
    const expectedCount = params.expectedCount ?? 0n

    // Step 6: USDC balance
    let usdcBalance: bigint
    try {
      usdcBalance = await this.rpc.readContract_balanceOf(this.usdcAddress, walletAddress)
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read USDC balance: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }
    if (usdcBalance < requiredPayment) {
      this.releaseLatch()
      this.dispatch({
        type: 'PREFLIGHT_FAIL',
        msg: `Insufficient USDC: you have $${fmtUsdc(usdcBalance, 6)} but need $${fmtUsdc(requiredPayment, 6)}.`,
      })
      return
    }

    // Step 7: USDC allowance — check BEFORE any gas estimate
    let allowance: bigint
    try {
      allowance = await this.rpc.readContract_allowance(this.usdcAddress, walletAddress, this.contractAddress)
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read USDC allowance: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }

    if (allowance < requiredPayment) {
      // Need approval first — simulate + estimate ONLY the approve, never the purchase
      await this._executeApproveFull(requiredPayment, walletAddress, walletChainId)
      return
    }

    // Allowance sufficient: simulate then estimate the exact purchase/join call
    try {
      if (isPurchase) {
        await this.rpc.simulatePurchaseFirst(this.contractAddress, this.poolId, requiredPayment, walletAddress)
      } else {
        await this.rpc.simulateJoin(this.contractAddress, this.poolId, expectedCount, requiredPayment, walletAddress)
      }
    } catch (simErr) {
      this.releaseLatch()
      const msg = simErr instanceof Error ? simErr.message : 'unknown'
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Pre-flight simulation failed: ${msg}` })
      return
    }

    // Gas estimate (mandatory — no fallback)
    let gasEstimate: bigint
    try {
      if (isPurchase) {
        gasEstimate = await this.rpc.estimateGas_purchaseFirst(this.contractAddress, this.poolId, requiredPayment, walletAddress)
      } else {
        gasEstimate = await this.rpc.estimateGas_join(this.contractAddress, this.poolId, expectedCount, requiredPayment, walletAddress)
      }
    } catch (gasErr) {
      this.releaseLatch()
      const msg = gasErr instanceof Error ? gasErr.message : 'unknown'
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Gas estimation failed: ${msg}` })
      return
    }

    // Gas price (mandatory)
    let gasPrice: bigint
    try {
      gasPrice = await this.rpc.getGasPrice()
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read gas price: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }

    // Native balance (mandatory on Arc — native IS USDC)
    let nativeBal: bigint
    try {
      nativeBal = await this.rpc.getNativeBalance(walletAddress)
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read native balance: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }

    // Combined solvency check
    try {
      const paymentNative = usdcToGasToken(this.chainId, Amount.fromRaw(requiredPayment, 6)).raw
      const gasCostNative = gasEstimate * gasPrice
      if (paymentNative + gasCostNative > nativeBal) {
        this.releaseLatch()
        this.dispatch({
          type: 'PREFLIGHT_FAIL',
          msg: `Insufficient balance: payment $${fmtUsdc(requiredPayment, 6)} + estimated gas exceeds your balance.`,
        })
        return
      }
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Solvency check failed: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }

    // Nonce + startBlock (mandatory)
    let observedNonce: number
    let startBlock: bigint
    try {
      observedNonce = await this.rpc.getTransactionCount(walletAddress)
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read nonce: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }
    try {
      startBlock = await this.rpc.getBlockNumber()
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read block number: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }

    // Encode calldata
    const calldata: `0x${string}` = isPurchase
      ? encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [this.poolId, requiredPayment] })
      : encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'join', args: [this.poolId, expectedCount, requiredPayment] })
    const target = this.contractAddress

    const intent: SigningIntent = {
      version: INTENT_VERSION, walletAddress, chainId: walletChainId,
      contractAddress: this.contractAddress, poolId: this.poolId.toString(),
      action: params.action, amount: requiredPayment.toString(),
      count: expectedCount.toString(),
      observedNonce, startBlock: startBlock.toString(),
      calldata, target,
    }

    // Persist BEFORE wallet call — throw = zero wallet calls
    try {
      this.saveIntent(intent)
    } catch {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: 'Storage unavailable — signing intent could not be saved. Transaction not submitted.' })
      return
    }

    // Re-verify account + chain immediately before wallet call
    const current = this.wallet.currentAccount()
    if (current.address.toLowerCase() !== walletAddress.toLowerCase() || current.chainId !== this.chainId) {
      this.clearIntent()
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: 'Account or network changed before signing. Please retry.' })
      return
    }

    this.dispatch({ type: 'SIGNING' })
    let hash: `0x${string}`
    try {
      if (isPurchase) {
        hash = await this.wallet.writePurchaseFirst(this.contractAddress, this.poolId, requiredPayment, walletAddress, this.chainId)
      } else {
        hash = await this.wallet.writeJoin(this.contractAddress, this.poolId, expectedCount, requiredPayment, walletAddress, this.chainId)
      }
    } catch (e) {
      const classified = classifyError(e)
      if (classified.type === 'USER_REJECTED') {
        this.clearIntent()
        this.releaseLatch()
      }
      this.dispatch(classified)
      return
    }

    const ctx: PendingContext = {
      version: PENDING_VERSION, hash, chainId: this.chainId,
      contractAddress: this.contractAddress, poolId: this.poolId.toString(),
      walletAddress, action: params.action,
      expectedAmount: requiredPayment.toString(),
      expectedCount:  expectedCount.toString(),
      // Reconciliation fields — survive intent clearance
      calldata, target, observedNonce, startBlock: startBlock.toString(),
    }
    try {
      this.savePending(ctx)
      this.clearIntent()
    } catch {
      // Hash is real — say so truthfully
      this.dispatch({ type: 'TX_SUBMITTED', ctx })
      this.dispatch({
        type: 'RPC_TIMEOUT',
        msg: `Transaction submitted (${hash.slice(0, 10)}…) but recovery record could not be saved. Keep this hash: ${hash}`,
      })
      return
    }
    this.dispatch({ type: 'TX_SUBMITTED', ctx })
    // latch stays held until receipt
  }

  private async _executeApproveFull(
    amount: bigint,
    walletAddress: `0x${string}`,
    walletChainId: number,
  ): Promise<void> {
    // Simulate approve
    try {
      await this.rpc.simulateApprove(this.usdcAddress, this.contractAddress, amount, walletAddress)
    } catch (simErr) {
      this.releaseLatch()
      const msg = simErr instanceof Error ? simErr.message : 'unknown'
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Approval simulation failed: ${msg}` })
      return
    }

    // Estimate approve gas (mandatory)
    let gasEstimate: bigint
    try {
      gasEstimate = await this.rpc.estimateGas_approve(this.usdcAddress, this.contractAddress, amount, walletAddress)
    } catch (gasErr) {
      this.releaseLatch()
      const msg = gasErr instanceof Error ? gasErr.message : 'unknown'
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Approval gas estimation failed: ${msg}` })
      return
    }

    // Gas price (mandatory)
    let gasPrice: bigint
    try {
      gasPrice = await this.rpc.getGasPrice()
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read gas price: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }

    // Native balance (mandatory)
    let nativeBal: bigint
    try {
      nativeBal = await this.rpc.getNativeBalance(walletAddress)
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read native balance: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }

    // Fee-only solvency (approve does not transfer tokens)
    const gasCostNative = gasEstimate * gasPrice
    if (gasCostNative > nativeBal) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: 'Insufficient USDC to cover gas for this approval.' })
      return
    }

    // Nonce + startBlock (mandatory)
    let observedNonce: number
    let startBlock: bigint
    try {
      observedNonce = await this.rpc.getTransactionCount(walletAddress)
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read nonce: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }
    try {
      startBlock = await this.rpc.getBlockNumber()
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read block number: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }

    const calldata: `0x${string}` = encodeFunctionData({
      abi: erc20Abi, functionName: 'approve',
      args: [this.contractAddress, amount],
    })

    const intent: SigningIntent = {
      version: INTENT_VERSION, walletAddress, chainId: walletChainId,
      contractAddress: this.contractAddress, poolId: this.poolId.toString(),
      action: 'approve', amount: amount.toString(),
      approvalSpender: this.contractAddress,
      observedNonce, startBlock: startBlock.toString(),
      calldata, target: this.usdcAddress,
    }

    try {
      this.saveIntent(intent)
    } catch {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: 'Storage unavailable — signing intent could not be saved. Transaction not submitted.' })
      return
    }

    // Re-verify account + chain
    const current = this.wallet.currentAccount()
    if (current.address.toLowerCase() !== walletAddress.toLowerCase() || current.chainId !== this.chainId) {
      this.clearIntent()
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: 'Account or network changed before signing. Please retry.' })
      return
    }

    this.dispatch({ type: 'SIGNING' })
    let appHash: `0x${string}`
    try {
      appHash = await this.wallet.writeApprove(this.usdcAddress, this.contractAddress, amount, walletAddress, this.chainId)
    } catch (e) {
      const classified = classifyError(e)
      if (classified.type === 'USER_REJECTED') {
        this.clearIntent()
        this.releaseLatch()
      }
      this.dispatch(classified)
      return
    }

    const ctx: PendingContext = {
      version: PENDING_VERSION, hash: appHash, chainId: this.chainId,
      contractAddress: this.contractAddress, poolId: this.poolId.toString(),
      walletAddress, action: 'approve',
      expectedAmount: amount.toString(),
      approvalSpender: this.contractAddress,
      // Reconciliation fields — survive intent clearance
      calldata, target: this.usdcAddress, observedNonce, startBlock: startBlock.toString(),
    }
    try {
      this.savePending(ctx)
      this.clearIntent()
    } catch {
      this.dispatch({ type: 'TX_SUBMITTED', ctx })
      this.dispatch({
        type: 'RPC_TIMEOUT',
        msg: `Transaction submitted (${appHash.slice(0, 10)}…) but recovery record could not be saved. Keep this hash: ${appHash}`,
      })
      return
    }
    this.dispatch({ type: 'TX_SUBMITTED', ctx })
  }

  private async _executeClaimFull(
    params: ExecuteParams,
    walletAddress: `0x${string}`,
    walletChainId: number,
  ): Promise<void> {
    // Simulate claim
    try {
      await this.rpc.simulateClaim(this.contractAddress, this.poolId, walletAddress, walletAddress)
    } catch (simErr) {
      this.releaseLatch()
      const msg = simErr instanceof Error ? simErr.message : 'unknown'
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Claim simulation failed: ${msg}` })
      return
    }

    // Estimate gas (mandatory)
    let gasEstimate: bigint
    try {
      gasEstimate = await this.rpc.estimateGas_claim(this.contractAddress, this.poolId, walletAddress, walletAddress)
    } catch (gasErr) {
      this.releaseLatch()
      const msg = gasErr instanceof Error ? gasErr.message : 'unknown'
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Gas estimation failed for claim: ${msg}` })
      return
    }

    // Gas price (mandatory)
    let gasPrice: bigint
    try {
      gasPrice = await this.rpc.getGasPrice()
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read gas price: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }

    // Native balance (mandatory)
    let nativeBal: bigint
    try {
      nativeBal = await this.rpc.getNativeBalance(walletAddress)
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read native balance: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }

    const gasCostNative = gasEstimate * gasPrice
    if (gasCostNative > nativeBal) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: 'Insufficient USDC to cover gas for this claim.' })
      return
    }

    // Nonce + startBlock (mandatory)
    let observedNonce: number
    let startBlock: bigint
    try {
      observedNonce = await this.rpc.getTransactionCount(walletAddress)
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read nonce: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }
    try {
      startBlock = await this.rpc.getBlockNumber()
    } catch (e) {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: `Could not read block number: ${e instanceof Error ? e.message : 'unknown'}` })
      return
    }

    const calldata: `0x${string}` = encodeFunctionData({
      abi: REFLOW_POOLS_ABI, functionName: 'claimFor',
      args: [this.poolId, walletAddress],
    })

    const intent: SigningIntent = {
      version: INTENT_VERSION, walletAddress, chainId: walletChainId,
      contractAddress: this.contractAddress, poolId: this.poolId.toString(),
      action: 'claimFor', amount: (params.minClaim ?? 0n).toString(),
      observedNonce, startBlock: startBlock.toString(),
      calldata, target: this.contractAddress,
    }

    try {
      this.saveIntent(intent)
    } catch {
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: 'Storage unavailable — signing intent could not be saved. Transaction not submitted.' })
      return
    }

    const current = this.wallet.currentAccount()
    if (current.address.toLowerCase() !== walletAddress.toLowerCase() || current.chainId !== this.chainId) {
      this.clearIntent()
      this.releaseLatch()
      this.dispatch({ type: 'PREFLIGHT_FAIL', msg: 'Account or network changed before signing. Please retry.' })
      return
    }

    this.dispatch({ type: 'SIGNING' })
    let hash: `0x${string}`
    try {
      hash = await this.wallet.writeClaim(this.contractAddress, this.poolId, walletAddress, walletAddress, this.chainId)
    } catch (e) {
      const classified = classifyError(e)
      if (classified.type === 'USER_REJECTED') {
        this.clearIntent()
        this.releaseLatch()
      }
      this.dispatch(classified)
      return
    }

    const ctx: PendingContext = {
      version: PENDING_VERSION, hash, chainId: this.chainId,
      contractAddress: this.contractAddress, poolId: this.poolId.toString(),
      walletAddress, action: 'claimFor',
      expectedAmount: (params.minClaim ?? 0n).toString(),
      // Reconciliation fields — survive intent clearance
      calldata, target: this.contractAddress, observedNonce, startBlock: startBlock.toString(),
    }
    try {
      this.savePending(ctx)
      this.clearIntent()
    } catch {
      this.dispatch({ type: 'TX_SUBMITTED', ctx })
      this.dispatch({
        type: 'RPC_TIMEOUT',
        msg: `Transaction submitted (${hash.slice(0, 10)}…) but recovery record could not be saved. Keep this hash: ${hash}`,
      })
      return
    }
    this.dispatch({ type: 'TX_SUBMITTED', ctx })
  }

  // ── Receipt handling ──────────────────────────────────────────────────────

  onReceiptSuccess(receipt: import('viem').TransactionReceipt): void {
    if (!this._state.pending) return
    const ctx = this._state.pending
    const result = verifyReceipt(receipt, ctx, this.usdcAddress)

    if (!result.ok) {
      if (receipt.status === 'reverted') {
        // Proven on-chain revert — release
        this.clearBothStorage()
        this.releaseLatch()
        this.dispatch({ type: 'TX_FAILED', msg: result.msg })
      } else {
        // Success receipt but event verification failed — stay locked.
        // This is NOT a proven failure; do not release the latch.
        this.dispatch({
          type: 'RPC_TIMEOUT',
          msg: `Receipt is marked success but expected event was not found or did not match: ${result.msg} Keep the hash and investigate before retrying.`,
        })
      }
      return
    }

    this.clearBothStorage()
    this.releaseLatch()
    if (ctx.action === 'approve') {
      this.dispatch({ type: 'APPROVAL_DONE' })
    } else {
      this.dispatch({ type: 'SUCCESS', hash: ctx.hash, action: ctx.action, amount: result.amount })
      this.onSuccess()
    }
  }

  onReceiptError(receipt: import('viem').TransactionReceipt | undefined): void {
    if (!this._state.pending) return
    if (receipt) {
      // Receipt present — branch on actual status
      if (receipt.status === 'reverted') {
        this.clearBothStorage()
        this.releaseLatch()
        this.dispatch({ type: 'TX_FAILED', msg: 'Transaction was reverted on-chain. Check the explorer for details.' })
      } else {
        // Non-reverted receipt arrived through the error path — treat as RPC anomaly
        this.dispatch({
          type: 'RPC_TIMEOUT',
          msg: 'Unexpected receipt status. Keep your hash and check the explorer before retrying.',
        })
      }
    } else {
      // No receipt — network/RPC failure, preserve hash
      this.dispatch({
        type: 'RPC_TIMEOUT',
        msg: 'Receipt query failed. Your transaction may still be pending — check the explorer before retrying.',
      })
    }
  }

  // ── Manual hash reconciliation ─────────────────────────────────────────────

  /**
   * Works whether in rpc-recovery (has hash) or intent-only (ambiguous send).
   *
   * SAME-HASH FAST-PATH: when the supplied hash equals ctx.hash (the stored
   * pending hash), it is definitionally our transaction — skip the replacement
   * checks and go straight to receipt verification.
   *
   * DIFFERENT-HASH PATH (proven same-nonce replacement):
   *   A different hash is accepted ONLY when ALL of the following hold:
   *   1. from === stored wallet address
   *   2. to === stored target — null `to` (contract creation) is always a mismatch
   *   3. input === stored calldata
   *   4. nonce === the pending transaction's observed nonce (exact match)
   *   5. blockNumber >= stored startBlock
   *   Anything else is rejected without changing state.
   *
   * Only a proven revert of the stored/replacement hash releases. A reverted
   * unrelated hash never releases.
   */
  async reconcileHash(hash: `0x${string}`): Promise<void> {
    const ctx    = this._state.pending
    const intent = this._intentInStorage ? this.restoreIntent() : null

    if (!ctx && !intent) {
      this.dispatch({
        type: 'RPC_TIMEOUT',
        msg: 'No recovery record found. Cannot reconcile.',
      })
      return
    }

    // Resolve reconciliation fields — ctx takes priority (survives after intent clear);
    // intent is fallback for intent-only records (no hash yet).
    const expectedWallet   = ctx?.walletAddress   ?? intent?.walletAddress
    const expectedTarget   = ctx?.target ?? (
      ctx
        ? (ctx.action === 'approve' ? this.usdcAddress : this.contractAddress)
        : intent?.target
    )
    const expectedCalldata = ctx?.calldata   ?? intent?.calldata
    const expectedNonce    = ctx?.observedNonce  ?? intent?.observedNonce
    const expectedStart    = ctx?.startBlock  !== undefined
      ? BigInt(ctx.startBlock)
      : (intent?.startBlock !== undefined ? BigInt(intent.startBlock) : undefined)

    // Same-hash fast-path: this IS our transaction by definition.
    const isSameHash = ctx?.hash !== undefined && hash.toLowerCase() === ctx.hash.toLowerCase()

    if (!isSameHash) {
      // Different hash — must be a proven same-nonce replacement.
      // Fetch the candidate transaction and verify all fields.
      try {
        const tx = await this.rpc.getTransaction(hash)

        // 1. Sender must match stored wallet
        if (expectedWallet && tx.from.toLowerCase() !== expectedWallet.toLowerCase()) {
          this.dispatch({
            type: 'RPC_TIMEOUT',
            msg: `Hash ${hash.slice(0, 10)}… rejected: transaction sender (${tx.from}) does not match stored wallet (${expectedWallet}).`,
          })
          return
        }

        // 2. Target must match — null `to` (contract creation) is always a mismatch
        if (!tx.to) {
          this.dispatch({
            type: 'RPC_TIMEOUT',
            msg: `Hash ${hash.slice(0, 10)}… rejected: transaction has no target address (contract creation).`,
          })
          return
        }
        if (expectedTarget && tx.to.toLowerCase() !== expectedTarget.toLowerCase()) {
          this.dispatch({
            type: 'RPC_TIMEOUT',
            msg: `Hash ${hash.slice(0, 10)}… rejected: transaction target (${tx.to}) does not match expected (${expectedTarget}).`,
          })
          return
        }

        // 3. Calldata must match exactly
        if (expectedCalldata && tx.input.toLowerCase() !== expectedCalldata.toLowerCase()) {
          this.dispatch({
            type: 'RPC_TIMEOUT',
            msg: `Hash ${hash.slice(0, 10)}… rejected: transaction calldata does not match stored record.`,
          })
          return
        }

        // 4. Nonce must be exactly the observed nonce (same-nonce replacement)
        if (expectedNonce !== undefined && tx.nonce !== expectedNonce) {
          this.dispatch({
            type: 'RPC_TIMEOUT',
            msg: `Hash ${hash.slice(0, 10)}… rejected: transaction nonce (${tx.nonce}) does not match expected nonce (${expectedNonce}).`,
          })
          return
        }

        // 5. Block must be >= startBlock
        if (expectedStart !== undefined && tx.blockNumber !== null && tx.blockNumber < expectedStart) {
          this.dispatch({
            type: 'RPC_TIMEOUT',
            msg: `Hash ${hash.slice(0, 10)}… rejected: transaction block (${tx.blockNumber}) is before the recorded start block (${expectedStart}).`,
          })
          return
        }
      } catch (txErr) {
        this.dispatch({
          type: 'RPC_TIMEOUT',
          msg: `Could not fetch transaction ${hash.slice(0, 10)}…: ${txErr instanceof Error ? txErr.message : 'unknown'}. Check the explorer directly.`,
        })
        return
      }
    }

    // Hash accepted (same hash or proven replacement) — fetch and verify receipt
    try {
      const receipt = await this.rpc.getTransactionReceipt(hash)

      // Build a PendingContext for verifyReceipt (intent-only case has no ctx yet)
      const verifyCtx: PendingContext = ctx ?? {
        version: PENDING_VERSION,
        hash,
        chainId: this.chainId,
        contractAddress: intent!.contractAddress,
        poolId: intent!.poolId,
        walletAddress: intent!.walletAddress,
        action: intent!.action,
        expectedAmount: intent!.amount,
        expectedCount:  intent!.count,
        approvalSpender: intent!.approvalSpender,
      }

      const result = verifyReceipt(receipt, { ...verifyCtx, hash }, this.usdcAddress)
      if (result.ok) {
        this.clearBothStorage()
        this.releaseLatch()
        if (verifyCtx.action === 'approve') {
          this.dispatch({ type: 'APPROVAL_DONE' })
        } else {
          this.dispatch({ type: 'SUCCESS', hash, action: verifyCtx.action, amount: result.amount })
          this.onSuccess()
        }
      } else if (receipt.status === 'reverted') {
        // Only a proven revert of this accepted hash releases the latch
        this.clearBothStorage()
        this.releaseLatch()
        this.dispatch({ type: 'TX_FAILED', msg: `Transaction ${hash.slice(0, 10)}… was reverted on-chain.` })
      } else {
        this.dispatch({
          type: 'RPC_TIMEOUT',
          msg: `Hash ${hash.slice(0, 10)}… found on-chain but verification failed: ${result.msg}. Writes remain blocked.`,
        })
      }
    } catch {
      this.dispatch({
        type: 'RPC_TIMEOUT',
        msg: `Could not fetch receipt for ${hash.slice(0, 10)}…. Check the explorer directly.`,
      })
    }
  }
}

// ── Live RpcAdapter ────────────────────────────────────────────────────────────

export function makeViemRpcAdapter(
  publicClient: import('viem').PublicClient,
): RpcAdapter {
  return {
    getChainId: () => publicClient.getChainId(),
    getCode: (a) => publicClient.getCode({ address: a }).then(v => v ?? '0x'),
    readContract_usdc: (a) =>
      publicClient.readContract({ address: a, abi: REFLOW_POOLS_ABI, functionName: 'usdc' }),
    readContract_decimals: (a) =>
      publicClient.readContract({ address: a, abi: erc20Abi, functionName: 'decimals' }),
    readContract_poolExists: async (c, poolId) => {
      const pool = await publicClient.readContract({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'getPool', args: [poolId] })
      return (pool as { exists: boolean }).exists
    },
    readContract_balanceOf: (a, owner) =>
      publicClient.readContract({ address: a, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    readContract_allowance: (a, owner, spender) =>
      publicClient.readContract({ address: a, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }),
    simulateApprove: (usdc, spender, amount, account) =>
      publicClient.simulateContract({ address: usdc, abi: erc20Abi, functionName: 'approve', args: [spender, amount], account }).then(() => undefined),
    simulatePurchaseFirst: (c, p, m, acc) =>
      publicClient.simulateContract({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [p, m], account: acc }).then(() => undefined),
    simulateJoin: (c, p, ec, mc, acc) =>
      publicClient.simulateContract({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'join', args: [p, ec, mc], account: acc }).then(() => undefined),
    simulateClaim: (c, p, b, acc) =>
      publicClient.simulateContract({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'claimFor', args: [p, b], account: acc }).then(() => undefined),
    estimateGas_approve: (a, spender, amount, acc) =>
      publicClient.estimateContractGas({ address: a, abi: erc20Abi, functionName: 'approve', args: [spender, amount], account: acc }),
    estimateGas_purchaseFirst: (c, p, m, acc) =>
      publicClient.estimateContractGas({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [p, m], account: acc }),
    estimateGas_join: (c, p, ec, mc, acc) =>
      publicClient.estimateContractGas({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'join', args: [p, ec, mc], account: acc }),
    estimateGas_claim: (c, p, b, acc) =>
      publicClient.estimateContractGas({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'claimFor', args: [p, b], account: acc }),
    getGasPrice: () => publicClient.getGasPrice(),
    getTransactionCount: (a) => publicClient.getTransactionCount({ address: a }),
    getBlockNumber: () => publicClient.getBlockNumber(),
    getTransactionReceipt: (h) => publicClient.getTransactionReceipt({ hash: h }),
    getNativeBalance: (a) => publicClient.getBalance({ address: a }),
    getTransaction: async (h) => {
      const tx = await publicClient.getTransaction({ hash: h })
      return { from: tx.from, to: tx.to ?? null, input: tx.input, nonce: tx.nonce, blockNumber: tx.blockNumber }
    },
  }
}

// ── Re-export for tests ────────────────────────────────────────────────────────
export { decodeEventLog, toEventSelector }
export const ERC20_APPROVAL_TOPIC = toEventSelector('Approval(address,address,uint256)')
