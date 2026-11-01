/**
 * Viem-backed ChainAdapter for the delivery server.
 *
 * Extracted from server/index.ts so tests can drive the SAME decoding code
 * the live server uses, by injecting a minimal viem-like readContract interface.
 *
 * Key fix: uses REFLOW_POOLS_ABI (not a hand-written stub) so viem decodes
 * getMember and getPool return values by FIELD NAME, never by positional index.
 * The previous hand-written ABI had getMember outputs as (isMember, grossPaid, ...)
 * when the real contract returns a struct (joinOrder, grossPaid, ..., isMember).
 * That caused joinOrder=0 (first buyer) to be read as isMember=false (refused),
 * joinOrder=1 to be admitted by accident, and joinOrder>=2 to decode-error (503).
 */

import type { Abi } from 'viem'
import type { ChainAdapter } from './core/delivery.js'
import { REFLOW_POOLS_ABI } from './constants.js'

// ── Minimal client interface (subset of viem PublicClient) ──────────────────

export interface ViemLike {
  getChainId(): Promise<bigint | number>
  getBytecode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>
  readContract(args: {
    address: `0x${string}`
    abi: Abi
    functionName: string
    args: unknown[]
  }): Promise<unknown>
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function makeChainAdapter(client: ViemLike): ChainAdapter {
  return {
    async getChainId() {
      const id = await client.getChainId()
      return Number(id)
    },

    async hasCode(address) {
      const code = await client.getBytecode({ address })
      return !!code && code !== '0x'
    },

    async getPool(contract, poolId) {
      const result = await client.readContract({
        address: contract,
        abi: REFLOW_POOLS_ABI as Abi,
        functionName: 'getPool',
        args: [poolId],
      }) as {
        provider: `0x${string}`
        price: bigint
        artifactHash: `0x${string}`
        termsHash: `0x${string}`
        deadline: bigint
        cap: number
        count: number
        exists: boolean
      }
      // pool.exists === false means the pool was never created
      if (!result.exists) return null
      return {
        provider: result.provider,
        artifactHash: result.artifactHash,
        termsHash: result.termsHash,
      }
    },

    async getMember(contract, poolId, address) {
      const result = await client.readContract({
        address: contract,
        abi: REFLOW_POOLS_ABI as Abi,
        functionName: 'getMember',
        args: [poolId, address],
      }) as {
        joinOrder: bigint
        grossPaid: bigint
        rebatesAllocated: bigint
        rebatesClaimed: bigint
        isMember: boolean
      }
      // Decode by field NAME — not positional index.
      // Real struct order: joinOrder, grossPaid, rebatesAllocated, rebatesClaimed, isMember
      // The old hand-written ABI had isMember first, which caused joinOrder to be misread as isMember.
      return { isMember: result.isMember }
    },
  }
}
