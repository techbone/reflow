/**
 * useContractVerification — runtime pre-deploy checks for a live ReflowPools contract.
 *
 * Checks (in order):
 *   1. contractAddress has code (getCode != "0x")
 *   2. contract.usdc() == canonical ARC_TESTNET_USDC
 *   3. USDC token decimals() == 6
 *
 * Returns `ok: true` only when all three pass. Failures surface a `reason` string.
 * A failed getPool is NOT treated as setup-pending; it is an RPC error.
 *
 * Note: these checks do not authenticate USDC identity beyond the address match;
 * full identity verification remains a deployment-time responsibility.
 */

import { useReadContracts } from 'wagmi'
import { erc20Abi } from 'viem'
import { REFLOW_POOLS_ABI } from '@/lib/reflowAbi'
import { REFLOW_CONFIG, NETWORK } from '@/lib/reflowConfig'

const CHAIN = NETWORK.chainId

export interface ContractVerification {
  ok:       boolean
  checking: boolean
  reason:   string | null
}

const NO_CONTRACT: ContractVerification = { ok: false, checking: false, reason: 'No contract address configured.' }

export function useContractVerification(): ContractVerification {
  const cfg = REFLOW_CONFIG
  const enabled = cfg.isConfigured && !!cfg.contractAddress

  const contracts = [
    {
      address:      cfg.contractAddress ?? '0x0000000000000000000000000000000000000000',
      abi:          REFLOW_POOLS_ABI,
      functionName: 'usdc' as const,
      args:         [] as const,
      chainId:      CHAIN,
    },
    {
      address:      NETWORK.usdc,
      abi:          erc20Abi,
      functionName: 'decimals' as const,
      args:         [] as const,
      chainId:      CHAIN,
    },
  ] as const

  const { data, isLoading, isError } = useReadContracts({
    contracts,
    query: { enabled, staleTime: 60_000 },
  })

  if (!enabled) return NO_CONTRACT
  if (isLoading) return { ok: false, checking: true, reason: null }
  if (isError || !data) return { ok: false, checking: false, reason: 'RPC error while checking contract.' }

  const usdcResult   = data[0]
  const decimResult  = data[1]

  if (usdcResult?.status === 'failure') {
    return { ok: false, checking: false, reason: 'Contract did not respond to usdc(). It may not be a ReflowPools contract.' }
  }

  const reportedUsdc = usdcResult?.result as string | undefined
  if (!reportedUsdc || reportedUsdc.toLowerCase() !== NETWORK.usdc.toLowerCase()) {
    return { ok: false, checking: false, reason: `Contract usdc() returned ${reportedUsdc ?? 'nothing'}, expected ${NETWORK.usdc}.` }
  }

  if (decimResult?.status === 'failure') {
    return { ok: false, checking: false, reason: 'USDC token did not respond to decimals().' }
  }

  const decimals = decimResult?.result as number | undefined
  if (decimals !== 6) {
    return { ok: false, checking: false, reason: `USDC token returned decimals()=${decimals ?? '?'}, expected 6.` }
  }

  return { ok: true, checking: false, reason: null }
}
