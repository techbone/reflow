/**
 * TxController — React wrapper around TxOrchestrator.
 *
 * TxControllerProvider is mounted ABOVE all routes (never unmounted by
 * navigation) and owns ONE TxOrchestrator instance for the application
 * lifetime. The latch inside TxOrchestrator is therefore never reset by
 * route switches.
 *
 * PurchaseRoom consumes the context value via useTxController() and calls
 * controller.execute() — it holds no write hooks, no reducer, no busy ref.
 */

import {
  createContext, useContext, useRef, useState, useEffect, useCallback,
  type ReactNode,
} from 'react'
import {
  useAccount, useWriteContract, useWaitForTransactionReceipt,
  usePublicClient,
} from 'wagmi'
import { erc20Abi } from 'viem'
import { REFLOW_CONFIG } from './reflowConfig'
import { NETWORK } from './network'
import { REFLOW_POOLS_ABI } from './reflowAbi'
import {
  TxOrchestrator,
  sessionStorageAdapter,
  makeViemRpcAdapter,
  type ExecuteParams,
  type WalletAdapter,
} from './TxOrchestrator'
import { type TxState, type TxEvent } from './txLifecycle'

export type { ExecuteParams }

const CHAIN = NETWORK.chainId

// ── Context value ─────────────────────────────────────────────────────────────

export interface TxControllerValue {
  txState:        TxState
  isBusy:         () => boolean
  dispatch:       (e: TxEvent) => void
  execute:        (params: ExecuteParams) => Promise<void>
  refetch:        () => void
  reconcileHash:  (hash: `0x${string}`) => Promise<void>
}

const TxControllerCtx = createContext<TxControllerValue | null>(null)

export function useTxController(): TxControllerValue {
  const ctx = useContext(TxControllerCtx)
  if (!ctx) throw new Error('useTxController must be used inside TxControllerProvider')
  return ctx
}

// ── Provider ──────────────────────────────────────────────────────────────────

interface TxControllerProviderProps {
  children:  ReactNode
  onRefetch: () => void
}

