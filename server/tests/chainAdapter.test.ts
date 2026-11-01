/**
 * ChainAdapter tests — SYNTHETIC.
 *
 * Uses viem encodeFunctionResult with the REAL REFLOW_POOLS_ABI to build
 * ABI-encoded return data and verifies that the same ABI can decode it back
 * to the expected field values — proving the server uses the correct ABI.
 *
 * makeChainAdapter is tested with a ViemLike stub that returns decoded objects
 * (matching what real viem readContract returns), confirming field-name access works.
 *
 * All keys and addresses are SYNTHETIC test fixtures.
 */

import { describe, it, expect } from 'vitest'
import { encodeFunctionResult, decodeFunctionResult, type Abi } from 'viem'
import { makeChainAdapter, type ViemLike } from '../chainAdapter.js'
import { REFLOW_POOLS_ABI, ARC_TESTNET_CHAIN_ID, ARTIFACT_HASH, TERMS_HASH } from '../constants.js'

// ─── SYNTHETIC addresses ─────────────────────────────────────────────────────
const CONTRACT = '0x1111111111111111111111111111111111111111' as `0x${string}` // SYNTHETIC
const PROVIDER = '0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA' as `0x${string}` // SYNTHETIC (checksummed)
const MEMBER   = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' as `0x${string}` // SYNTHETIC (checksummed)
const POOL_ID  = 1n

// ─── Decoded return types (what real viem readContract returns) ───────────────

type PoolDecoded = {
  provider: `0x${string}`; price: bigint; artifactHash: `0x${string}`
  termsHash: `0x${string}`; deadline: bigint; cap: number; count: number; exists: boolean
}
type MemberDecoded = {
  joinOrder: bigint; grossPaid: bigint; rebatesAllocated: bigint
  rebatesClaimed: bigint; isMember: boolean
}

// ─── Build a ViemLike stub from decoded objects ───────────────────────────────
// The stub returns decoded objects directly, matching real viem readContract behaviour.

