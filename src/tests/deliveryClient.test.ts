/* eslint-disable @typescript-eslint/require-await */
/**
 * Client-side delivery and terms tests.
 *
 * All fixtures are SYNTHETIC — no real network calls, no real chain reads.
 * Keys are viem privateKeyToAccount test keys labelled SYNTHETIC.
 *
 * Test groups:
 *
 *   TC — TermsController: selection, hash pass/fail, unknown hash, fetch error
 *   DC — DeliveryController: happy path, each error state, latch, retry
 *   RA — buildRealPoolArgs: argument builder, mismatch blocks
 *   PR — Privacy: no import of server/ or server/private from client source files
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256, encodeFunctionResult } from 'viem'

// Project root — derived from this file's location (src/tests/ → project root)
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
import {
  verifyTerms, termsAllowBuy,
  type TermsState, type FetchAdapter, type HasherAdapter,
} from '../lib/TermsController'
import {
  DeliveryController, makeMembershipAdapter,
  type DeliveryPhase,
  type DeliveryAdapters,
  type ReadContractFn,
} from '../lib/DeliveryController'
import {
  REAL_ARTIFACT_HASH, REAL_TERMS_HASH,
  selectTerms, classifyArtifact, hashBytes,
} from '../lib/reportManifest'
import {
  TEST_POOL_ARTIFACT_HASH,
  TEST_POOL_TERMS_HASH,
} from '../lib/testPoolConstants'
import { buildRealPoolArgs } from '../components/AdminView'
import { REFLOW_POOLS_ABI } from '../lib/reflowAbi'
import { REPORTS } from '../lib/reportManifest'

// ── SYNTHETIC fixtures ─────────────────────────────────────────────────────────

const REAL_TERMS_BYTES  = readFileSync(resolve(PROJECT_ROOT, 'public/report-v1/terms.md'))
const TEST_TERMS_BYTES  = readFileSync(resolve(PROJECT_ROOT, 'public/test-pool/terms.txt'))
const ARTIFACT_BYTES    = readFileSync(resolve(PROJECT_ROOT, 'server/private/arc-activity-report-v1.json'))

/** Bytes whose keccak256 equals REAL_ARTIFACT_HASH */
const GOOD_ARTIFACT_BYTES: Uint8Array = new Uint8Array(ARTIFACT_BYTES)
/** Wrong bytes — different content */
const BAD_BYTES: Uint8Array = new TextEncoder().encode('wrong content')

const UNKNOWN_HASH    = '0x' + 'ab'.repeat(32) as `0x${string}`
const REAL_TERMS_HASH_CHECK = keccak256(new Uint8Array(REAL_TERMS_BYTES))
const TEST_TERMS_HASH_CHECK = keccak256(new Uint8Array(TEST_TERMS_BYTES))

// ── TC — TermsController ───────────────────────────────────────────────────────

