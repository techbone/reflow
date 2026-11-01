/**
 * useEventIndexer — bounded event scan for a ReflowPools pool.
 *
 * Fetches FirstPurchased, Joined, RebateCredited, RebateClaimed events
 * from the deployment block in pages of PAGE_SIZE blocks.
 *
 * Rules:
 *  - Starts from cfg.fromBlock (never genesis/0).
 *  - Missing fromBlock disables the indexer entirely (not defaulted to 0).
 *  - Each page is a bounded eth_getLogs call filtered by contract address.
 *  - parseLogs filters by event selector (derived from ABI — never hardcoded).
 *  - Events are deduplicated by txHash+logIndex.
 *  - USDC ERC-20 Transfer logs are NOT fetched to avoid double-counting.
 *  - poolLiability(poolId) is read once per scan for selected-pool totals.
 *  - On RPC failure, state is 'error' — no fake empty history.
 *  - Coverage reported as (scannedTo, chainHead, blocksRemaining).
 *  - Does not require a connected wallet.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { createPublicClient, http, decodeEventLog, toEventSelector, type Log } from 'viem'
import { arcTestnet as _viemTestnet, arc as _viemMainnet } from 'viem/chains'
import { REFLOW_POOLS_ABI } from '@/lib/reflowAbi'
import { REFLOW_CONFIG, NETWORK } from '@/lib/reflowConfig'
import { requireChain } from '@/onchain-facts'

const PAGE_SIZE = 2_000n
const CHAIN_FACTS = requireChain(NETWORK.chainId)

export interface ReflowEvent {
  type:        'FirstPurchased' | 'Joined' | 'RebateCredited' | 'RebateClaimed'
  blockNumber: bigint
  logIndex:    number
  txHash:      `0x${string}`
  poolId:      bigint
  // FirstPurchased + RebateClaimed amount
  amount?:        bigint
  // FirstPurchased
  buyer?:         `0x${string}`
  // Joined
  participant?:   `0x${string}`
  joinOrder?:     bigint
  contribution?:  bigint
  // RebateCredited — ABI param name is 'participant', not 'beneficiary'
  creditParticipant?: `0x${string}`
  // RebateClaimed — ABI param name is 'beneficiary'
  beneficiary?:   `0x${string}`
}

export type IndexerStatus = 'idle' | 'scanning' | 'complete' | 'error'

export interface IndexerState {
  status:          IndexerStatus
  events:          ReflowEvent[]
  scannedTo:       bigint | null
  chainHead:       bigint | null
  blocksRemaining: bigint | null
  poolLiability:   bigint | null
  errorMsg:        string | null
}

const INITIAL: IndexerState = {
  status: 'idle', events: [], scannedTo: null, chainHead: null,
  blocksRemaining: null, poolLiability: null, errorMsg: null,
}

// Selectors derived from the ABI at module load — synchronous, no network call.
// toEventSelector computes keccak256 of the canonical event signature string.
const S_FIRST_PURCHASED  = toEventSelector(REFLOW_POOLS_ABI.find(e => e.type === 'event' && e.name === 'FirstPurchased')!)
const S_JOINED           = toEventSelector(REFLOW_POOLS_ABI.find(e => e.type === 'event' && e.name === 'Joined')!)
const S_REBATE_CREDITED  = toEventSelector(REFLOW_POOLS_ABI.find(e => e.type === 'event' && e.name === 'RebateCredited')!)
const S_REBATE_CLAIMED   = toEventSelector(REFLOW_POOLS_ABI.find(e => e.type === 'event' && e.name === 'RebateClaimed')!)

// Deduplicate by txHash + logIndex
function dedup(events: ReflowEvent[]): ReflowEvent[] {
  const seen = new Set<string>()
  return events.filter(e => {
    const key = `${e.txHash}:${e.logIndex}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Sort deterministically: ascending by blockNumber, then logIndex
function sortEvents(events: ReflowEvent[]): ReflowEvent[] {
  return [...events].sort((a, b) => {
    const bd = Number(a.blockNumber - b.blockNumber)
    if (bd !== 0) return bd
    return a.logIndex - b.logIndex
  })
}

function parseLogs(rawLogs: Log[], poolId: bigint): ReflowEvent[] {
  const results: ReflowEvent[] = []

  for (const log of rawLogs) {
    if (!log.blockNumber || !log.transactionHash) continue
    const base = {
      blockNumber: log.blockNumber,
      logIndex:    log.logIndex ?? 0,
      txHash:      log.transactionHash,
      poolId,
    }

    const topic0 = log.topics[0]?.toLowerCase()

    if (topic0 === S_FIRST_PURCHASED) {
      try {
        const d = decodeEventLog({ abi: REFLOW_POOLS_ABI, eventName: 'FirstPurchased', data: log.data, topics: log.topics })
        const a = d.args
        if (a.poolId !== poolId) continue
        results.push({ type: 'FirstPurchased', ...base, buyer: a.buyer, amount: a.amount })
      } catch { continue }
    } else if (topic0 === S_JOINED) {
      try {
        const d = decodeEventLog({ abi: REFLOW_POOLS_ABI, eventName: 'Joined', data: log.data, topics: log.topics })
        const a = d.args
        if (a.poolId !== poolId) continue
        results.push({ type: 'Joined', ...base, participant: a.participant, joinOrder: a.joinOrder, contribution: a.contribution })
      } catch { continue }
    } else if (topic0 === S_REBATE_CREDITED) {
      try {
        const d = decodeEventLog({ abi: REFLOW_POOLS_ABI, eventName: 'RebateCredited', data: log.data, topics: log.topics })
        // ABI: RebateCredited(uint256 indexed poolId, address indexed participant, uint256 amount)
        // Field name is 'participant' (not 'beneficiary') and 'amount' (not 'credit')
        const a = d.args
        if (a.poolId !== poolId) continue
        results.push({ type: 'RebateCredited', ...base, creditParticipant: a.participant, amount: a.amount })
      } catch { continue }
    } else if (topic0 === S_REBATE_CLAIMED) {
      try {
        const d = decodeEventLog({ abi: REFLOW_POOLS_ABI, eventName: 'RebateClaimed', data: log.data, topics: log.topics })
        const a = d.args
        if (a.poolId !== poolId) continue
        results.push({ type: 'RebateClaimed', ...base, beneficiary: a.beneficiary, amount: a.amount })
      } catch { continue }
    }
  }

  return results
}

export function useEventIndexer(): IndexerState & { rescan: () => void } {
  const cfg = REFLOW_CONFIG
  const [state, setState] = useState<IndexerState>(INITIAL)
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback(async () => {
    if (!cfg.isConfigured || !cfg.contractAddress || cfg.poolId === null) {
      setState({ ...INITIAL, status: 'idle', errorMsg: 'Contract not configured.' })
      return
    }
    if (!cfg.fromBlock) {
      setState({
        ...INITIAL, status: 'idle',
        errorMsg: 'Deployment block not configured. Set VITE_REFLOW_FROM_BLOCK to enable event history.',
      })
      return
    }

    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort

    setState({ ...INITIAL, status: 'scanning' })

    const rpcUrl = CHAIN_FACTS.rpcUrls[0]
    const activeViemChain = NETWORK.isMainnet ? _viemMainnet : _viemTestnet
    const client = createPublicClient({ chain: activeViemChain, transport: http(rpcUrl) })
    const contractAddress = cfg.contractAddress
    const poolId = cfg.poolId
    const fromBlock = cfg.fromBlock

    try {
      const head = await client.getBlockNumber()

      if (abort.signal.aborted) return

      const collected: ReflowEvent[] = []
      let cursor = fromBlock

      while (cursor <= head) {
        if (abort.signal.aborted) return

        const toBlock = cursor + PAGE_SIZE - 1n < head ? cursor + PAGE_SIZE - 1n : head

        setState(s => ({
          ...s,
          status: 'scanning',
          scannedTo: cursor,
          chainHead: head,
          blocksRemaining: head - toBlock,
        }))

        // Filter by contract address. The poolId is the first indexed param on all events,
        // so it is topic[1]. We fetch all events from the contract and filter by selector
        // client-side in parseLogs to catch all four event types in one call.
        const logs = await client.getLogs({
          address: contractAddress,
          fromBlock: cursor,
          toBlock,
        })

        if (abort.signal.aborted) return

        const parsed = parseLogs(logs, poolId)
        collected.push(...parsed)
        cursor = toBlock + 1n
      }

      // Read poolLiability for the selected pool
      let poolLiability: bigint | null = null
      try {
        const raw = await client.readContract({
          address: contractAddress,
          abi: REFLOW_POOLS_ABI,
          functionName: 'poolLiability',
          args: [poolId],
        })
        poolLiability = raw
      } catch { /* non-fatal */ }

      if (abort.signal.aborted) return

      const finalEvents = sortEvents(dedup(collected))
      setState({
        status: 'complete',
        events: finalEvents,
        scannedTo: head,
        chainHead: head,
        blocksRemaining: 0n,
        poolLiability,
        errorMsg: null,
      })
    } catch (e) {
      if (abort.signal.aborted) return
      setState(s => ({
        ...s,
        status: 'error',
        errorMsg: e instanceof Error ? e.message : 'RPC error while fetching events.',
      }))
    }
  }, [cfg])

  useEffect(() => {
    void run()
    return () => { abortRef.current?.abort() }
  // run is memoized on cfg which is a module-level constant
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rescan = useCallback(() => { void run() }, [run])

  return { ...state, rescan }
}
