/**
 * Reflow deployment configuration.
 *
 * Reads from environment variables:
 *   VITE_REFLOW_CONTRACT     — deployed ReflowPools address
 *   VITE_REFLOW_POOL_ID      — pool ID of the featured pool
 *   VITE_REFLOW_FROM_BLOCK   — block the contract was deployed at (for event scan)
 *   VITE_REFLOW_NETWORK      — 'testnet' (default) | 'mainnet'
 *
 * When any of these is absent or zero, the app shows "Setup pending"
 * and disables live financial actions. The educational example stays usable.
 *
 * NEVER fall back to a fake address. Never log credential values.
 */

import { isAddress } from 'viem'
import { NETWORK, assertNotKnownTestnetContract } from './network'
import { REPORTS } from './reportManifest'
// getUsdc no longer needed here — NETWORK.usdc is resolved in network.ts

// Re-export the resolved network for use throughout the app.
export { NETWORK }

/**
 * ARC_TESTNET_CHAIN_ID is kept as a named export for legacy callers inside
 * src/ that used it as a type annotation or comparison.
 * New code should use NETWORK.chainId.
 */
export const ARC_TESTNET_CHAIN_ID = 5042002

/**
 * ARC_TESTNET_USDC kept for legacy callers.
 * New code should use NETWORK.usdc.
 */
export const ARC_TESTNET_USDC = '0x3600000000000000000000000000000000000000' as const

/** Demo resource metadata — description is derived from the active network name. */
export const DEMO_RESOURCE = {
  title: 'Arc activity brief',
  version: 'v0.1 — preview',
  /** Network-aware fallback description shown when the pool has no manifest. */
  description:
    `A concise onchain activity summary for ${NETWORK.name}, covering contract deployments, transaction volumes and protocol events. Prepared by a builder-controlled wallet.`,
  license: 'Single-cohort license: each pool member may use the report for personal or internal review. Redistribution outside the cohort is not permitted under V1 terms.',
  providerNote:
    `Provider: builder-controlled demonstration wallet. Pool not yet configured on ${NETWORK.name}.`,
}

function readEnvAddress(key: string): `0x${string}` | null {
  const raw = import.meta.env[key] as string | undefined
  if (!raw || raw.trim() === '' || raw === '0x0000000000000000000000000000000000000000') return null
  if (!isAddress(raw.trim())) return null
  const addr = raw.trim() as `0x${string}`
  // Fail closed: testnet contracts are refused on mainnet
  try {
    assertNotKnownTestnetContract(addr, NETWORK)
  } catch (e) {
    console.error('[reflowConfig]', (e as Error).message)
    return null
  }
  return addr
}

function readEnvBigInt(key: string): bigint | null {
  const raw = import.meta.env[key] as string | undefined
  if (!raw || raw.trim() === '') return null
  try {
    const n = BigInt(raw.trim())
    return n > 0n ? n : null
  } catch { return null }
}

export interface ReflowConfig {
  /** Deployed ReflowPools contract address, or null if not configured. */
  contractAddress: `0x${string}` | null
  /** Featured pool ID, or null if not configured. */
  poolId: bigint | null
  /** Block the contract was deployed at (for event scanning). */
  fromBlock: bigint | null
  /** True when all required fields are present and superficially valid. */
  isConfigured: boolean
  /** Human-readable reason why live actions are disabled, if applicable. */
  pendingReason: string | null
}

/** Resolved once at module load — safe to import anywhere. */
export const REFLOW_CONFIG: ReflowConfig = (() => {
  const contractAddress = readEnvAddress('VITE_REFLOW_CONTRACT')
  const poolId          = readEnvBigInt('VITE_REFLOW_POOL_ID')
  const fromBlock       = readEnvBigInt('VITE_REFLOW_FROM_BLOCK') ?? 0n

  // NETWORK.usdc is guaranteed non-null (resolveNetwork throws if usdc is missing)
  // No need to re-validate here.

  // Mainnet mode requires explicit contract and pool id — never silently proceed
  if (NETWORK.isMainnet && !contractAddress) {
    return {
      contractAddress: null, poolId: null, fromBlock: null,
      isConfigured: false,
      pendingReason:
        `Mainnet mode requires VITE_REFLOW_CONTRACT. ` +
        `Set it to a contract deployed on Arc Mainnet (chain ${NETWORK.chainId}).`,
    }
  }

  if (!contractAddress) {
    return {
      contractAddress: null, poolId: null, fromBlock: null,
      isConfigured: false,
      pendingReason:
        'Contract address not configured. Set VITE_REFLOW_CONTRACT in .env to enable live actions.',
    }
  }

  if (NETWORK.isMainnet && !poolId) {
    return {
      contractAddress, poolId: null, fromBlock,
      isConfigured: false,
      pendingReason:
        'Mainnet mode requires VITE_REFLOW_POOL_ID. Set it to the pool id on Arc Mainnet.',
    }
  }

  if (!poolId) {
    return {
      contractAddress, poolId: null, fromBlock,
      isConfigured: false,
      pendingReason:
        'Pool ID not configured. Set VITE_REFLOW_POOL_ID in .env to enable live actions.',
    }
  }

  // Report not configured for this network → UI disables buy/join/unlock/admin-create
  if (REPORTS[NETWORK.key] === null) {
    return {
      contractAddress, poolId, fromBlock,
      isConfigured: false,
      pendingReason:
        `Mainnet report not configured. ` +
        `Publish a mainnet report and update REPORTS['mainnet'] before enabling live actions on Arc Mainnet.`,
    }
  }

  return { contractAddress, poolId, fromBlock, isConfigured: true, pendingReason: null }
})()