export function TxControllerProvider({ children, onRefetch }: TxControllerProviderProps) {
  const cfg = REFLOW_CONFIG
  const { address, chainId } = useAccount()
  const publicClient = usePublicClient({ chainId: CHAIN })

  // Stable wagmi write hooks
  const { writeContractAsync: writeApprove }  = useWriteContract()
  const { writeContractAsync: writePurchase } = useWriteContract()
  const { writeContractAsync: writeJoin }     = useWriteContract()
  const { writeContractAsync: writeClaim }    = useWriteContract()

  // TxState drives UI re-renders
  const [txState, setTxState] = useState<TxState>(() => ({
    phase: 'idle', pending: null, errorMsg: '',
    confirmedHash: null, confirmedAction: null, confirmedAmount: null,
  }))

  // Refs for current account/chainId — used by currentAccount() which must read
  // the LIVE values, not closure-captured stale ones
  const addressRef  = useRef(address)
  const chainIdRef  = useRef(chainId)
  useEffect(() => { addressRef.current  = address  }, [address])
  useEffect(() => { chainIdRef.current  = chainId  }, [chainId])

  // ── Single TxOrchestrator instance per provider lifetime ─────────────────
  const orchestratorRef = useRef<TxOrchestrator | null>(null)

  // publicClient ref — orchestrator's RPC adapter captures this at construction
  // time, but we need it to update when publicClient changes.
  const publicClientRef = useRef(publicClient)
  useEffect(() => { publicClientRef.current = publicClient }, [publicClient])

  const getOrchestrator = useCallback((): TxOrchestrator | null => {
    if (!cfg.contractAddress || !cfg.poolId) return null
    if (!orchestratorRef.current) {
      const walletAdapter: WalletAdapter = {
        currentAccount: () => ({
          address: addressRef.current ?? ('0x0000000000000000000000000000000000000000'),
          chainId: chainIdRef.current ?? 0,
        }),
        writeApprove: (usdc, spender, amount, account, cId) =>
          writeApprove({ address: usdc, abi: erc20Abi, functionName: 'approve', args: [spender, amount], account, chainId: cId }),
        writePurchaseFirst: (c, p, m, account, cId) =>
          writePurchase({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [p, m], account, chainId: cId }),
        writeJoin: (c, p, ec, mc, account, cId) =>
          writeJoin({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'join', args: [p, ec, mc], account, chainId: cId }),
        writeClaim: (c, p, b, account, cId) =>
          writeClaim({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'claimFor', args: [p, b], account, chainId: cId }),
      }

      // RPC adapter — always reads through the current publicClient ref
      const rpcAdapter = {
        getChainId: async () => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.getChainId()
        },
        getCode: async (a: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          return (await publicClientRef.current.getCode({ address: a })) ?? '0x'
        },
        readContract_usdc: async (a: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.readContract({ address: a, abi: REFLOW_POOLS_ABI, functionName: 'usdc' })
        },
        readContract_decimals: async (a: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.readContract({ address: a, abi: erc20Abi, functionName: 'decimals' })
        },
        readContract_poolExists: async (c: `0x${string}`, poolId: bigint) => {
          if (!publicClientRef.current) throw new Error('No public client')
          const pool = await publicClientRef.current.readContract({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'getPool', args: [poolId] })
          return (pool as { exists: boolean }).exists
        },
        readContract_balanceOf: async (a: `0x${string}`, owner: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.readContract({ address: a, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
        },
        readContract_allowance: async (a: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.readContract({ address: a, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })
        },
        simulateApprove: async (usdc: `0x${string}`, spender: `0x${string}`, amount: bigint, account: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          await publicClientRef.current.simulateContract({ address: usdc, abi: erc20Abi, functionName: 'approve', args: [spender, amount], account })
        },
        simulatePurchaseFirst: async (c: `0x${string}`, p: bigint, m: bigint, acc: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          await publicClientRef.current.simulateContract({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [p, m], account: acc })
        },
        simulateJoin: async (c: `0x${string}`, p: bigint, ec: bigint, mc: bigint, acc: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          await publicClientRef.current.simulateContract({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'join', args: [p, ec, mc], account: acc })
        },
        simulateClaim: async (c: `0x${string}`, p: bigint, b: `0x${string}`, acc: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          await publicClientRef.current.simulateContract({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'claimFor', args: [p, b], account: acc })
        },
        estimateGas_approve: async (a: `0x${string}`, spender: `0x${string}`, amount: bigint, acc: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.estimateContractGas({ address: a, abi: erc20Abi, functionName: 'approve', args: [spender, amount], account: acc })
        },
        estimateGas_purchaseFirst: async (c: `0x${string}`, p: bigint, m: bigint, acc: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.estimateContractGas({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'purchaseFirst', args: [p, m], account: acc })
        },
        estimateGas_join: async (c: `0x${string}`, p: bigint, ec: bigint, mc: bigint, acc: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.estimateContractGas({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'join', args: [p, ec, mc], account: acc })
        },
        estimateGas_claim: async (c: `0x${string}`, p: bigint, b: `0x${string}`, acc: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.estimateContractGas({ address: c, abi: REFLOW_POOLS_ABI, functionName: 'claimFor', args: [p, b], account: acc })
        },
        getGasPrice: async () => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.getGasPrice()
        },
        getTransactionCount: async (a: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.getTransactionCount({ address: a })
        },
        getBlockNumber: async () => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.getBlockNumber()
        },
        getTransactionReceipt: async (h: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.getTransactionReceipt({ hash: h })
        },
        getNativeBalance: async (a: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          return publicClientRef.current.getBalance({ address: a })
        },
        getTransaction: async (h: `0x${string}`) => {
          if (!publicClientRef.current) throw new Error('No public client')
          const tx = await publicClientRef.current.getTransaction({ hash: h })
          return { from: tx.from, to: tx.to ?? null, input: tx.input, nonce: tx.nonce, blockNumber: tx.blockNumber }
        },
      }

      orchestratorRef.current = new TxOrchestrator(
        cfg.contractAddress,
        cfg.poolId,
        rpcAdapter,
        walletAdapter,
        sessionStorageAdapter,
        CHAIN,
        NETWORK.usdc,
        setTxState,
        onRefetch,
      )
    }
    return orchestratorRef.current
  }, [
    cfg.contractAddress, cfg.poolId,
    writeApprove, writePurchase, writeJoin, writeClaim, onRefetch,
  ])

  // ── Boot: restore persisted state once per provider lifetime ─────────────
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    const orc = getOrchestrator()
    if (!orc) return
    orc.boot()
    setTxState({ ...orc.state })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Wallet/chain change ────────────────────────────────────────────────────
  const prevAddressRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (prevAddressRef.current !== undefined && prevAddressRef.current !== address) {
      const orc = getOrchestrator()
      if (orc) {
        orc.walletChanged()
        setTxState({ ...orc.state })
      }
    }
    prevAddressRef.current = address
  }, [address, getOrchestrator])

  // ── Receipt watcher ────────────────────────────────────────────────────────
  const pendingHash = txState.pending?.hash
  const {
    data:      txReceipt,
    isSuccess: txReceiptSuccess,
    isError:   txReceiptError,
  } = useWaitForTransactionReceipt({
    hash:    pendingHash,
    chainId: CHAIN,
    query:   { enabled: !!pendingHash },
  })

  useEffect(() => {
    if (!txReceiptSuccess || !txReceipt) return
    const orc = getOrchestrator()
    if (!orc) return
    orc.onReceiptSuccess(txReceipt)
    setTxState({ ...orc.state })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txReceiptSuccess, txReceipt])

  useEffect(() => {
    if (!txReceiptError) return
    const orc = getOrchestrator()
    if (!orc) return
    orc.onReceiptError(txReceipt)
    setTxState({ ...orc.state })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txReceiptError])

  // ── Exposed callbacks ──────────────────────────────────────────────────────

  const execute = useCallback(async (params: ExecuteParams): Promise<void> => {
    const orc = getOrchestrator()
    if (!orc || !address) return
    await orc.execute(params, address, chainId ?? 0)
    setTxState({ ...orc.state })
  }, [getOrchestrator, address, chainId])

  const dispatch = useCallback((e: TxEvent) => {
    const orc = getOrchestrator()
    if (!orc) return
    if (e.type === 'REFRESH') { orc.refresh(); setTxState({ ...orc.state }) }
    else if (e.type === 'WALLET_CHANGED') { orc.walletChanged(); setTxState({ ...orc.state }) }
  }, [getOrchestrator])

  const reconcileHash = useCallback(async (hash: `0x${string}`): Promise<void> => {
    const orc = getOrchestrator()
    if (!orc) return
    await orc.reconcileHash(hash)
    setTxState({ ...orc.state })
  }, [getOrchestrator])

  const isBusy = useCallback(() => {
    const orc = getOrchestrator()
    return orc?.isLocked() ?? false
  }, [getOrchestrator])

  const value: TxControllerValue = {
    txState,
    isBusy,
    dispatch,
    execute,
    refetch: onRefetch,
    reconcileHash,
  }

  return (
    <TxControllerCtx.Provider value={value}>
      {children}
    </TxControllerCtx.Provider>
  )
}

// Re-export makeViemRpcAdapter for consumers that need it
export { makeViemRpcAdapter }
