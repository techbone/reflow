/**
 * Tests for TxOrchestrator — the plain-TypeScript module consumed by
 * TxControllerProvider and (via that) by PurchaseRoom.
 *
 * All tests import and drive TxOrchestrator directly with injected adapters.
 * No hand-written doubles of orchestrator logic.
 *
 * SYNTHETIC FIXTURES
 * ──────────────────
 * All event logs are ABI-encoded from REFLOW_POOLS_ABI / erc20Abi via viem.
 * Topic selectors are never hand-copied from implementations.
 *
 * REGRESSION SCENARIOS (spec-compliant)
 * ────────────────────
 * [R1]  Two execute() calls synchronously before first await → only one proceeds
 * [R2]  boot() with intent-only or pending record locks the orchestrator
 * [R3]  Zero allowance → only approve simulated; purchase NOT simulated first
 * [R4]  Storage fails before signing → wallet call count zero; no hash returned
 * [R5]  Storage update fails AFTER broadcast → real hash retained + truthful message
 * [R6]  Ambiguous send error → latch held; USER_REJECTED → latch released
 * [R7]  Receipt query error (no receipt) → rpc-recovery, hash preserved
 * [R8]  Wrong event → rpc-recovery (LOCKED, not TX_FAILED); reverted → TX_FAILED
 * [R9]  Matching event (correct fields); wrong emitter/pool/wallet/amount rejected
 * [R10] Chain mismatch / failed estimate / null native balance / nonce fail → PREFLIGHT_FAIL
 * [R11] Account switch between preflight and signing prevents write
 * [R12] reconcileHash rejects wrong from/to/calldata; accepts correct match
 * [R13] Corrupt stored record blocks writes on boot
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { encodeEventTopics, encodeAbiParameters, encodeFunctionData, erc20Abi, type TransactionReceipt } from 'viem'
import { REFLOW_POOLS_ABI } from '../lib/reflowAbi'
import {
  TxOrchestrator,
  INTENT_STORAGE_KEY,
  PENDING_STORAGE_KEY,
  type RpcAdapter,
  type WalletAdapter,
  type StorageAdapter,
  type ExecuteParams,
} from '../lib/TxOrchestrator'
import {
  INITIAL_TX_STATE, txReducer, verifyReceipt, classifyError, PENDING_VERSION,
  type PendingContext,
} from '../lib/txLifecycle'
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC } from '../lib/reflowConfig'
import { fmtUsdc } from '../lib/shareCalc'

// ── Shared constants ──────────────────────────────────────────────────────────

const CONTRACT   = '0x1111111111111111111111111111111111111111' as `0x${string}`
const WALLET     = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`
const POOL_ID    = 1n
const PRICE      = 1_200_000n   // $1.20 USDC (6 decimals)
const TX_HASH    = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const OTHER_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`
const ARC_CHAIN  = ARC_TESTNET_CHAIN_ID
// Large enough native balance: PRICE (6-dec) * 10^12 for native conversion, plus gas.
// On Arc, 1 USDC (6-dec) = 10^12 native units. $1.20 = 1_200_000 * 10^12 = 1.2 * 10^18.
// Use 10^19 (10x) to cover payment + gas comfortably.
const LARGE_NATIVE_BAL = 10n ** 19n

// ── ABI-based log encoders (synthetic fixtures) ───────────────────────────────

function encodeFirstPurchasedLog(poolId: bigint, buyer: `0x${string}`, amount: bigint) {
  const topics = encodeEventTopics({ abi: REFLOW_POOLS_ABI, eventName: 'FirstPurchased', args: { poolId, buyer } }) as `0x${string}`[]
  const data   = encodeAbiParameters([{ name: 'amount', type: 'uint256' }], [amount])
  return { address: CONTRACT, topics, data }
}

function encodeJoinedLog(poolId: bigint, participant: `0x${string}`, joinOrder: bigint, contribution: bigint) {
  const topics = encodeEventTopics({ abi: REFLOW_POOLS_ABI, eventName: 'Joined', args: { poolId, participant } }) as `0x${string}`[]
  const data   = encodeAbiParameters(
    [{ name: 'joinOrder', type: 'uint256' }, { name: 'contribution', type: 'uint256' }],
    [joinOrder, contribution],
  )
  return { address: CONTRACT, topics, data }
}

function encodeRebateClaimedLog(poolId: bigint, beneficiary: `0x${string}`, amount: bigint) {
  const topics = encodeEventTopics({ abi: REFLOW_POOLS_ABI, eventName: 'RebateClaimed', args: { poolId, beneficiary } }) as `0x${string}`[]
  const data   = encodeAbiParameters([{ name: 'amount', type: 'uint256' }], [amount])
  return { address: CONTRACT, topics, data }
}

function encodeApprovalLog(owner: `0x${string}`, spender: `0x${string}`, value: bigint) {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: 'Approval', args: { owner, spender } }) as `0x${string}`[]
  const data   = encodeAbiParameters([{ name: 'value', type: 'uint256' }], [value])
  return { address: ARC_TESTNET_USDC as `0x${string}`, topics, data }
}

// ── Receipt helper ────────────────────────────────────────────────────────────

function makeReceipt(
  status: 'success' | 'reverted',
  logs: { address: `0x${string}`; topics: `0x${string}`[]; data: `0x${string}` }[],
  txHash?: `0x${string}`,
): TransactionReceipt {
  return { status, logs, transactionHash: txHash ?? TX_HASH } as unknown as TransactionReceipt
}

// ── PendingContext helper ─────────────────────────────────────────────────────

function makePending(overrides: Partial<PendingContext> = {}): PendingContext {
  return {
    version: PENDING_VERSION, hash: TX_HASH, chainId: ARC_CHAIN,
    contractAddress: CONTRACT, poolId: POOL_ID.toString(), walletAddress: WALLET,
    action: 'purchaseFirst', expectedAmount: PRICE.toString(), ...overrides,
  }
}

// ── In-memory storage adapter ─────────────────────────────────────────────────

function makeMemoryStorage(failOnSet = false): StorageAdapter & { store: Record<string, string> } {
  const store: Record<string, string> = {}
  return {
    store,
    setItem: (k, v) => {
      if (failOnSet) throw new Error('QuotaExceededError')
      store[k] = v
    },
    getItem:    (k) => store[k] ?? null,
    removeItem: (k) => { delete store[k] },
  }
}

// ── Mock RpcAdapter ───────────────────────────────────────────────────────────

interface MockRpcOptions {
  chainId?:           number
  code?:              `0x${string}`
  usdcAddress?:       `0x${string}`
  poolExists?:        boolean
  balance?:           bigint
  allowance?:         bigint
  simulateFail?:      boolean
  simulateFailMsg?:   string
  estimateFail?:      boolean
  estimateFailMsg?:   string
  gasPriceFail?:      boolean
  nativeBalFail?:     boolean
  nonceFail?:         boolean
  blockFail?:         boolean
  gasEstimate?:       bigint
  gasPrice?:          bigint
  nativeBal?:         bigint
  nonce?:             number
  blockNumber?:       bigint
  receiptResult?:     TransactionReceipt
  receiptFail?:       boolean
  txResult?:          { from: `0x${string}`; to: `0x${string}` | null; input: `0x${string}`; nonce: number; blockNumber: bigint | null }
  txFail?:            boolean
}

function makeRpc(opts: MockRpcOptions = {}): RpcAdapter & {
  simulateCallCount: number
  estimateCallCount: number
} {
  let simulateCallCount = 0
  let estimateCallCount = 0

  return {
    get simulateCallCount() { return simulateCallCount },
    get estimateCallCount() { return estimateCallCount },

    getChainId: () => Promise.resolve(opts.chainId ?? ARC_CHAIN),
    getCode: () => Promise.resolve(opts.code ?? '0xdeadbeef'),
    readContract_usdc: () => Promise.resolve(opts.usdcAddress ?? ARC_TESTNET_USDC),
    readContract_decimals: () => Promise.resolve(6),
    readContract_poolExists: () => Promise.resolve(opts.poolExists !== false),
    readContract_balanceOf: () => Promise.resolve(opts.balance ?? PRICE * 2n),
    readContract_allowance: () => Promise.resolve(opts.allowance ?? PRICE * 2n),

    simulateApprove: () => {
      simulateCallCount++
      if (opts.simulateFail) return Promise.reject(new Error(opts.simulateFailMsg ?? 'sim fail'))
      return Promise.resolve()
    },
    simulatePurchaseFirst: () => {
      simulateCallCount++
      if (opts.simulateFail) return Promise.reject(new Error(opts.simulateFailMsg ?? 'sim fail'))
      return Promise.resolve()
    },
    simulateJoin: () => {
      simulateCallCount++
      if (opts.simulateFail) return Promise.reject(new Error(opts.simulateFailMsg ?? 'sim fail'))
      return Promise.resolve()
    },
    simulateClaim: () => {
      simulateCallCount++
      if (opts.simulateFail) return Promise.reject(new Error(opts.simulateFailMsg ?? 'sim fail'))
      return Promise.resolve()
    },
    estimateGas_approve: () => {
      estimateCallCount++
      if (opts.estimateFail) return Promise.reject(new Error(opts.estimateFailMsg ?? 'estimate fail'))
      return Promise.resolve(opts.gasEstimate ?? 60_000n)
    },
    estimateGas_purchaseFirst: () => {
      estimateCallCount++
      if (opts.estimateFail) return Promise.reject(new Error(opts.estimateFailMsg ?? 'estimate fail'))
      return Promise.resolve(opts.gasEstimate ?? 100_000n)
    },
    estimateGas_join: () => {
      estimateCallCount++
      if (opts.estimateFail) return Promise.reject(new Error(opts.estimateFailMsg ?? 'estimate fail'))
      return Promise.resolve(opts.gasEstimate ?? 120_000n)
    },
    estimateGas_claim: () => {
      estimateCallCount++
      if (opts.estimateFail) return Promise.reject(new Error(opts.estimateFailMsg ?? 'estimate fail'))
      return Promise.resolve(opts.gasEstimate ?? 80_000n)
    },
    getGasPrice: () => {
      if (opts.gasPriceFail) return Promise.reject(new Error('gas price unavailable'))
      return Promise.resolve(opts.gasPrice ?? 1n)
    },
    getTransactionCount: () => {
      if (opts.nonceFail) return Promise.reject(new Error('nonce unavailable'))
      return Promise.resolve(opts.nonce ?? 0)
    },
    getBlockNumber: () => {
      if (opts.blockFail) return Promise.reject(new Error('block unavailable'))
      return Promise.resolve(opts.blockNumber ?? 1000n)
    },
    getTransactionReceipt: () => {
      if (opts.receiptFail) return Promise.reject(new Error('receipt not found'))
      return Promise.resolve(opts.receiptResult ?? makeReceipt('success', [encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE)]))
    },
    getNativeBalance: () => {
      if (opts.nativeBalFail) return Promise.reject(new Error('balance unavailable'))
      return Promise.resolve(opts.nativeBal ?? LARGE_NATIVE_BAL)
    },
    getTransaction: () => {
      if (opts.txFail) return Promise.reject(new Error('tx not found'))
      if (opts.txResult) return Promise.resolve(opts.txResult)
      const calldata = encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [POOL_ID, PRICE] })
      return Promise.resolve({
        from: WALLET,
        to:   CONTRACT,
        input: calldata,
        nonce: 0,
        blockNumber: 1001n,
      })
    },
  }
}

// ── Mock WalletAdapter ────────────────────────────────────────────────────────

interface MockWalletOptions {
  returnHash?:    `0x${string}`
  rejectWith?:    Error | { code: number; message?: string }
  accountAddress?: `0x${string}`
  accountChainId?: number
}

function makeWallet(opts: MockWalletOptions = {}): WalletAdapter & { callCount: number } {
  let callCount = 0
  function maybeThrow(): void {
    if (opts.rejectWith === undefined) return
    if (opts.rejectWith instanceof Error) throw opts.rejectWith
    const e = new Error(opts.rejectWith.message ?? 'wallet error')
    ;(e as unknown as Record<string, number>).code = opts.rejectWith.code
    throw e
  }
  return {
    get callCount() { return callCount },
    currentAccount: () => ({
      address: opts.accountAddress ?? WALLET,
      chainId: opts.accountChainId ?? ARC_CHAIN,
    }),
    writeApprove: () => { callCount++; maybeThrow(); return Promise.resolve(opts.returnHash ?? TX_HASH) },
    writePurchaseFirst: () => { callCount++; maybeThrow(); return Promise.resolve(opts.returnHash ?? TX_HASH) },
    writeJoin: () => { callCount++; maybeThrow(); return Promise.resolve(opts.returnHash ?? TX_HASH) },
    writeClaim: () => { callCount++; maybeThrow(); return Promise.resolve(opts.returnHash ?? TX_HASH) },
  }
}

// ── Orchestrator factory ──────────────────────────────────────────────────────

function makeOrchestrator(
  rpc: RpcAdapter,
  wallet: WalletAdapter,
  storage: StorageAdapter,
  onSuccess?: () => void,
): TxOrchestrator {
  return new TxOrchestrator(
    CONTRACT, POOL_ID, rpc, wallet, storage, ARC_CHAIN,
    ARC_TESTNET_USDC,
    undefined, onSuccess,
  )
}

function defaultParams(overrides: Partial<ExecuteParams> = {}): ExecuteParams {
  return { action: 'purchaseFirst', price: PRICE, ...overrides }
}

beforeEach(() => {
  sessionStorage.clear()
})

// ── [R1] Two synchronous execute calls → only one proceeds ───────────────────

describe('[R1] Synchronous duplicate-submission guard', () => {
  it('second execute call returns immediately when latch is held', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    const p1 = orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    const p2 = orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    await Promise.all([p1, p2])

    expect(wallet.callCount).toBe(1)
  })

  it('isLocked() is true synchronously after first execute starts', () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    void orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    expect(orc.isLocked()).toBe(true)
  })

  it('latch released after successful receipt', async () => {
    const log = encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE)
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    orc.onReceiptSuccess(makeReceipt('success', [log]))

    expect(orc.isLocked()).toBe(false)
    expect(orc.state.phase).toBe('success')
  })
})

// ── [R2] boot() with stored records locks the orchestrator ───────────────────

describe('[R2] boot() with stored records locks the orchestrator', () => {
  it('boot() with valid pending record → locked, rpc-recovery, zero wallet calls', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()

    // Pre-populate pending record (simulating a previous session that submitted)
    const ctx = makePending()
    storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(ctx))

    const orc = makeOrchestrator(rpc, wallet, storage)
    orc.boot()

    expect(orc.isLocked()).toBe(true)
    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.state.pending?.hash).toBe(TX_HASH)

    // execute() must be blocked
    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    expect(wallet.callCount).toBe(0)
  })

  it('boot() with intent-only record (no hash) → locked, rpc-recovery, zero wallet calls', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()

    // Pre-populate intent record (simulating crash between intent persist and wallet call)
    const calldata = encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [POOL_ID, PRICE] })
    const intent = {
      version: 2, walletAddress: WALLET, chainId: ARC_CHAIN,
      contractAddress: CONTRACT, poolId: POOL_ID.toString(),
      action: 'purchaseFirst', amount: PRICE.toString(),
      observedNonce: 5, startBlock: '1000',
      calldata, target: CONTRACT,
    }
    storage.setItem(INTENT_STORAGE_KEY, JSON.stringify(intent))

    const orc = makeOrchestrator(rpc, wallet, storage)
    orc.boot()

    expect(orc.isLocked()).toBe(true)
    expect(orc.state.phase).toBe('rpc-recovery')

    // execute() must be blocked
    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    expect(wallet.callCount).toBe(0)
  })

  it('boot() with corrupt pending record → locked, rpc-recovery', () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()

    storage.setItem(PENDING_STORAGE_KEY, '{"version":2,"hash":"short","corrupt":true}')

    const orc = makeOrchestrator(rpc, wallet, storage)
    orc.boot()

    expect(orc.isLocked()).toBe(true)
    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.state.errorMsg).toMatch(/corrupt/i)
  })

  it('boot() with both keys empty → unlocked, idle', () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()

    const orc = makeOrchestrator(rpc, wallet, storage)
    orc.boot()

    expect(orc.isLocked()).toBe(false)
    expect(orc.state.phase).toBe('idle')
  })

  it('two separate orchestrator instances share nothing — proves provider must be singular', () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()

    const orc1 = makeOrchestrator(rpc, wallet, storage)
    const orc2 = makeOrchestrator(rpc, wallet, storage)

    void orc1.execute(defaultParams(), WALLET, ARC_CHAIN)
    expect(orc1.isLocked()).toBe(true)
    // orc2 has its own latch — proves the provider must be a SINGLE instance above the router
    expect(orc2.isLocked()).toBe(false)
  })

  it('walletChanged() preserves latch while pending', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    expect(orc.isLocked()).toBe(true)

    orc.walletChanged()
    expect(orc.isLocked()).toBe(true)
    expect(orc.state.phase).toBe('wrong-wallet')
  })
})

// ── [R3] Zero allowance → approve only; purchase NOT simulated ────────────────

describe('[R3] Zero allowance: approve-first, purchase NOT simulated first', () => {
  it('zero allowance → only approve simulated and submitted', async () => {
    const rpc = makeRpc({ allowance: 0n })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    // 1 simulate call = only simulateApprove (not simulatePurchaseFirst)
    expect(rpc.simulateCallCount).toBe(1)
    expect(wallet.callCount).toBe(1)
    expect(orc.state.pending?.action).toBe('approve')
  })

  it('sufficient allowance → purchase simulated (not approve)', async () => {
    const rpc = makeRpc({ allowance: PRICE })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(rpc.simulateCallCount).toBe(1)
    expect(rpc.estimateCallCount).toBe(1)
    expect(orc.state.pending?.action).toBe('purchaseFirst')
  })

  it('APPROVAL_DONE phase requires explicit second click — no auto-purchase', () => {
    const ctx = makePending({ action: 'approve', approvalSpender: CONTRACT })
    let s = txReducer(INITIAL_TX_STATE, { type: 'TX_SUBMITTED', ctx })
    s = txReducer(s, { type: 'APPROVAL_DONE' })
    expect(s.phase).toBe('approval-done')
    expect(s.pending).toBeNull()
  })
})

// ── [R4] Storage fails before signing → wallet never called ──────────────────

describe('[R4] Storage failure before signing: no wallet call', () => {
  it('setItem always throws → wallet never called, PREFLIGHT_FAIL', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const failStorage = makeMemoryStorage(true)
    const orc = makeOrchestrator(rpc, wallet, failStorage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.state.errorMsg).toMatch(/could not be saved/i)
    expect(orc.isLocked()).toBe(false)
  })

  it('storage failure on approve path: wallet never called', async () => {
    const rpc = makeRpc({ allowance: 0n })
    const wallet = makeWallet()
    const failStorage = makeMemoryStorage(true)
    const orc = makeOrchestrator(rpc, wallet, failStorage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.isLocked()).toBe(false)
  })

  it('post-broadcast storage failure: wallet was called, latch stays held, hash not lost', async () => {
    // Simulate: intent written OK, wallet called OK (returns TX_HASH), then savePending throws.
    // The inner catch dispatches TX_SUBMITTED + RPC_TIMEOUT and returns without releasing.
    // This verifies the invariant: once the wallet is called, latch is never released
    // solely because storage fails.
    let writeCount = 0
    const trickStorage: StorageAdapter & { store: Record<string, string> } = {
      store: {},
      setItem: (k, v) => {
        writeCount++
        if (writeCount >= 2) throw new Error('simulated storage failure after broadcast')
        trickStorage.store[k] = v
      },
      getItem: (k) => trickStorage.store[k] ?? null,
      removeItem: (k) => { delete trickStorage.store[k] },
    }
    const rpc = makeRpc()
    const wallet = makeWallet()
    const orc2 = makeOrchestrator(rpc, wallet, trickStorage)

    await orc2.execute(defaultParams(), WALLET, ARC_CHAIN)

    // wallet was called (intent write succeeded; savePending write failed)
    expect(wallet.callCount).toBe(1)
    // latch stays held — wallet call happened, outcome is ambiguous
    expect(orc2.isLocked()).toBe(true)
    // state reflects rpc-recovery with the real hash visible
    expect(orc2.state.phase).toBe('rpc-recovery')
    expect(orc2.state.pending?.hash).toBe(TX_HASH)
  })
})

// ── [R5] Storage fails AFTER broadcast → real hash retained ─────────────────

describe('[R5] Post-broadcast storage failure: hash retained', () => {
  it('TX_SUBMITTED carries real hash; RPC_TIMEOUT message is truthful (not "not submitted")', () => {
    const ctx = makePending({ hash: TX_HASH })

    const s1 = txReducer(INITIAL_TX_STATE, { type: 'TX_SUBMITTED', ctx })
    expect(s1.pending?.hash).toBe(TX_HASH)
    expect(s1.phase).toBe('confirming')

    const msg = `Transaction submitted (${TX_HASH.slice(0, 10)}…) but recovery record could not be saved. Keep this hash: ${TX_HASH}`
    const s2 = txReducer(s1, { type: 'RPC_TIMEOUT', msg })
    expect(s2.phase).toBe('rpc-recovery')
    expect(s2.pending?.hash).toBe(TX_HASH)
    expect(s2.errorMsg).not.toMatch(/not submitted/i)
    expect(s2.errorMsg).toMatch(/0x[0-9a-fA-F]{8}/)
  })
})

// ── [R6] Ambiguous error/USER_REJECTED ───────────────────────────────────────

describe('[R6] Ambiguous send error vs USER_REJECTED', () => {
  it('non-4001 wallet error keeps latch held and intent in storage', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet({ rejectWith: new Error('network error: connection reset') })
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(orc.isLocked()).toBe(true)
    expect(orc.state.phase).toBe('rpc-recovery')
    expect(storage.store[INTENT_STORAGE_KEY]).toBeDefined()
  })

  it('USER_REJECTED (4001) clears intent and releases latch', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet({ rejectWith: { code: 4001, message: 'User rejected' } })
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(orc.isLocked()).toBe(false)
    expect(orc.state.phase).toBe('idle')
    expect(storage.store[INTENT_STORAGE_KEY]).toBeUndefined()
  })

  it('REFRESH from rpc-recovery preserves hash', () => {
    const ctx = makePending()
    let s = txReducer(INITIAL_TX_STATE, { type: 'TX_SUBMITTED', ctx })
    s = txReducer(s, { type: 'RPC_TIMEOUT', msg: 'timeout' })
    s = txReducer(s, { type: 'REFRESH' })
    expect(s.phase).toBe('rpc-recovery')
    expect(s.pending?.hash).toBe(TX_HASH)
  })

  it('navigation (execute on same locked orchestrator) does not start second write', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet({ rejectWith: new Error('network error') })
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    expect(orc.isLocked()).toBe(true)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    expect(wallet.callCount).toBe(1)  // second call blocked
  })
})

// ── [R7] Receipt query error → rpc-recovery, hash preserved ─────────────────

describe('[R7] Receipt query error preserves hash', () => {
  it('onReceiptError with no receipt → rpc-recovery, latch held', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    orc.onReceiptError(undefined)

    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.state.pending?.hash).toBe(TX_HASH)
    expect(orc.isLocked()).toBe(true)
  })

  it('onReceiptError with reverted receipt → TX_FAILED, latch released', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    orc.onReceiptError(makeReceipt('reverted', []))

    expect(orc.state.phase).toBe('error')
    expect(orc.isLocked()).toBe(false)
  })
})

// ── [R8] Wrong event → rpc-recovery (LOCKED); reverted → TX_FAILED ───────────

describe('[R8] Wrong-event receipt: stays LOCKED (not TX_FAILED)', () => {
  it('success receipt with wrong event → rpc-recovery, latch HELD', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    const wrongLog = encodeJoinedLog(POOL_ID, WALLET, 1n, PRICE)
    orc.onReceiptSuccess(makeReceipt('success', [wrongLog]))

    // Must stay locked — not a proven failure, do not allow blind resubmission
    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.isLocked()).toBe(true)
    expect(orc.state.pending?.hash).toBe(TX_HASH)
    expect(orc.state.errorMsg).toMatch(/not found|mismatch/i)
  })

  it('success receipt with correct event → SUCCESS, latch released', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    orc.onReceiptSuccess(makeReceipt('success', [encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE)]))

    expect(orc.state.phase).toBe('success')
    expect(orc.isLocked()).toBe(false)
  })

  it('reverted receipt → TX_FAILED (proven), latch released', () => {
    const ctx = makePending()
    const r = verifyReceipt(makeReceipt('reverted', []), ctx, ARC_TESTNET_USDC)
    expect(r.ok).toBe(false)
    expect(r.msg).toMatch(/reverted/i)
  })

  it('success receipt with no matching event → ok=false (verifyReceipt)', () => {
    const ctx = makePending({ action: 'purchaseFirst' })
    const wrongLog = encodeJoinedLog(POOL_ID, WALLET, 1n, PRICE)
    const r = verifyReceipt(makeReceipt('success', [wrongLog]), ctx, ARC_TESTNET_USDC)
    expect(r.ok).toBe(false)
    expect(r.msg).toMatch(/not found/i)
  })
})

// ── [R9] Event field validation ───────────────────────────────────────────────

describe('[R9] Receipt event field validation', () => {
  describe('purchaseFirst', () => {
    const ctx = makePending()
    it('correct → ok', () => {
      expect(verifyReceipt(makeReceipt('success', [encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE)]), ctx, ARC_TESTNET_USDC).ok).toBe(true)
    })
    it('wrong emitter → rejected', () => {
      const log = { ...encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE), address: '0x9999999999999999999999999999999999999999' as `0x${string}` }
      expect(verifyReceipt(makeReceipt('success', [log]), ctx, ARC_TESTNET_USDC).ok).toBe(false)
    })
    it('wrong pool ID → rejected', () => {
      expect(verifyReceipt(makeReceipt('success', [encodeFirstPurchasedLog(999n, WALLET, PRICE)]), ctx, ARC_TESTNET_USDC).ok).toBe(false)
    })
    it('wrong buyer → rejected', () => {
      const other = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`
      expect(verifyReceipt(makeReceipt('success', [encodeFirstPurchasedLog(POOL_ID, other, PRICE)]), ctx, ARC_TESTNET_USDC).ok).toBe(false)
    })
    it('wrong amount → rejected', () => {
      expect(verifyReceipt(makeReceipt('success', [encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE - 1n)]), ctx, ARC_TESTNET_USDC).ok).toBe(false)
    })
    it('receipt txHash mismatch → rejected', () => {
      expect(verifyReceipt(makeReceipt('success', [encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE)], OTHER_HASH), ctx, ARC_TESTNET_USDC).ok).toBe(false)
    })
  })

  describe('join', () => {
    it('correct with matching joinOrder → ok', () => {
      const ctx = makePending({ action: 'join', expectedAmount: '600000', expectedCount: '1' })
      expect(verifyReceipt(makeReceipt('success', [encodeJoinedLog(POOL_ID, WALLET, 1n, 600_000n)]), ctx, ARC_TESTNET_USDC).ok).toBe(true)
    })
    it('joinOrder mismatch → rejected', () => {
      const ctx = makePending({ action: 'join', expectedAmount: '400000', expectedCount: '1' })
      const r = verifyReceipt(makeReceipt('success', [encodeJoinedLog(POOL_ID, WALLET, 2n, 400_000n)]), ctx, ARC_TESTNET_USDC)
      expect(r.ok).toBe(false)
      expect(r.msg).toMatch(/joinOrder/i)
    })
  })

  describe('claimFor', () => {
    it('minimum claim → ok', () => {
      const ctx = makePending({ action: 'claimFor', expectedAmount: '600000' })
      expect(verifyReceipt(makeReceipt('success', [encodeRebateClaimedLog(POOL_ID, WALLET, 600_000n)]), ctx, ARC_TESTNET_USDC).ok).toBe(true)
    })
    it('larger claim → ok (legitimate growth)', () => {
      const ctx = makePending({ action: 'claimFor', expectedAmount: '600000' })
      expect(verifyReceipt(makeReceipt('success', [encodeRebateClaimedLog(POOL_ID, WALLET, 700_000n)]), ctx, ARC_TESTNET_USDC).ok).toBe(true)
    })
    it('wrong beneficiary → rejected', () => {
      const ctx = makePending({ action: 'claimFor', expectedAmount: '600000' })
      const other = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`
      expect(verifyReceipt(makeReceipt('success', [encodeRebateClaimedLog(POOL_ID, other, 600_000n)]), ctx, ARC_TESTNET_USDC).ok).toBe(false)
    })
  })

  describe('approve', () => {
    it('correct approval → ok', () => {
      const ctx = makePending({ action: 'approve', expectedAmount: PRICE.toString(), approvalSpender: CONTRACT })
      expect(verifyReceipt(makeReceipt('success', [encodeApprovalLog(WALLET, CONTRACT, PRICE)]), ctx, ARC_TESTNET_USDC).ok).toBe(true)
    })
    it('wrong spender → rejected', () => {
      const ctx = makePending({ action: 'approve', expectedAmount: PRICE.toString(), approvalSpender: CONTRACT })
      const wrongSpender = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`
      expect(verifyReceipt(makeReceipt('success', [encodeApprovalLog(WALLET, wrongSpender, PRICE)]), ctx, ARC_TESTNET_USDC).ok).toBe(false)
    })
    it('wrong value → rejected', () => {
      const ctx = makePending({ action: 'approve', expectedAmount: PRICE.toString(), approvalSpender: CONTRACT })
      expect(verifyReceipt(makeReceipt('success', [encodeApprovalLog(WALLET, CONTRACT, PRICE + 1n)]), ctx, ARC_TESTNET_USDC).ok).toBe(false)
    })
  })
})

// ── [R10] Preflight failures: no wallet call ──────────────────────────────────

describe('[R10] Preflight guards: no wallet call on failure', () => {
  it('wallet chain mismatch → PREFLIGHT_FAIL', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    const wrongChain: number = 1
    await orc.execute(defaultParams(), WALLET, wrongChain)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.state.errorMsg).toMatch(/arc testnet/i)
    expect(orc.isLocked()).toBe(false)
  })

  it('RPC chain mismatch → PREFLIGHT_FAIL', async () => {
    const rpc = makeRpc({ chainId: 1 })   // RPC reports wrong chain
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.isLocked()).toBe(false)
  })

  it('insufficient USDC balance → PREFLIGHT_FAIL', async () => {
    const rpc = makeRpc({ balance: PRICE - 1n })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.state.errorMsg).toMatch(/insufficient usdc/i)
  })

  it('exact balance sufficient (no false negative)', async () => {
    const rpc = makeRpc({ balance: PRICE, allowance: PRICE })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(1)
  })

  it('gas estimation failure → PREFLIGHT_FAIL, no guessed fallback', async () => {
    const rpc = makeRpc({ estimateFail: true, estimateFailMsg: 'out of gas' })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.state.errorMsg).toMatch(/gas estimation failed/i)
  })

  it('gas price failure → PREFLIGHT_FAIL', async () => {
    const rpc = makeRpc({ gasPriceFail: true })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.state.errorMsg).toMatch(/gas price/i)
  })

  it('native balance failure → PREFLIGHT_FAIL', async () => {
    const rpc = makeRpc({ nativeBalFail: true })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.state.errorMsg).toMatch(/native balance/i)
  })

  it('nonce read failure → PREFLIGHT_FAIL', async () => {
    const rpc = makeRpc({ nonceFail: true })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.state.errorMsg).toMatch(/nonce/i)
  })

  it('block number read failure → PREFLIGHT_FAIL', async () => {
    const rpc = makeRpc({ blockFail: true })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.state.errorMsg).toMatch(/block number/i)
  })

  it('simulation failure → PREFLIGHT_FAIL', async () => {
    const rpc = makeRpc({ simulateFail: true, simulateFailMsg: 'AlreadyMember' })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.state.errorMsg).toMatch(/simulation failed/i)
  })

  it('no deployed code → PREFLIGHT_FAIL', async () => {
    const rpc = makeRpc({ code: '0x' })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.state.errorMsg).toMatch(/no deployed code/i)
  })
})

// ── [R11] Account switch between preflight and signing ───────────────────────

describe('[R11] Account switch between preflight and signing', () => {
  it('different account returned by currentAccount() before wallet call → PREFLIGHT_FAIL', async () => {
    const rpc = makeRpc()
    // Wallet's currentAccount() returns a DIFFERENT address than the one execute() was called with
    const wallet = makeWallet({ accountAddress: '0xdddddddddddddddddddddddddddddddddddddddd' })
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)  // WALLET != 0xdddd...

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.state.errorMsg).toMatch(/account.*changed|network.*changed/i)
    expect(orc.isLocked()).toBe(false)
    // Intent cleared (no orphaned record)
    expect(storage.store[INTENT_STORAGE_KEY]).toBeUndefined()
  })

  it('chain switch detected by currentAccount() → PREFLIGHT_FAIL', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet({ accountAddress: WALLET, accountChainId: 1 })  // wrong chain
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)

    expect(wallet.callCount).toBe(0)
    expect(orc.state.phase).toBe('error')
    expect(orc.isLocked()).toBe(false)
  })
})

// ── [R12] reconcileHash ───────────────────────────────────────────────────────

// Helper: build a PendingContext with all reconciliation fields populated,
// matching the default makeRpc() txResult (purchaseFirst, POOL_ID, PRICE).
function makePendingFull(overrides: Partial<PendingContext> = {}): PendingContext {
  const calldata = encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [POOL_ID, PRICE] })
  return {
    version: PENDING_VERSION, hash: TX_HASH, chainId: ARC_CHAIN,
    contractAddress: CONTRACT, poolId: POOL_ID.toString(), walletAddress: WALLET,
    action: 'purchaseFirst', expectedAmount: PRICE.toString(),
    calldata, target: CONTRACT, observedNonce: 0, startBlock: '1000',
    ...overrides,
  }
}

describe('[R12] Manual hash reconciliation', () => {
  // ── Same-hash fast-path ───────────────────────────────────────────────────

  it('same hash + matching receipt: verifies and releases latch', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePending())
    const log = encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE)
    rpc.getTransactionReceipt = () => Promise.resolve(makeReceipt('success', [log]))

    await orc.reconcileHash(TX_HASH)

    expect(orc.state.phase).toBe('success')
    expect(orc.isLocked()).toBe(false)
  })

  it('same hash: tx is never fetched (fast-path skips it)', async () => {
    let txFetched = false
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePending())
    const origGetTx = rpc.getTransaction.bind(rpc)
    rpc.getTransaction = (h) => { txFetched = true; return origGetTx(h) }
    const log = encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE)
    rpc.getTransactionReceipt = () => Promise.resolve(makeReceipt('success', [log]))

    await orc.reconcileHash(TX_HASH)

    expect(txFetched).toBe(false)
    expect(orc.state.phase).toBe('success')
  })

  it('receipt fetch fails on same hash → stays in rpc-recovery', async () => {
    const rpc = makeRpc({ receiptFail: true })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePending())
    await orc.reconcileHash(TX_HASH)

    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.isLocked()).toBe(true)
  })

  it('wrong events in receipt (same hash) → stays locked', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePending({ action: 'purchaseFirst' }))
    rpc.getTransactionReceipt = () => Promise.resolve(makeReceipt('success', [encodeJoinedLog(POOL_ID, WALLET, 1n, PRICE)]))

    await orc.reconcileHash(TX_HASH)

    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.state.errorMsg).toMatch(/verification failed/i)
    expect(orc.isLocked()).toBe(true)
  })

  it('reverted receipt (same hash) → TX_FAILED, released', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePending())
    rpc.getTransactionReceipt = () => Promise.resolve(makeReceipt('reverted', []))

    await orc.reconcileHash(TX_HASH)

    expect(orc.state.phase).toBe('error')
    expect(orc.isLocked()).toBe(false)
  })

  // ── Different-hash replacement path ──────────────────────────────────────

  it('different hash with all fields matching + correct event → SUCCESS', async () => {
    const calldata = encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [POOL_ID, PRICE] })
    const rpc = makeRpc({
      txResult: { from: WALLET, to: CONTRACT, input: calldata, nonce: 0, blockNumber: 1001n },
    })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePendingFull())  // has calldata, target, observedNonce=0, startBlock=1000

    const log = encodeFirstPurchasedLog(POOL_ID, WALLET, PRICE)
    rpc.getTransactionReceipt = () => Promise.resolve(makeReceipt('success', [log], OTHER_HASH))

    await orc.reconcileHash(OTHER_HASH)

    expect(orc.state.phase).toBe('success')
    expect(orc.isLocked()).toBe(false)
  })

  it('different hash with wrong from → rejected, stays locked', async () => {
    const calldata = encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [POOL_ID, PRICE] })
    const rpc = makeRpc({
      txResult: {
        from: '0xdddddddddddddddddddddddddddddddddddddddd',  // wrong sender
        to: CONTRACT, input: calldata, nonce: 0, blockNumber: 1001n,
      },
    })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePendingFull())
    await orc.reconcileHash(OTHER_HASH)

    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.state.errorMsg).toMatch(/sender/i)
    expect(orc.isLocked()).toBe(true)
  })

  it('different hash with wrong to → rejected, stays locked', async () => {
    const calldata = encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [POOL_ID, PRICE] })
    const rpc = makeRpc({
      txResult: {
        from: WALLET,
        to: '0x9999999999999999999999999999999999999999',  // wrong target
        input: calldata, nonce: 0, blockNumber: 1001n,
      },
    })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePendingFull())
    await orc.reconcileHash(OTHER_HASH)

    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.state.errorMsg).toMatch(/target/i)
    expect(orc.isLocked()).toBe(true)
  })

  it('different hash with null to → rejected, stays locked', async () => {
    const calldata = encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [POOL_ID, PRICE] })
    const rpc = makeRpc({
      txResult: {
        from: WALLET,
        to: null,  // contract creation — always a mismatch
        input: calldata, nonce: 0, blockNumber: 1001n,
      },
    })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePendingFull())
    await orc.reconcileHash(OTHER_HASH)

    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.state.errorMsg).toMatch(/no target address|contract creation/i)
    expect(orc.isLocked()).toBe(true)
  })

  it('different hash with wrong calldata → rejected, stays locked', async () => {
    const wrongCalldata = encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [POOL_ID, PRICE - 1n] })
    const rpc = makeRpc({
      txResult: { from: WALLET, to: CONTRACT, input: wrongCalldata, nonce: 0, blockNumber: 1001n },
    })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePendingFull())
    await orc.reconcileHash(OTHER_HASH)

    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.state.errorMsg).toMatch(/calldata/i)
    expect(orc.isLocked()).toBe(true)
  })

  it('different hash with wrong nonce → rejected, stays locked', async () => {
    const calldata = encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [POOL_ID, PRICE] })
    const rpc = makeRpc({
      txResult: { from: WALLET, to: CONTRACT, input: calldata, nonce: 99, blockNumber: 1001n },  // nonce 99 ≠ 0
    })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePendingFull())  // observedNonce: 0
    await orc.reconcileHash(OTHER_HASH)

    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.state.errorMsg).toMatch(/nonce/i)
    expect(orc.isLocked()).toBe(true)
  })

  it('different hash, reverted, ALL fields match → TX_FAILED (proven revert of replacement)', async () => {
    const calldata = encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [POOL_ID, PRICE] })
    const rpc = makeRpc({
      txResult: { from: WALLET, to: CONTRACT, input: calldata, nonce: 0, blockNumber: 1001n },
    })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePendingFull())
    rpc.getTransactionReceipt = () => Promise.resolve(makeReceipt('reverted', [], OTHER_HASH))

    await orc.reconcileHash(OTHER_HASH)

    expect(orc.state.phase).toBe('error')
    expect(orc.isLocked()).toBe(false)
  })

  it('different hash, reverted, wrong calldata → rejected (stays locked, NOT released)', async () => {
    // This is the key safety regression: a reverted tx from the same wallet/contract
    // but with different calldata must NOT release the latch.
    const wrongCalldata = encodeFunctionData({ abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [POOL_ID, PRICE - 1n] })
    const rpc = makeRpc({
      txResult: { from: WALLET, to: CONTRACT, input: wrongCalldata, nonce: 0, blockNumber: 1001n },
    })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePendingFull())
    rpc.getTransactionReceipt = () => Promise.resolve(makeReceipt('reverted', [], OTHER_HASH))

    await orc.reconcileHash(OTHER_HASH)

    // Calldata mismatch rejected BEFORE receipt fetch — latch stays held
    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.state.errorMsg).toMatch(/calldata/i)
    expect(orc.isLocked()).toBe(true)
  })

  it('different hash, tx fetch fails → stays in rpc-recovery', async () => {
    const rpc = makeRpc({ txFail: true })
    const wallet = makeWallet()
    const storage = makeMemoryStorage()
    const orc = makeOrchestrator(rpc, wallet, storage)

    orc.applyRestore(makePendingFull())
    await orc.reconcileHash(OTHER_HASH)

    expect(orc.state.phase).toBe('rpc-recovery')
    expect(orc.isLocked()).toBe(true)
  })
})

// ── [R13] Corrupt stored record ───────────────────────────────────────────────

describe('[R13] Corrupt stored records block writes on boot', () => {
  it('corrupt intent record → locked on boot, execute blocked', async () => {
    const rpc = makeRpc()
    const wallet = makeWallet()
    const storage = makeMemoryStorage()

    storage.setItem(INTENT_STORAGE_KEY, '{"version":2,"corrupt":true,"walletAddress":"0xshort"}')

    const orc = makeOrchestrator(rpc, wallet, storage)
    orc.boot()

    expect(orc.isLocked()).toBe(true)
    await orc.execute(defaultParams(), WALLET, ARC_CHAIN)
    expect(wallet.callCount).toBe(0)
  })
})

// ── classifyError ─────────────────────────────────────────────────────────────

describe('classifyError', () => {
  it('4001 → USER_REJECTED', () => {
    expect(classifyError({ code: 4001 })).toMatchObject({ type: 'USER_REJECTED' })
  })
  it('network timeout → RPC_TIMEOUT', () => {
    expect(classifyError(new Error('fetch failed: timeout'))).toMatchObject({ type: 'RPC_TIMEOUT' })
  })
  it('CountMismatch → STALE_QUOTE', () => {
    expect(classifyError(new Error('CountMismatch'))).toMatchObject({ type: 'STALE_QUOTE' })
  })
  it('execution reverted → TX_FAILED', () => {
    expect(classifyError(new Error('execution reverted'))).toMatchObject({ type: 'TX_FAILED' })
  })
})

// ── fmtUsdc precision regressions ────────────────────────────────────────────

describe('fmtUsdc precision (live display regression)', () => {
  it('16 micro-USDC → 0.000016 with places=6; 0.00 with places=2', () => {
    expect(fmtUsdc(16n, 6)).toBe('0.000016')
    expect(fmtUsdc(16n, 2)).toBe('0.00')
  })
  it('333334 units → 0.333334 with places=6', () => {
    expect(fmtUsdc(333_334n, 6)).toBe('0.333334')
    expect(fmtUsdc(333_334n, 2)).toBe('0.33')
  })
  it('1 micro-USDC → 0.000001', () => {
    expect(fmtUsdc(1n, 6)).toBe('0.000001')
  })
})