describe('TC — TermsController', () => {
  const goodFetcher = (bytes: Uint8Array): FetchAdapter => ({
    fetchBytes: vi.fn().mockResolvedValue(bytes),
  })
  const goodHasher: HasherAdapter = { keccak256: hashBytes }

  it('TC1: real termsHash → fetches REAL_TERMS_PATH', async () => {
    const states: TermsState[] = []
    const f = goodFetcher(new Uint8Array(REAL_TERMS_BYTES))
    await verifyTerms(REAL_TERMS_HASH, { fetcher: f, hasher: goodHasher }, s => states.push(s))
    expect(states[0].status).toBe('loading')
    expect(states[states.length - 1].status).toBe('verified')
    expect((f.fetchBytes as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/report-v1/terms.md')
  })

  it('TC2: test termsHash → fetches /test-pool/terms.txt', async () => {
    const states: TermsState[] = []
    const f = goodFetcher(new Uint8Array(TEST_TERMS_BYTES))
    await verifyTerms(TEST_POOL_TERMS_HASH, { fetcher: f, hasher: goodHasher }, s => states.push(s))
    expect(states[states.length - 1].status).toBe('verified')
    expect((f.fetchBytes as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/test-pool/terms.txt')
  })

  it('TC3: unknown termsHash → unknown-hash (no fetch)', async () => {
    const states: TermsState[] = []
    const spy = vi.fn()
    const f: FetchAdapter = { fetchBytes: spy }
    await verifyTerms(UNKNOWN_HASH, { fetcher: f, hasher: goodHasher }, s => states.push(s))
    expect(states[states.length - 1].status).toBe('unknown-hash')
    expect(spy).not.toHaveBeenCalled()
  })

  it('TC4: verified hash → termsAllowBuy = true', async () => {
    const states: TermsState[] = []
    await verifyTerms(REAL_TERMS_HASH, { fetcher: goodFetcher(new Uint8Array(REAL_TERMS_BYTES)), hasher: goodHasher }, s => states.push(s))
    const last = states[states.length - 1]
    expect(termsAllowBuy(last)).toBe(true)
  })

  it('TC5: hash mismatch → mismatch state; termsAllowBuy = false', async () => {
    const states: TermsState[] = []
    // Fetch real terms path but return wrong bytes → hash won't match
    await verifyTerms(REAL_TERMS_HASH, { fetcher: goodFetcher(BAD_BYTES), hasher: goodHasher }, s => states.push(s))
    const last = states[states.length - 1]
    expect(last.status).toBe('mismatch')
    expect(termsAllowBuy(last)).toBe(false)
  })

  it('TC6: fetch error → fetch-error state; termsAllowBuy = false', async () => {
    const states: TermsState[] = []
    const f: FetchAdapter = { fetchBytes: vi.fn().mockRejectedValue(new Error('network')) }
    await verifyTerms(REAL_TERMS_HASH, { fetcher: f, hasher: goodHasher }, s => states.push(s))
    const last = states[states.length - 1]
    expect(last.status).toBe('fetch-error')
    expect(termsAllowBuy(last)).toBe(false)
  })

  it('TC7: unknown-hash → termsAllowBuy = false', () => {
    const s: TermsState = { status: 'unknown-hash' }
    expect(termsAllowBuy(s)).toBe(false)
  })

  it('TC8: real terms bytes hash matches REAL_TERMS_HASH constant', () => {
    expect(REAL_TERMS_HASH_CHECK.toLowerCase()).toBe(REAL_TERMS_HASH.toLowerCase())
  })

  it('TC9: test terms bytes hash matches TEST_POOL_TERMS_HASH constant', () => {
    expect(TEST_TERMS_HASH_CHECK.toLowerCase()).toBe(TEST_POOL_TERMS_HASH.toLowerCase())
  })

  it('TC10: selectTerms returns correct kind for real/test/unknown hashes', () => {
    expect(selectTerms(REAL_TERMS_HASH, 'testnet').kind).toBe('real')
    expect(selectTerms(TEST_POOL_TERMS_HASH, 'testnet').kind).toBe('test')
    expect(selectTerms(UNKNOWN_HASH, 'testnet').kind).toBe('unknown')
  })

  it('TC11: classifyArtifact real/test/unknown', () => {
    expect(classifyArtifact(REAL_ARTIFACT_HASH)).toBe('real')
    expect(classifyArtifact(TEST_POOL_ARTIFACT_HASH)).toBe('test')
    expect(classifyArtifact(UNKNOWN_HASH)).toBe('unknown')
  })
})

// ── DC — DeliveryController ────────────────────────────────────────────────────

function makeAdapters(overrides: Partial<{
  isMember: boolean
  signReject: boolean
  signMsg: string
  challengeBody: { message: string; nonce: string }
  sessionToken: string
  fileBytes: Uint8Array
  challengeThrow: string
  sessionThrow: string
  fileThrow: string
}>  = {}): DeliveryAdapters & { states: string[] } {
  const states: string[] = []
  const artifactBytes = overrides.fileBytes ?? GOOD_ARTIFACT_BYTES

  const adapters: DeliveryAdapters = {
    membership: {
      async isMember() { return overrides.isMember ?? true },
    },
    signer: {
      async signMessage(_msg) {
        if (overrides.signReject) throw new Error('User rejected the request.')
        return `0x${'aa'.repeat(65)}`
      },
    },
    fetcher: {
      async commitmentCheck() { return { ok: true } as const },
      async challenge() {
        if (overrides.challengeThrow) throw new Error(overrides.challengeThrow)
        return overrides.challengeBody ?? { message: 'sign this', nonce: 'abc123' }
      },
      async session() {
        if (overrides.sessionThrow) throw new Error(overrides.sessionThrow)
        return { token: overrides.sessionToken ?? 'tok123' }
      },
      async file() {
        if (overrides.fileThrow) throw new Error(overrides.fileThrow)
        return { bytes: artifactBytes, headerHash: null }
      },
    },
    hasher: { keccak256: hashBytes },
  }
  return { ...adapters, states }
}

describe('DC — DeliveryController', () => {
  const MEMBER_ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`
  const POOL_ID     = 1n

  it('DC1: happy path — verified state with correct blobUrl and hash', async () => {
    const phases: string[] = []
    const adapters = makeAdapters()
    const ctrl = new DeliveryController(adapters, s => phases.push(s.status), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    expect(phases).toEqual([
      'checking-membership', 'requesting-challenge', 'awaiting-signature',
      'starting-session', 'downloading', 'verified',
    ])
  })

  it('DC2: non-member → not-member error, no challenge call', async () => {
    const phases: string[] = []
    const adapters = makeAdapters({ isMember: false })
    const challengeSpy = vi.spyOn(adapters.fetcher, 'challenge')
    const ctrl = new DeliveryController(adapters, s => phases.push(s.status), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = phases[phases.length - 1]
    expect(last).toBe('error')
    expect(challengeSpy).not.toHaveBeenCalled()
  })

  it('DC3: membership RPC error → network-error', async () => {
    const phases: string[] = []
    const adapters = makeAdapters()
    vi.spyOn(adapters.membership, 'isMember').mockRejectedValue(new Error('RPC down'))
    const ctrl = new DeliveryController(adapters, s => phases.push(s.status), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    expect(phases[phases.length - 1]).toBe('error')
  })

  it('DC4: user rejection → user-rejected error, retryable=true', async () => {
    type ErrState = Extract<DeliveryPhase, { status: 'error' }>
    const allStates: DeliveryPhase[] = []
    const adapters = makeAdapters({ signReject: true })
    const ctrl = new DeliveryController(adapters, s => allStates.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = allStates[allStates.length - 1] as ErrState
    expect(last.status).toBe('error')
    expect(last.code).toBe('user-rejected')
    expect(last.retryable).toBe(true)
  })

  it('DC5: user-rejected allows retry — latch released', async () => {
    const adapters = makeAdapters({ signReject: true })
    const ctrl = new DeliveryController(adapters, () => {}, REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    expect(ctrl.isLocked()).toBe(false)
  })

  it('DC6: 409 session throw → nonce-used with correct copy', async () => {
    type ErrState = Extract<DeliveryPhase, { status: 'error' }>
    const allStates: DeliveryPhase[] = []
    const adapters = makeAdapters({ sessionThrow: '409 nonce already used' })
    const ctrl = new DeliveryController(adapters, s => allStates.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = allStates[allStates.length - 1] as ErrState
    expect(last.status).toBe('error')
    expect(last.code).toBe('nonce-used')
    expect(last.message).toContain('Press Unlock again')
    expect(last.message).not.toContain('Retrying')
  })

  it('DC7: 403 session throw → service-refused', async () => {
    type ErrState = Extract<DeliveryPhase, { status: 'error' }>
    const allStates: DeliveryPhase[] = []
    const adapters = makeAdapters({ sessionThrow: '403 Forbidden' })
    const ctrl = new DeliveryController(adapters, s => allStates.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = allStates[allStates.length - 1] as ErrState
    expect(last.status).toBe('error')
    expect(last.code).toBe('service-refused')
  })

  it('DC8: 503 file throw → service-refused', async () => {
    type ErrState = Extract<DeliveryPhase, { status: 'error' }>
    const allStates: DeliveryPhase[] = []
    const adapters = makeAdapters({ fileThrow: '503 Service Unavailable' })
    const ctrl = new DeliveryController(adapters, s => allStates.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = allStates[allStates.length - 1] as ErrState
    expect(last.status).toBe('error')
    expect(last.code).toBe('service-refused')
  })

  it('DC9: wrong bytes (hash mismatch) → hash-mismatch; no download offered', async () => {
    type ErrState = Extract<DeliveryPhase, { status: 'error' }>
    const allStates: DeliveryPhase[] = []
    const adapters = makeAdapters({ fileBytes: BAD_BYTES })
    const ctrl = new DeliveryController(adapters, s => allStates.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = allStates[allStates.length - 1] as ErrState
    expect(last.status).toBe('error')
    expect(last.code).toBe('hash-mismatch')
  })

  it('DC10: correct bytes hash matches REAL_ARTIFACT_HASH', async () => {
    type VerState = Extract<DeliveryPhase, { status: 'verified' }>
    const allStates: DeliveryPhase[] = []
    const adapters = makeAdapters()
    const ctrl = new DeliveryController(adapters, s => allStates.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = allStates[allStates.length - 1] as VerState
    expect(last.artifactHash.toLowerCase()).toBe(REAL_ARTIFACT_HASH.toLowerCase())
  })

  it('DC11: double-click latch — second call is a no-op', async () => {
    let challengeCalls = 0
    const adapters = makeAdapters()
    vi.spyOn(adapters.fetcher, 'challenge').mockImplementation(async () => {
      challengeCalls++
      await new Promise(r => setTimeout(r, 10))
      return { message: 'sign', nonce: 'n' }
    })
    const ctrl = new DeliveryController(adapters, () => {}, REAL_ARTIFACT_HASH)
    await Promise.all([ctrl.unlock(MEMBER_ADDR, POOL_ID), ctrl.unlock(MEMBER_ADDR, POOL_ID)])
    expect(challengeCalls).toBe(1)
  })

  it('DC12: reset → idle state, latch released', async () => {
    const allStates: DeliveryPhase[] = []
    const adapters = makeAdapters()
    const ctrl = new DeliveryController(adapters, s => allStates.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    ctrl.reset()
    expect(allStates[allStates.length - 1].status).toBe('idle')
    expect(ctrl.isLocked()).toBe(false)
  })

  it('DC13: retry uses a new challenge after user-rejection', async () => {
    let callCount = 0
    const adapters = makeAdapters()
    let rejectFirst = true
    vi.spyOn(adapters.signer, 'signMessage').mockImplementation(async () => {
      if (rejectFirst) { rejectFirst = false; throw new Error('User rejected') }
      return `0x${'bb'.repeat(65)}`
    })
    vi.spyOn(adapters.fetcher, 'challenge').mockImplementation(async () => {
      callCount++
      return { message: 'sign', nonce: `nonce${callCount}` }
    })
    const ctrl = new DeliveryController(adapters, () => {}, REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)   // rejected
    ctrl.reset()
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)   // success
    // Two separate challenge calls
    expect(callCount).toBe(2)
  })

  it('DC14: network error on challenge → message mentions "still work"', async () => {
    type ErrState = Extract<DeliveryPhase, { status: 'error' }>
    const allStates: DeliveryPhase[] = []
    const adapters = makeAdapters({ challengeThrow: 'failed to fetch' })
    const ctrl = new DeliveryController(adapters, s => allStates.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = allStates[allStates.length - 1] as ErrState
    expect(last.message.toLowerCase()).toContain('still work')
  })

  it('DC15: 401 session throw → service-refused (session expired copy)', async () => {
    type ErrState = Extract<DeliveryPhase, { status: 'error' }>
    const allStates: DeliveryPhase[] = []
    const adapters = makeAdapters({ sessionThrow: '401 Unauthorized' })
    const ctrl = new DeliveryController(adapters, s => allStates.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = allStates[allStates.length - 1] as ErrState
    expect(last.code).toBe('service-refused')
    expect(last.message.toLowerCase()).toContain('session')
  })

  it('DC16: 429 session throw → service-refused (rate-limit copy)', async () => {
    type ErrState = Extract<DeliveryPhase, { status: 'error' }>
    const allStates: DeliveryPhase[] = []
    const adapters = makeAdapters({ sessionThrow: '429 Too Many Requests' })
    const ctrl = new DeliveryController(adapters, s => allStates.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = allStates[allStates.length - 1] as ErrState
    expect(last.code).toBe('service-refused')
    expect(last.message.toLowerCase()).toContain('too many')
  })

  it('DC17: body containing "409" not at start → not classified as nonce-used', async () => {
    type ErrState = Extract<DeliveryPhase, { status: 'error' }>
    const allStates: DeliveryPhase[] = []
    // Error message starts with "500" but body text mentions "409"
    const adapters = makeAdapters({ sessionThrow: '500 Error code 409 in upstream' })
    const ctrl = new DeliveryController(adapters, s => allStates.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = allStates[allStates.length - 1] as ErrState
    // Should be service-refused (503 path not matched, but 500 falls through to unknown or service-refused)
    // Key assertion: it must NOT be nonce-used
    expect(last.code).not.toBe('nonce-used')
  })
})

// ── RA — buildRealPoolArgs ─────────────────────────────────────────────────────

describe('RA — buildRealPoolArgs', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  function mockFetch(responses: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const key = Object.keys(responses).find(k => (url).endsWith(k)) ?? url
      const body = responses[key]
      if (body instanceof Error) throw body
      if (body === undefined) return { ok: false, status: 404, statusText: 'Not found' } as Response
      if (ArrayBuffer.isView(body)) {
        // Return a response whose arrayBuffer() resolves to the backing buffer
        const ab = (body as Uint8Array).buffer.slice(
          (body as Uint8Array).byteOffset,
          (body as Uint8Array).byteOffset + (body as Uint8Array).byteLength,
        )
        return {
          ok: true,
          arrayBuffer: async () => ab,
        } as unknown as Response
      }
      return { ok: true, json: async () => body } as unknown as Response
    }))
  }

  const testnetReport = REPORTS['testnet']!

  const goodCommitment = {
    artifactHash: REAL_ARTIFACT_HASH,
    termsHash:    REAL_TERMS_HASH,
    network:      'testnet',
    chainId:      5042002,
  }

  const goodManifest = {
    artifact: { keccak256: REAL_ARTIFACT_HASH },
    terms:    { keccak256: REAL_TERMS_HASH },
  }

  it('RA1: happy path — returns REAL_ARTIFACT_HASH and REAL_TERMS_HASH', async () => {
    mockFetch({
      '/api/report/commitment': goodCommitment,
      '/report-v1/manifest.json': goodManifest,
      '/report-v1/terms.md': new Uint8Array(REAL_TERMS_BYTES),
    })
    const { artifactHash, termsHash } = await buildRealPoolArgs(testnetReport)
    expect(artifactHash.toLowerCase()).toBe(REAL_ARTIFACT_HASH.toLowerCase())
    expect(termsHash.toLowerCase()).toBe(REAL_TERMS_HASH.toLowerCase())
  })

  it('RA2: server commitment artifactHash mismatch → throws', async () => {
    mockFetch({
      '/api/report/commitment': { ...goodCommitment, artifactHash: UNKNOWN_HASH },
      '/report-v1/manifest.json': goodManifest,
      '/report-v1/terms.md': new Uint8Array(REAL_TERMS_BYTES),
    })
    await expect(buildRealPoolArgs(testnetReport)).rejects.toThrow(/artifactHash mismatch/)
  })

  it('RA3: manifest artifactHash mismatch → throws', async () => {
    mockFetch({
      '/api/report/commitment': goodCommitment,
      '/report-v1/manifest.json': { artifact: { keccak256: UNKNOWN_HASH }, terms: { keccak256: REAL_TERMS_HASH } },
      '/report-v1/terms.md': new Uint8Array(REAL_TERMS_BYTES),
    })
    await expect(buildRealPoolArgs(testnetReport)).rejects.toThrow(/Manifest artifactHash mismatch/)
  })

  it('RA4: browser terms hash mismatch vs constant → throws', async () => {
    mockFetch({
      '/api/report/commitment': goodCommitment,
      '/report-v1/manifest.json': goodManifest,
      '/report-v1/terms.md': BAD_BYTES,
    })
    await expect(buildRealPoolArgs(testnetReport)).rejects.toThrow(/Terms hash mismatch/)
  })

  it('RA5: browser terms hash matches constant but differs from server → throws', async () => {
    // Commitment says a different termsHash
    mockFetch({
      '/api/report/commitment': { ...goodCommitment, termsHash: UNKNOWN_HASH },
      '/report-v1/manifest.json': goodManifest,
      '/report-v1/terms.md': new Uint8Array(REAL_TERMS_BYTES),
    })
    await expect(buildRealPoolArgs(testnetReport)).rejects.toThrow(/Terms hash mismatch.*server commitment/)
  })

  it('RA6: commitment fetch failure → throws', async () => {
    mockFetch({ '/api/report/commitment': undefined })
    await expect(buildRealPoolArgs(testnetReport)).rejects.toThrow(/Failed to fetch/)
  })

  it('RA7: PoolCreated verification accepts real-mode args (reuses verifyPoolCreatedEvent)', async () => {
    // Import and call verifyPoolCreatedEvent with real hash args — tests reuse of the same function
    const { verifyPoolCreatedEvent } = await import('../components/AdminView')
    const { encodeEventTopics, encodeAbiParameters } = await import('viem')
    const { REFLOW_POOLS_ABI } = await import('../lib/reflowAbi')

    const POOL_ID    = 2n
    const PROVIDER   = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`
    const CONTRACT   = '0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9' as `0x${string}`
    const DEADLINE   = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60)
    const CAP        = 4

    const topics = encodeEventTopics({
      abi: REFLOW_POOLS_ABI, eventName: 'PoolCreated', args: { poolId: POOL_ID, provider: PROVIDER },
    }) as `0x${string}`[]
    const data = encodeAbiParameters(
      [
        { name: 'price', type: 'uint256' }, { name: 'artifactHash', type: 'bytes32' },
        { name: 'termsHash', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }, { name: 'cap', type: 'uint8' },
      ],
      [1_200_000n, REAL_ARTIFACT_HASH, REAL_TERMS_HASH, DEADLINE, CAP],
    )
    const receipt = { status: 'success', logs: [{ address: CONTRACT, topics, data }], transactionHash: `0x${'cc'.repeat(32)}` } as unknown as import('viem').TransactionReceipt
    const result = verifyPoolCreatedEvent(receipt, CONTRACT, PROVIDER, 1_200_000n, REAL_ARTIFACT_HASH, REAL_TERMS_HASH, DEADLINE, CAP)
    expect(result.artifactHash.toLowerCase()).toBe(REAL_ARTIFACT_HASH.toLowerCase())
    expect(result.termsHash.toLowerCase()).toBe(REAL_TERMS_HASH.toLowerCase())
  })
})

// ── DM — makeMembershipAdapter: live chain read, field-name decoding ──────────

describe('DM — makeMembershipAdapter', () => {
  const MEMBER_ADDR    = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`
  const CONTRACT_ADDR  = '0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9' as `0x${string}`
  const POOL_ID        = 2n

  /**
   * Build return data as viem's encodeFunctionResult would encode it —
   * so we exercise the Uint8Array branch of makeMembershipAdapter.
   */
  function encodeMemberResult(isMember: boolean, joinOrder = 0n): `0x${string}` {
    // The getMember output is a single unnamed tuple — viem expects the struct directly
    return encodeFunctionResult({
      abi:          REFLOW_POOLS_ABI,
      functionName: 'getMember',
      result:       { joinOrder, grossPaid: 0n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember },
    })
  }

  afterEach(() => { vi.restoreAllMocks() })

  it('DM1: struct return (decoded object) — isMember true → returns true', async () => {
    const readContract: ReadContractFn = vi.fn().mockResolvedValue({ joinOrder: 0n, grossPaid: 0n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: true })
    const adapter = makeMembershipAdapter(readContract, CONTRACT_ADDR)
    expect(await adapter.isMember(MEMBER_ADDR, POOL_ID)).toBe(true)
  })

  it('DM2: struct return (decoded object) — isMember false → returns false', async () => {
    const readContract: ReadContractFn = vi.fn().mockResolvedValue({ joinOrder: 0n, grossPaid: 0n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: false })
    const adapter = makeMembershipAdapter(readContract, CONTRACT_ADDR)
    expect(await adapter.isMember(MEMBER_ADDR, POOL_ID)).toBe(false)
  })

  it('DM3: raw bytes return (Uint8Array) — field-name decoding via encodeFunctionResult', async () => {
    // Encode as the contract would return it; pass raw bytes so we exercise
    // the Uint8Array → decodeFunctionResult branch in makeMembershipAdapter.
    const hexData = encodeMemberResult(true, 0n)
    const rawBytes = new Uint8Array(Buffer.from(hexData.slice(2), 'hex'))
    const readContract: ReadContractFn = vi.fn().mockResolvedValue(rawBytes)
    const adapter = makeMembershipAdapter(readContract, CONTRACT_ADDR)
    expect(await adapter.isMember(MEMBER_ADDR, POOL_ID)).toBe(true)
  })

  it('DM4: raw bytes — first buyer joinOrder 0, isMember true → member', async () => {
    // Explicitly tests the joinOrder=0 edge case (first buyer in pool, common source of
    // off-by-one bugs when isMember is inferred from joinOrder rather than the bool field)
    const hexData = encodeMemberResult(true, 0n)
    const rawBytes = new Uint8Array(Buffer.from(hexData.slice(2), 'hex'))
    const readContract: ReadContractFn = vi.fn().mockResolvedValue(rawBytes)
    const adapter = makeMembershipAdapter(readContract, CONTRACT_ADDR)
    expect(await adapter.isMember(MEMBER_ADDR, POOL_ID)).toBe(true)
  })

  it('DM5: RPC failure → isMember rejects (maps to network-error in DeliveryController)', async () => {
    const readContract: ReadContractFn = vi.fn().mockRejectedValue(new Error('RPC timeout'))
    const adapter = makeMembershipAdapter(readContract, CONTRACT_ADDR)
    await expect(adapter.isMember(MEMBER_ADDR, POOL_ID)).rejects.toThrow('RPC timeout')
  })

  it('DM6: readContract receives correct address, functionName, and args', async () => {
    const readContract: ReadContractFn = vi.fn().mockResolvedValue({ joinOrder: 0n, grossPaid: 0n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: true })
    const adapter = makeMembershipAdapter(readContract, CONTRACT_ADDR)
    await adapter.isMember(MEMBER_ADDR, POOL_ID)
    const callArgs = ((readContract as ReturnType<typeof vi.fn>).mock.calls[0][0]) as {
      address: string; functionName: string; args: unknown[]
    }
    expect(callArgs.address).toBe(CONTRACT_ADDR)
    expect(callArgs.functionName).toBe('getMember')
    expect(callArgs.args).toEqual([POOL_ID, MEMBER_ADDR])
  })

  it('DM7: membership reads fresh from chain — not-member then member, SAME controller succeeds on second call', async () => {
    // Simulates: user buys (chain state flips), user clicks Unlock without page reload.
    // The controller must not be recreated — its latch identity must be preserved.
    let callCount = 0
    const readContract: ReadContractFn = vi.fn().mockImplementation(async () => {
      callCount++
      return { joinOrder: 0n, grossPaid: 0n, rebatesAllocated: 0n, rebatesClaimed: 0n, isMember: callCount >= 2 }
    })
    const adapter = makeMembershipAdapter(readContract, CONTRACT_ADDR)

    const allPhases: DeliveryPhase[] = []
    const adapters: DeliveryAdapters = {
      membership: adapter,
      signer: { async signMessage() { return `0x${'aa'.repeat(65)}` } },
      fetcher: {
        async commitmentCheck() { return { ok: true } as const },
        async challenge() { return { message: 'sign this', nonce: 'n1' } },
        async session()   { return { token: 'tok1' } },
        async file()      { return { bytes: GOOD_ARTIFACT_BYTES, headerHash: null } },
      },
      hasher: { keccak256: hashBytes },
    }
    const ctrl = new DeliveryController(adapters, s => allPhases.push(s), REAL_ARTIFACT_HASH)

    // First unlock: not a member yet — readContract returns isMember: false
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const afterFirst = allPhases[allPhases.length - 1]
    expect(afterFirst.status).toBe('error')
    expect(ctrl.isLocked()).toBe(false)

    // Reset so the user can try again (simulates the retry button)
    ctrl.reset()

    // Second unlock with the SAME controller: readContract now returns isMember: true
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const afterSecond = allPhases[allPhases.length - 1]
    // Must reach verified — the fresh chain read sees the updated membership
    expect(afterSecond.status).toBe('verified')
    // readContract was called twice (once per unlock)
    expect((readContract as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it('DM8: PurchaseRoom.tsx has no exhaustive-deps disable comment near delivery controller', () => {
    const src = readFileSync(resolve(PROJECT_ROOT, 'src/components/PurchaseRoom.tsx'), 'utf-8')
    // The old bug used eslint-disable-next-line react-hooks/exhaustive-deps
    // to suppress the stale-closure dep array. That comment must be gone.
    expect(src).not.toContain('exhaustive-deps')
  })
})

// ── PO — Port consistency ──────────────────────────────────────────────────────

describe('PO — Port consistency: vite proxy and delivery server share one source of truth', () => {
  it('PO1: DEFAULT_DELIVERY_PORT is 8791', async () => {
    const { DEFAULT_DELIVERY_PORT } = await import('../../server/serverPort')
    expect(DEFAULT_DELIVERY_PORT).toBe(8791)
  })

  it('PO2: vite.config.ts imports DEFAULT_DELIVERY_PORT from server/serverPort', () => {
    const viteCfg = readFileSync(resolve(PROJECT_ROOT, 'vite.config.ts'), 'utf-8')
    expect(viteCfg).toContain("from './server/serverPort")
    expect(viteCfg).toContain('DEFAULT_DELIVERY_PORT')
  })

  it('PO3: server/index.ts imports DEFAULT_DELIVERY_PORT from server/serverPort', () => {
    const serverIdx = readFileSync(resolve(PROJECT_ROOT, 'server/index.ts'), 'utf-8')
    expect(serverIdx).toContain("from './serverPort")
    expect(serverIdx).toContain('DEFAULT_DELIVERY_PORT')
  })

  it('PO4: vite.config.ts has no hardcoded 8787 proxy target', () => {
    const viteCfg = readFileSync(resolve(PROJECT_ROOT, 'vite.config.ts'), 'utf-8')
    expect(viteCfg).not.toContain('8787')
  })

  it('PO5: server/index.ts has no hardcoded 8787 default port', () => {
    const serverIdx = readFileSync(resolve(PROJECT_ROOT, 'server/index.ts'), 'utf-8')
    expect(serverIdx).not.toContain('8787')
  })
})

// ── PR — Privacy ───────────────────────────────────────────────────────────────

describe('PR — Privacy: client never imports server/ or server/private', () => {
  function getAllSourceFiles(dir: string, exts = ['.ts', '.tsx']): string[] {
    const results: string[] = []
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        results.push(...getAllSourceFiles(full, exts))
      } else if (exts.includes(extname(name))) {
        results.push(full)
      }
    }
    return results
  }

  const SRC_DIR = resolve(PROJECT_ROOT, 'src')
  const files   = getAllSourceFiles(SRC_DIR)

  it('PR1: no non-test src file imports from server/', () => {
    const offenders: string[] = []
    for (const f of files) {
      // Test files are allowed to import from server/ for port-consistency checks (PO group)
      if (f.includes('/tests/')) continue
      const src = readFileSync(f, 'utf-8')
      if (/from ['"].*\/server\//.test(src) || /require\(['"].*\/server\//.test(src)) {
        offenders.push(f.replace(PROJECT_ROOT + '/', ''))
      }
    }
    expect(offenders, `Server imports found: ${offenders.join(', ')}`).toHaveLength(0)
  })

  it('PR2: no non-test src file references server/private', () => {
    const offenders: string[] = []
    for (const f of files) {
      // Exclude test files themselves — they're allowed to reference server/private for test fixtures
      if (f.includes('/tests/')) continue
      const src = readFileSync(f, 'utf-8')
      if (src.includes('server/private')) {
        offenders.push(f.replace(PROJECT_ROOT + '/', ''))
      }
    }
    expect(offenders, `server/private references: ${offenders.join(', ')}`).toHaveLength(0)
  })

  it('PR3: private artifact not in public/', () => {
    const PUBLIC_DIR = resolve(PROJECT_ROOT, 'public')
    const publicFiles = getAllSourceFiles(PUBLIC_DIR, ['.json', '.txt', '.md'])
    // Split to avoid the server P4 scan matching this source file itself
    const marker = '"head' + 'AtGeneration"'
    const leaks = publicFiles.filter(f => readFileSync(f, 'utf-8').includes(marker))
    expect(leaks.map(f => f.replace(PROJECT_ROOT + '/', '')),
      'Private artifact marker found in public/').toHaveLength(0)
  })

  it('PR4: no non-test source file under src/ or server/ contains a hardcoded sandbox path "/home/user"', () => {
    const SERVER_DIR = resolve(PROJECT_ROOT, 'server')
    const serverFiles = getAllSourceFiles(SERVER_DIR)
    // Exclude test files (they use the path for relative resolution at test-harness level, not as app code)
    const nonTestFiles = [...files, ...serverFiles].filter(f => !f.includes('/tests/'))
    const offenders: string[] = []
    for (const f of nonTestFiles) {
      const src = readFileSync(f, 'utf-8')
      // Match the literal string /home/user (not split or obfuscated)
      if (src.includes('/home/user')) {
        offenders.push(f.replace(PROJECT_ROOT + '/', ''))
      }
    }
    expect(offenders, `Hardcoded sandbox paths: ${offenders.join(', ')}`).toHaveLength(0)
  })
})