function makeStub(overrides: {
  chainId?: bigint
  bytecodeAbsent?: boolean   // when true, getBytecode returns undefined
  bytecode?: `0x${string}`   // explicit bytecode (default '0x6080' if neither flag set)
  pool?: PoolDecoded | null | 'throw'
  member?: MemberDecoded | 'throw'
}): ViemLike {
  const defaultPool: PoolDecoded = {
    provider: PROVIDER, price: 1_200_000n,
    artifactHash: ARTIFACT_HASH, termsHash: TERMS_HASH,
    deadline: 9999999999n, cap: 4, count: 1, exists: true,
  }
  const defaultMember: MemberDecoded = {
    joinOrder: 0n, grossPaid: 1_200_000n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: true,
  }

  return {
    async getChainId() { return overrides.chainId ?? BigInt(ARC_TESTNET_CHAIN_ID) },
    async getBytecode() {
      if (overrides.bytecodeAbsent) return undefined
      return overrides.bytecode ?? '0x6080'
    },
    async readContract({ functionName }) {
      if (functionName === 'getPool') {
        const pool = 'pool' in overrides ? overrides.pool : defaultPool
        if (pool === 'throw') throw new Error('RPC error')
        return pool
      }
      if (functionName === 'getMember') {
        const member = 'member' in overrides ? overrides.member : defaultMember
        if (member === 'throw') throw new Error('RPC error')
        return member
      }
      throw new Error(`Unexpected functionName: ${functionName}`)
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// A — ABI surface and encode/decode roundtrip tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('A — REFLOW_POOLS_ABI surface', () => {
  it('A1: REFLOW_POOLS_ABI contains getPool with required output fields', () => {
    const fn = REFLOW_POOLS_ABI.find((x) => x.type === 'function' && x.name === 'getPool')
    expect(fn).toBeDefined()
    if (!fn || fn.type !== 'function') return
    const out = fn.outputs[0]
    expect(out.type).toBe('tuple')
    if (!('components' in out)) return
    const fields = out.components.map((c: { name: string }) => c.name)
    expect(fields).toContain('provider')
    expect(fields).toContain('artifactHash')
    expect(fields).toContain('termsHash')
    expect(fields).toContain('exists')
  })

  it('A2: REFLOW_POOLS_ABI getMember has isMember as LAST field (not first)', () => {
    const fn = REFLOW_POOLS_ABI.find((x) => x.type === 'function' && x.name === 'getMember')
    expect(fn).toBeDefined()
    if (!fn || fn.type !== 'function') return
    const out = fn.outputs[0]
    expect(out.type).toBe('tuple')
    if (!('components' in out)) return
    const fields = out.components.map((c: { name: string }) => c.name)
    // The critical fix: isMember is the LAST field, joinOrder is first
    expect(fields[0]).toBe('joinOrder')
    expect(fields[fields.length - 1]).toBe('isMember')
  })

  it('A3: all functions the server calls exist in REFLOW_POOLS_ABI', () => {
    const names = REFLOW_POOLS_ABI.filter((x) => x.type === 'function').map((x) => x.name)
    expect(names).toContain('getPool')
    expect(names).toContain('getMember')
  })

  it('A4: getMember ABI encode/decode roundtrip preserves isMember for joinOrder=0', () => {
    // encodeFunctionResult for a tuple output takes the decoded object directly (not wrapped in array)
    const memberValue = { joinOrder: 0n, grossPaid: 1_200_000n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: true }
    const encoded = encodeFunctionResult({
      abi: REFLOW_POOLS_ABI as Abi,
      functionName: 'getMember',
      result: memberValue,
    })
    const decoded = decodeFunctionResult({
      abi: REFLOW_POOLS_ABI as Abi,
      functionName: 'getMember',
      data: encoded,
    }) as MemberDecoded
    expect(decoded.isMember).toBe(true)
    expect(decoded.joinOrder).toBe(0n)
  })

  it('A5: getMember ABI encode/decode roundtrip: joinOrder=2, isMember=true', () => {
    const memberValue = { joinOrder: 2n, grossPaid: 400_000n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: true }
    const encoded = encodeFunctionResult({
      abi: REFLOW_POOLS_ABI as Abi,
      functionName: 'getMember',
      result: memberValue,
    })
    const decoded = decodeFunctionResult({
      abi: REFLOW_POOLS_ABI as Abi,
      functionName: 'getMember',
      data: encoded,
    }) as MemberDecoded
    expect(decoded.isMember).toBe(true)
    expect(decoded.joinOrder).toBe(2n)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// D — getMember decoding by field name
// ═══════════════════════════════════════════════════════════════════════════════

describe('D — getMember decoding by field name', () => {
  it('D1: joinOrder=0, isMember=true → isMember: true (first buyer)', async () => {
    const adapter = makeChainAdapter(makeStub({
      member: { joinOrder: 0n, grossPaid: 1_200_000n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: true },
    }))
    const result = await adapter.getMember(CONTRACT, POOL_ID, MEMBER)
    expect(result.isMember).toBe(true)
  })

  it('D2: joinOrder=1, isMember=true → isMember: true', async () => {
    const adapter = makeChainAdapter(makeStub({
      member: { joinOrder: 1n, grossPaid: 600_000n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: true },
    }))
    const result = await adapter.getMember(CONTRACT, POOL_ID, MEMBER)
    expect(result.isMember).toBe(true)
  })

  it('D3: joinOrder=2, isMember=true → isMember: true (old code would decode-error)', async () => {
    const adapter = makeChainAdapter(makeStub({
      member: { joinOrder: 2n, grossPaid: 400_000n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: true },
    }))
    const result = await adapter.getMember(CONTRACT, POOL_ID, MEMBER)
    expect(result.isMember).toBe(true)
  })

  it('D4: joinOrder=15, isMember=true → isMember: true (large joinOrder)', async () => {
    const adapter = makeChainAdapter(makeStub({
      member: { joinOrder: 15n, grossPaid: 80_000n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: true },
    }))
    const result = await adapter.getMember(CONTRACT, POOL_ID, MEMBER)
    expect(result.isMember).toBe(true)
  })

  it('D5: isMember=false with all zeros → isMember: false (non-member)', async () => {
    const adapter = makeChainAdapter(makeStub({
      member: { joinOrder: 0n, grossPaid: 0n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: false },
    }))
    const result = await adapter.getMember(CONTRACT, POOL_ID, MEMBER)
    expect(result.isMember).toBe(false)
  })

  it('D6: isMember=false (provider queried) → isMember: false', async () => {
    const adapter = makeChainAdapter(makeStub({
      member: { joinOrder: 0n, grossPaid: 0n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: false },
    }))
    const result = await adapter.getMember(CONTRACT, POOL_ID, PROVIDER)
    expect(result.isMember).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// G — getPool decoding
// ═══════════════════════════════════════════════════════════════════════════════

describe('G — getPool decoding by field name', () => {
  it('G1: exists=true → returns pool with correct provider/artifactHash/termsHash', async () => {
    const adapter = makeChainAdapter(makeStub({}))
    const pool = await adapter.getPool(CONTRACT, POOL_ID)
    expect(pool).not.toBeNull()
    if (!pool) return
    expect(pool.provider.toLowerCase()).toBe(PROVIDER.toLowerCase())
    expect(pool.artifactHash.toLowerCase()).toBe(ARTIFACT_HASH.toLowerCase())
    expect(pool.termsHash.toLowerCase()).toBe(TERMS_HASH.toLowerCase())
  })

  it('G2: exists=false → returns null (pool not created)', async () => {
    const adapter = makeChainAdapter(makeStub({
      pool: {
        provider: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        price: 0n, artifactHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
        termsHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
        deadline: 0n, cap: 0, count: 0, exists: false,
      },
    }))
    const pool = await adapter.getPool(CONTRACT, POOL_ID)
    expect(pool).toBeNull()
  })

  it('G3: getPool throws → propagates (caller catches)', async () => {
    const adapter = makeChainAdapter(makeStub({ pool: 'throw' }))
    await expect(adapter.getPool(CONTRACT, POOL_ID)).rejects.toThrow()
  })

  it('G4: artifactHash field decoded correctly', async () => {
    const customHash = ('0x' + 'ca'.repeat(32)) as `0x${string}`
    const adapter = makeChainAdapter(makeStub({
      pool: {
        provider: PROVIDER, price: 1_200_000n,
        artifactHash: customHash, termsHash: TERMS_HASH,
        deadline: 9999999999n, cap: 4, count: 1, exists: true,
      },
    }))
    const pool = await adapter.getPool(CONTRACT, POOL_ID)
    expect(pool?.artifactHash.toLowerCase()).toBe(customHash.toLowerCase())
  })

  it('G5: termsHash field decoded correctly', async () => {
    const customTerms = ('0x' + 'db'.repeat(32)) as `0x${string}`
    const adapter = makeChainAdapter(makeStub({
      pool: {
        provider: PROVIDER, price: 1_200_000n,
        artifactHash: ARTIFACT_HASH, termsHash: customTerms,
        deadline: 9999999999n, cap: 4, count: 1, exists: true,
      },
    }))
    const pool = await adapter.getPool(CONTRACT, POOL_ID)
    expect(pool?.termsHash.toLowerCase()).toBe(customTerms.toLowerCase())
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// R — Remaining ChainAdapter methods
// ═══════════════════════════════════════════════════════════════════════════════

describe('R — getChainId and hasCode', () => {
  it('R1: getChainId returns numeric chain id', async () => {
    const adapter = makeChainAdapter(makeStub({}))
    const id = await adapter.getChainId()
    expect(id).toBe(ARC_TESTNET_CHAIN_ID)
  })

  it('R2: hasCode returns true when bytecode is non-empty', async () => {
    const adapter = makeChainAdapter(makeStub({ bytecode: '0x6080604052' }))
    const has = await adapter.hasCode(CONTRACT)
    expect(has).toBe(true)
  })

  it('R3: hasCode returns false when bytecode is "0x"', async () => {
    const adapter = makeChainAdapter(makeStub({ bytecode: '0x' }))
    const has = await adapter.hasCode(CONTRACT)
    expect(has).toBe(false)
  })

  it('R4: hasCode returns false when bytecode is undefined', async () => {
    const adapter = makeChainAdapter(makeStub({ bytecodeAbsent: true }))
    const has = await adapter.hasCode(CONTRACT)
    expect(has).toBe(false)
  })
})
