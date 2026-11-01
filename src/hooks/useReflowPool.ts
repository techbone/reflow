/**
 * Read pool state, member state, and live quote from the ReflowPools contract.
 * Returns authoritative on-chain data only — never simulated values.
 *
 * Uses two separate useReadContracts calls to avoid TypeScript issues with
 * conditional arrays in a single call's contracts list.
 */
import { useReadContracts, useAccount } from 'wagmi'
import { erc20Abi } from 'viem'
import { REFLOW_POOLS_ABI } from '@/lib/reflowAbi'
import { REFLOW_CONFIG, NETWORK } from '@/lib/reflowConfig'
import type { PoolData, MemberData } from '@/lib/poolState'

const CHAIN = NETWORK.chainId

export interface ReflowPoolResult {
  pool:              PoolData | undefined
  member:            MemberData | undefined
  outstandingCredit: bigint | undefined
  totalLiability:    bigint | undefined
  usdcBalance:       bigint | undefined
  usdcAllowance:     bigint | undefined
  quote:             { contribution: bigint; expectedCount: bigint } | undefined
  quoteError:        string | undefined
  isLoading:         boolean
  isError:           boolean
  refetch:           () => void
}

export function useReflowPool(): ReflowPoolResult {
  const { address, chainId } = useAccount()

  const cfg          = REFLOW_CONFIG
  const isRightChain = chainId === CHAIN
  const enabled      = cfg.isConfigured && !!cfg.contractAddress && cfg.poolId !== null

  // ── Static reads (pool + total liability) ──────────────────────────────────
  const staticContracts = [
    {
      address:      cfg.contractAddress ?? '0x0000000000000000000000000000000000000000',
      abi:          REFLOW_POOLS_ABI,
      functionName: 'getPool' as const,
      args:         [cfg.poolId ?? 1n] as [bigint],
      chainId:      CHAIN,
    },
    {
      address:      cfg.contractAddress ?? '0x0000000000000000000000000000000000000000',
      abi:          REFLOW_POOLS_ABI,
      functionName: 'totalLiability' as const,
      args:         [] as const,
      chainId:      CHAIN,
    },
  ] as const

  const {
    data: staticData,
    isLoading: staticLoading,
    isError: staticError,
    refetch: refetchStatic,
  } = useReadContracts({
    contracts: staticContracts,
    query: { enabled, refetchInterval: 12_000 },
  })

  // ── Wallet reads (member, credit, USDC balance/allowance, quote) ──────────
  const walletContracts = [
    {
      address:      cfg.contractAddress ?? '0x0000000000000000000000000000000000000000',
      abi:          REFLOW_POOLS_ABI,
      functionName: 'getMember' as const,
      args:         [cfg.poolId ?? 1n, address ?? '0x0000000000000000000000000000000000000000'] as [bigint, `0x${string}`],
      chainId:      CHAIN,
    },
    {
      address:      cfg.contractAddress ?? '0x0000000000000000000000000000000000000000',
      abi:          REFLOW_POOLS_ABI,
      functionName: 'outstandingCredit' as const,
      args:         [cfg.poolId ?? 1n, address ?? '0x0000000000000000000000000000000000000000'] as [bigint, `0x${string}`],
      chainId:      CHAIN,
    },
    {
      address:      NETWORK.usdc,
      abi:          erc20Abi,
      functionName: 'balanceOf' as const,
      args:         [address ?? '0x0000000000000000000000000000000000000000'] as [`0x${string}`],
      chainId:      CHAIN,
    },
    {
      address:      NETWORK.usdc,
      abi:          erc20Abi,
      functionName: 'allowance' as const,
      args:         [
        address ?? '0x0000000000000000000000000000000000000000',
        cfg.contractAddress ?? '0x0000000000000000000000000000000000000000',
      ] as [`0x${string}`, `0x${string}`],
      chainId:      CHAIN,
    },
    {
      address:      cfg.contractAddress ?? '0x0000000000000000000000000000000000000000',
      abi:          REFLOW_POOLS_ABI,
      functionName: 'quoteJoin' as const,
      args:         [cfg.poolId ?? 1n, address ?? '0x0000000000000000000000000000000000000000'] as [bigint, `0x${string}`],
      chainId:      CHAIN,
    },
  ] as const

  const {
    data: walletData,
    refetch: refetchWallet,
  } = useReadContracts({
    contracts: walletContracts,
    query: {
      enabled: enabled && !!address && isRightChain,
      refetchInterval: 12_000,
    },
  })

  const refetch = () => {
    void refetchStatic()
    void refetchWallet()
  }

  if (!enabled || !staticData) {
    return {
      pool: undefined, member: undefined, outstandingCredit: undefined,
      totalLiability: undefined, usdcBalance: undefined, usdcAllowance: undefined,
      quote: undefined, quoteError: undefined,
      isLoading: enabled && staticLoading, isError: staticError, refetch,
    }
  }

  // Parse static data
  const rawPool = staticData[0]?.status === 'success' ? staticData[0].result as unknown : undefined
  const pool: PoolData | undefined = rawPool ? {
    provider:     (rawPool as { provider: `0x${string}` }).provider,
    price:        BigInt((rawPool as { price: bigint }).price),
    artifactHash: (rawPool as { artifactHash: `0x${string}` }).artifactHash,
    termsHash:    (rawPool as { termsHash: `0x${string}` }).termsHash,
    deadline:     BigInt((rawPool as { deadline: bigint }).deadline),
    cap:          Number((rawPool as { cap: number }).cap),
    count:        Number((rawPool as { count: number }).count),
    exists:       Boolean((rawPool as { exists: boolean }).exists),
  } : undefined

  const totalLiability = staticData[1]?.status === 'success'
    ? BigInt(staticData[1].result)
    : undefined

  // Parse wallet data
  const rawMember = walletData?.[0]?.status === 'success' ? walletData[0].result as unknown : undefined
  const member: MemberData | undefined = rawMember ? {
    joinOrder:        BigInt((rawMember as { joinOrder: bigint }).joinOrder),
    grossPaid:        BigInt((rawMember as { grossPaid: bigint }).grossPaid),
    rebatesAllocated: BigInt((rawMember as { rebatesAllocated: bigint }).rebatesAllocated),
    rebatesClaimed:   BigInt((rawMember as { rebatesClaimed: bigint }).rebatesClaimed),
    isMember:         Boolean((rawMember as { isMember: boolean }).isMember),
  } : undefined

  const outstandingCredit = walletData?.[1]?.status === 'success'
    ? BigInt(walletData[1].result)
    : undefined

  const usdcBalance = walletData?.[2]?.status === 'success'
    ? BigInt(walletData[2].result)
    : undefined

  const usdcAllowance = walletData?.[3]?.status === 'success'
    ? BigInt(walletData[3].result)
    : undefined

  const rawQuote = walletData?.[4]?.status === 'success'
    ? walletData[4].result
    : undefined
  const quoteError = walletData?.[4]?.status === 'failure'
    ? 'Cannot quote: pool may be empty, full, expired, or you are already a member.'
    : undefined

  return {
    pool,
    member,
    outstandingCredit,
    totalLiability,
    usdcBalance,
    usdcAllowance,
    quote: rawQuote ? { contribution: BigInt(rawQuote[0]), expectedCount: BigInt(rawQuote[1]) } : undefined,
    quoteError,
    isLoading: staticLoading,
    isError:   staticError,
    refetch,
  }
}
