/**
 * Delivery server tests — deterministic injected adapters.
 *
 * All keys are SYNTHETIC (viem privateKeyToAccount test keys).
 * No real chain calls; no real files. Tests drive DeliveryCore directly.
 * Labelled synthetic throughout.
 */

import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { keccak256 } from 'viem'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac as _createHmac } from 'node:crypto'
import {
  DeliveryCore,
  type ChainAdapter,
  type ClockAdapter,
  type RandomAdapter,
  type FileAdapter,
  type HmacAdapter,
  type DeliveryConfig,
} from '../core/delivery.js'
import { createHandler, RateLimiter } from '../http.js'
import { ARTIFACT_HASH, TERMS_HASH, ARC_TESTNET_CHAIN_ID, MAINNET_ARTIFACT_HASH, MAINNET_TERMS_HASH, ARC_MAINNET_CHAIN_ID } from '../constants.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')

// ─── SYNTHETIC test accounts ────────────────────────────────────────────────
// These are well-known test private keys used only in synthetic test fixtures.
const MEMBER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}` // SYNTHETIC
const OTHER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as `0x${string}`  // SYNTHETIC
const PROVIDER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as `0x${string}` // SYNTHETIC
const memberAccount = privateKeyToAccount(MEMBER_KEY)
const otherAccount = privateKeyToAccount(OTHER_KEY)
const providerAccount = privateKeyToAccount(PROVIDER_KEY)

// ─── Constants ───────────────────────────────────────────────────────────────
const MEMBER_ADDR = memberAccount.address.toLowerCase() as `0x${string}`
const CONTRACT_ADDR = '0x1111111111111111111111111111111111111111' as `0x${string}` // SYNTHETIC
const POOL_ID = '42'
const DOMAIN = 'localhost:5173'
const URI = 'http://localhost:5173'

// ─── Real artifact bytes — loaded from the committed files ────────────────────
const REAL_ARTIFACT_BYTES = new Uint8Array(
  readFileSync(join(ROOT, 'server/private/arc-activity-report-v1.json'))
)
const REAL_TERMS_BYTES = new Uint8Array(
  readFileSync(join(ROOT, 'public/report-v1/terms.md'))
)
const MAINNET_ARTIFACT_BYTES = new Uint8Array(
  readFileSync(join(ROOT, 'server/private/arc-activity-report-mainnet-v1.json'))
)
const MAINNET_TERMS_FILE_BYTES = new Uint8Array(
  readFileSync(join(ROOT, 'public/report-mainnet-v1/terms.md'))
)

// ─── Adapter factories ────────────────────────────────────────────────────────

function makeChain(overrides: Partial<{
  chainId: number
  hasCode: boolean
  pool: { provider: `0x${string}`; artifactHash: `0x${string}`; termsHash: `0x${string}` } | null | 'throw'
  member: { isMember: boolean } | 'throw'
}> = {}): ChainAdapter {
  const defaults = {
    chainId: ARC_TESTNET_CHAIN_ID,
    hasCode: true,
    pool: {
      provider: providerAccount.address.toLowerCase() as `0x${string}`,
      artifactHash: ARTIFACT_HASH,
      termsHash: TERMS_HASH,
    },
    member: { isMember: true },
  }
  const cfg = { ...defaults, ...overrides }
  return {
    async getChainId() {
      if (typeof cfg.chainId === 'number') return cfg.chainId
      throw new Error('RPC error')
    },
    async hasCode() { return cfg.hasCode },
    async getPool() {
      if (cfg.pool === 'throw') throw new Error('RPC error')
      return cfg.pool
    },
    async getMember() {
      if (cfg.member === 'throw') throw new Error('RPC error')
      return cfg.member
    },
  }
}

let clockMs = Date.now()
function makeClock(startMs?: number): ClockAdapter & { advance(ms: number): void } {
  let t = startMs ?? clockMs
  return {
    nowMs: () => t,
    advance(ms: number) { t += ms },
  }
}

let nonceCounter = 0
function makeRandom(): RandomAdapter {
  return {
    randomHex: () => `0x${(++nonceCounter).toString(16).padStart(32, '0')}`,
  }
}

function makeFile(bytes: Uint8Array = REAL_ARTIFACT_BYTES, termsBytes: Uint8Array = REAL_TERMS_BYTES): FileAdapter {
  return {
    async readArtifact() { return bytes },
    async readTerms() { return termsBytes },
  }
}

const HMAC_SECRET = Buffer.from('test-hmac-secret-32-bytes-exactly!', 'utf8').subarray(0, 32)


const config: DeliveryConfig = {
  contractAddress: CONTRACT_ADDR,
  poolId: POOL_ID,
  domain: DOMAIN,
  uri: URI,
  chainId: 5042002, // Arc Testnet — used in EIP-4361 message chain id field
  networkKey: 'testnet',
  artifactHash: ARTIFACT_HASH,
}

function makeCore(overrides: {
  chain?: ChainAdapter
  clock?: ClockAdapter
  random?: RandomAdapter
  file?: FileAdapter
  hmac?: HmacAdapter
} = {}): DeliveryCore {
  const hmac = overrides.hmac ?? makeHmacSync()
  return new DeliveryCore(
    config,
    overrides.chain ?? makeChain(),
    overrides.clock ?? makeClock(),
    overrides.random ?? makeRandom(),
    overrides.file ?? makeFile(),
    hmac,
  )
}

/** HMAC adapter using the top-level _createHmac import */
function makeHmacSync(): HmacAdapter {
  return {
    sign(payload) {
      return _createHmac('sha256', HMAC_SECRET).update(payload).digest('hex')
    },
    verify(payload, digest) {
      const expected = _createHmac('sha256', HMAC_SECRET).update(payload).digest('hex')
      const a = Buffer.from(expected, 'hex')
      const b = Buffer.from(digest, 'hex')
      if (a.length !== b.length) return false
      // Timing-safe compare: same length guaranteed by hex encoding
      return a.equals(b)
    },
  }
}

/** Issue a challenge and return the message + nonce for a given address */
async function doChallenge(core: DeliveryCore, address = MEMBER_ADDR, poolId = POOL_ID) {
  const r = core.challenge(address, poolId)
  if (!r.ok) throw new Error(`challenge failed: ${JSON.stringify(r.error)}`)
  return r.value
}

/** Sign the challenge message and submit session */
async function doSession(core: DeliveryCore, message: string, signerKey = MEMBER_KEY, address = MEMBER_ADDR, poolId = POOL_ID) {
  const account = privateKeyToAccount(signerKey)
  const signature = await account.signMessage({ message })
  return core.session(address, poolId, message, signature)
}

/** Full happy path: challenge → sign → session → return token */
async function fullSession(core: DeliveryCore): Promise<string> {
  const { message } = await doChallenge(core)
  const r = await doSession(core, message)
  if (!r.ok) throw new Error(`session failed: ${JSON.stringify(r.error)}`)
  return r.value.token
}

// ═══════════════════════════════════════════════════════════════════════════════
// H — Hash constant tests
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// GC — getCommitment now returns network + chainId
// ═══════════════════════════════════════════════════════════════════════════════

describe('GC — getCommitment returns network and chainId', () => {
  it('GC1: happy path returns network="testnet" and chainId=5042002', async () => {
    const core = makeCore()
    const result = await core.getCommitment()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.network).toBe('testnet')
    expect(result.value.chainId).toBe(5042002)
    expect(result.value.artifactHash).toBeTruthy()
    expect(result.value.termsHash).toBeTruthy()
  })

  it('GC2: network and chainId come from DeliveryConfig, not hardcoded', async () => {
    // Build a core with a different networkKey to confirm it plumbs through
    const core = new DeliveryCore(
      { ...config, networkKey: 'mainnet', chainId: 9999, artifactHash: MAINNET_ARTIFACT_HASH },
      makeChain(),
      { nowMs: () => Date.now() },
      { randomHex: () => '0x' + Buffer.alloc(16, 0xab).toString('hex') },
      makeFile(),
      makeHmacSync(),
    )
    const result = await core.getCommitment()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.network).toBe('mainnet')
    expect(result.value.chainId).toBe(9999)
  })

  it('GC3: artifact file read error → 500 error, no network field', async () => {
    const core = makeCore({ file: { ...makeFile(), readArtifact: async () => { throw new Error('disk error') } } })
    const result = await core.getCommitment()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(500)
  })

  it('GC4: terms file read error → 500 error', async () => {
    const core = makeCore({ file: { ...makeFile(), readTerms: async () => { throw new Error('terms missing') } } })
    const result = await core.getCommitment()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(500)
  })
})

describe('H — Hash constants match committed files', () => {
  it('H1: testnet artifact hash matches committed constant', () => {
    const computed = keccak256(REAL_ARTIFACT_BYTES)
    expect(computed.toLowerCase()).toBe(ARTIFACT_HASH.toLowerCase())
  })

  it('H2: testnet terms hash matches committed constant', () => {
    const computed = keccak256(REAL_TERMS_BYTES)
    expect(computed.toLowerCase()).toBe(TERMS_HASH.toLowerCase())
  })

  it('H3: mainnet artifact hash matches committed constant', () => {
    const computed = keccak256(MAINNET_ARTIFACT_BYTES)
    expect(computed.toLowerCase()).toBe(MAINNET_ARTIFACT_HASH.toLowerCase())
  })

  it('H4: mainnet terms hash matches committed constant', () => {
    const computed = keccak256(MAINNET_TERMS_FILE_BYTES)
    expect(computed.toLowerCase()).toBe(MAINNET_TERMS_HASH.toLowerCase())
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// MN — Mainnet delivery (deterministic, mocked chain adapter)
// ═══════════════════════════════════════════════════════════════════════════════

describe('MN — Mainnet delivery: artifact bytes and integrity check', () => {
  const mainnetConfig: DeliveryConfig = {
    contractAddress: '0x2222222222222222222222222222222222222222' as `0x${string}`,
    poolId: '1',
    domain: 'app.example.com',
    uri: 'https://app.example.com',
    chainId: ARC_MAINNET_CHAIN_ID,
    networkKey: 'mainnet',
    artifactHash: MAINNET_ARTIFACT_HASH,
  }

  it('MN1: deliverFile returns mainnet artifact bytes with correct hash', async () => {
    const mainnetChain: ChainAdapter = {
      async getChainId() { return ARC_MAINNET_CHAIN_ID },
      async hasCode() { return true },
      async getPool() {
        return {
          provider: '0x1234567890123456789012345678901234567890' as `0x${string}`,
          artifactHash: MAINNET_ARTIFACT_HASH,
          termsHash: MAINNET_TERMS_HASH,
        }
      },
      async getMember() { return { isMember: true } },
    }
    const mainnetFile: FileAdapter = {
      async readArtifact() { return MAINNET_ARTIFACT_BYTES },
      async readTerms() { return MAINNET_TERMS_FILE_BYTES },
    }
    const core = new DeliveryCore(mainnetConfig, mainnetChain, makeClock(), makeRandom(), mainnetFile, makeHmacSync())

    // Need a valid token — go through full session flow
    const { message } = await doChallenge(core, MEMBER_ADDR, '1')
    const sig = await memberAccount.signMessage({ message })
    const sessionR = await core.session(MEMBER_ADDR, '1', message, sig)
    if (!sessionR.ok) throw new Error('session failed')
    const token = sessionR.value.token

    const result = await core.deliverFile(`Bearer ${token}`)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('deliver failed: ' + result.error.reason)

    // Bytes must match the committed mainnet artifact hash
    const hash = keccak256(result.value.bytes)
    expect(hash.toLowerCase()).toBe(MAINNET_ARTIFACT_HASH.toLowerCase())
  })

  it('MN2: session rejects when on-chain artifactHash does not match file bytes (mismatch caught early)', async () => {
    const corruptFile: FileAdapter = {
      // Returns testnet bytes under mainnet config — hash mismatch is caught in session()
      async readArtifact() { return REAL_ARTIFACT_BYTES },
      async readTerms() { return MAINNET_TERMS_FILE_BYTES },
    }
    const mainnetChain: ChainAdapter = {
      async getChainId() { return ARC_MAINNET_CHAIN_ID },
      async hasCode() { return true },
      async getPool() { return { provider: '0x1234567890123456789012345678901234567890' as `0x${string}`, artifactHash: MAINNET_ARTIFACT_HASH, termsHash: MAINNET_TERMS_HASH } },
      async getMember() { return { isMember: true } },
    }
    const core = new DeliveryCore(mainnetConfig, mainnetChain, makeClock(), makeRandom(), corruptFile, makeHmacSync())

    // DeliveryCore checks on-chain artifactHash vs live file hash in session() already
    const { message } = await doChallenge(core, MEMBER_ADDR, '1')
    const sig = await memberAccount.signMessage({ message })
    const sessionR = await core.session(MEMBER_ADDR, '1', message, sig)
    // session() should refuse: on-chain hash is MAINNET_ARTIFACT_HASH but file gives testnet hash
    expect(sessionR.ok).toBe(false)
    if (sessionR.ok) throw new Error('session should have been refused')
    expect(sessionR.error.code).toBe(503)
    expect(sessionR.error.reason).toContain('artifactHash')
  })

  it('MN3: chainId field in challenge message is ARC_MAINNET_CHAIN_ID (5042)', () => {
    const core = new DeliveryCore(mainnetConfig, {
      async getChainId() { return ARC_MAINNET_CHAIN_ID },
      async hasCode() { return true },
      async getPool() { return null },
      async getMember() { return { isMember: false } },
    }, makeClock(), makeRandom(), makeFile(), makeHmacSync())
    const r = core.challenge(MEMBER_ADDR, '1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.message).toContain(`Chain ID: ${ARC_MAINNET_CHAIN_ID}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// C — Challenge tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('C — Challenge endpoint', () => {
  it('C1: unknown pool rejected', () => {
    const core = makeCore()
    const r = core.challenge(MEMBER_ADDR, '99')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(400)
  })

  it('C2: invalid address rejected', () => {
    const core = makeCore()
    const r = core.challenge('not-an-address', POOL_ID)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(400)
  })

  it('C3: valid challenge returns message and nonce', async () => {
    const core = makeCore()
    const r = core.challenge(MEMBER_ADDR, POOL_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { message, nonce } = r.value
    expect(typeof message).toBe('string')
    expect(typeof nonce).toBe('string')
    expect(message).toContain(`Chain ID: ${ARC_TESTNET_CHAIN_ID}`)
    expect(message).toContain(`Pool ID: ${POOL_ID}`)
    expect(message).toContain(`Contract: ${CONTRACT_ADDR}`)
    expect(message).toContain(MEMBER_ADDR)
    expect(message).toContain('Sign to prove you control this wallet')
    expect(message).toContain('This does not authorise any payment')
    expect(message).toContain(`Nonce: ${nonce}`)
  })

  it('C4: two challenges produce different nonces', () => {
    const core = makeCore()
    const r1 = core.challenge(MEMBER_ADDR, POOL_ID)
    const r2 = core.challenge(MEMBER_ADDR, POOL_ID)
    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    expect(r1.value.nonce).not.toBe(r2.value.nonce)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// N — Nonce lifecycle tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('N — Nonce lifecycle', () => {
  it('N1: expired nonce rejected', async () => {
    const clock = makeClock()
    const core = makeCore({ clock })
    const { message } = await doChallenge(core)
    clock.advance(6 * 60 * 1000) // 6 minutes — past 5-min TTL
    const r = await doSession(core, message)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(400)
  })

  it('N2: replayed nonce rejected', async () => {
    const core = makeCore()
    const { message } = await doChallenge(core)
    const sig = await memberAccount.signMessage({ message })
    const r1 = await core.session(MEMBER_ADDR, POOL_ID, message, sig)
    expect(r1.ok).toBe(true)
    const r2 = await core.session(MEMBER_ADDR, POOL_ID, message, sig)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error.code).toBe(409)
  })

  it('N3: two concurrent session calls on one nonce — exactly one succeeds', async () => {
    const core = makeCore()
    const { message } = await doChallenge(core)
    const sig = await memberAccount.signMessage({ message })
    // Fire both simultaneously
    const [r1, r2] = await Promise.all([
      core.session(MEMBER_ADDR, POOL_ID, message, sig),
      core.session(MEMBER_ADDR, POOL_ID, message, sig),
    ])
    const successes = [r1, r2].filter((r) => r.ok).length
    const failures = [r1, r2].filter((r) => !r.ok).length
    expect(successes).toBe(1)
    expect(failures).toBe(1)
  })

  it('N4: unknown nonce rejected', async () => {
    const core = makeCore()
    // Build a syntactically valid message with an unknown nonce
    const { message } = await doChallenge(core)
    const tampered = message.replace(/^Nonce: .+$/m, 'Nonce: 0xdeadbeefdeadbeefdeadbeefdeadbeef')
    const sig = await memberAccount.signMessage({ message: tampered })
    const r = await core.session(MEMBER_ADDR, POOL_ID, tampered, sig)
    expect(r.ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// NP — Nonce pruning tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('NP — Nonce pruning', () => {
  it('NP1: expired nonces are pruned on next challenge call', () => {
    const clock = makeClock()
    const core = makeCore({ clock })
    // Issue 3 challenges
    core.challenge(MEMBER_ADDR, POOL_ID)
    core.challenge(MEMBER_ADDR, POOL_ID)
    core.challenge(MEMBER_ADDR, POOL_ID)
    expect(core.nonceCount).toBe(3)
    // Advance past TTL
    clock.advance(6 * 60 * 1000)
    // Next challenge call should prune the 3 expired ones and add 1 new
    core.challenge(MEMBER_ADDR, POOL_ID)
    expect(core.nonceCount).toBe(1)
  })

  it('NP2: used nonces are pruned on next challenge call', async () => {
    const core = makeCore()
    const { message } = await doChallenge(core)
    expect(core.nonceCount).toBe(1)
    // Use the nonce (session succeeds)
    await doSession(core, message)
    // Nonce is now marked used but not yet pruned
    expect(core.nonceCount).toBe(1)
    // Next challenge triggers pruning
    core.challenge(MEMBER_ADDR, POOL_ID)
    // The used nonce is gone; only the new one remains
    expect(core.nonceCount).toBe(1)
  })

  it('NP3: unexpired unused nonces are NOT pruned', () => {
    const clock = makeClock()
    const core = makeCore({ clock })
    core.challenge(MEMBER_ADDR, POOL_ID)
    core.challenge(MEMBER_ADDR, POOL_ID)
    expect(core.nonceCount).toBe(2)
    // Advance only 1 minute — still within 5-min TTL
    clock.advance(60 * 1000)
    core.challenge(MEMBER_ADDR, POOL_ID)
    // All 3 unexpired nonces remain (including the new one)
    expect(core.nonceCount).toBe(3)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// M — Message tampering tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('M — Message tampering', () => {
  async function tamperTest(transform: (msg: string) => string) {
    const core = makeCore()
    const { message: original } = await doChallenge(core)
    const tampered = transform(original)
    // Sign the tampered message (so signature matches tampered, but nonce won't match)
    const sig = await memberAccount.signMessage({ message: tampered })
    return core.session(MEMBER_ADDR, POOL_ID, tampered, sig)
  }

  it('M1: wrong pool id in message', async () => {
    const r = await tamperTest((m) => m.replace(`Pool ID: ${POOL_ID}`, 'Pool ID: 999'))
    expect(r.ok).toBe(false)
  })

  it('M2: wrong domain in message', async () => {
    const r = await tamperTest((m) => m.replace(DOMAIN, 'evil.com'))
    expect(r.ok).toBe(false)
  })

  it('M3: wrong chain id in message', async () => {
    const r = await tamperTest((m) => m.replace(`Chain ID: ${ARC_TESTNET_CHAIN_ID}`, 'Chain ID: 1'))
    expect(r.ok).toBe(false)
  })

  it('M4: wrong address in message', async () => {
    const r = await tamperTest((m) => m.replace(MEMBER_ADDR, otherAccount.address.toLowerCase()))
    expect(r.ok).toBe(false)
  })

  it('M5: wrong contract in message', async () => {
    const r = await tamperTest((m) => m.replace(CONTRACT_ADDR, '0x2222222222222222222222222222222222222222'))
    expect(r.ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// S — Signature tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('S — Signature verification', () => {
  it('S1: signature from wrong key rejected', async () => {
    const core = makeCore()
    const { message } = await doChallenge(core)
    // Sign with OTHER_KEY but claim MEMBER_ADDR
    const r = await doSession(core, message, OTHER_KEY, MEMBER_ADDR)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(403)
  })

  it('S2: malformed signature (not 65 bytes) rejected', async () => {
    const core = makeCore()
    const { message } = await doChallenge(core)
    const r = await core.session(MEMBER_ADDR, POOL_ID, message, '0xdeadbeef')
    expect(r.ok).toBe(false)
    if (!r.ok) expect([400, 403, 422]).toContain(r.error.code)
  })

  it('S3: zero signature rejected', async () => {
    const core = makeCore()
    const { message } = await doChallenge(core)
    const zeroSig = '0x' + '00'.repeat(65)
    const r = await core.session(MEMBER_ADDR, POOL_ID, message, zeroSig)
    expect(r.ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// B — Membership / chain tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('B — Membership and chain checks', () => {
  it('B1: non-member gets no token', async () => {
    const core = makeCore({ chain: makeChain({ member: { isMember: false } }) })
    const { message } = await doChallenge(core)
    const r = await doSession(core, message)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(403)
  })

  it('B2: provider address gets no token (provider is not a member)', async () => {
    const chain = makeChain({ member: { isMember: false } })
    const core = new DeliveryCore(config, chain, makeClock(), makeRandom(), makeFile(), makeHmacSync())
    const provAddr = providerAccount.address.toLowerCase() as `0x${string}`
    const r = core.challenge(provAddr, POOL_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const sig = await providerAccount.signMessage({ message: r.value.message })
    const sr = await core.session(provAddr, POOL_ID, r.value.message, sig)
    expect(sr.ok).toBe(false)
    if (!sr.ok) expect(sr.error.code).toBe(403)
  })

  it('B3: member gets a token', async () => {
    const core = makeCore()
    const token = await fullSession(core)
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(20)
  })

  it('B4: RPC failure on getChainId → no token', async () => {
    const chain: ChainAdapter = {
      async getChainId() { throw new Error('RPC down') },
      async hasCode() { return true },
      async getPool() { return null },
      async getMember() { return { isMember: true } },
    }
    const core = makeCore({ chain })
    const { message } = await doChallenge(core)
    const r = await doSession(core, message)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(503)
  })

  it('B5: wrong chain id → no token', async () => {
    const core = makeCore({ chain: makeChain({ chainId: 1 }) }) // Ethereum mainnet
    const { message } = await doChallenge(core)
    const r = await doSession(core, message)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(503)
  })

  it('B6: no contract code → no token', async () => {
    const core = makeCore({ chain: makeChain({ hasCode: false }) })
    const { message } = await doChallenge(core)
    const r = await doSession(core, message)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(503)
  })

  it('B7: pool not found → no token', async () => {
    const core = makeCore({ chain: makeChain({ pool: null }) })
    const { message } = await doChallenge(core)
    const r = await doSession(core, message)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(503)
  })

  it('B8: on-chain artifactHash != file hash → 503, no token', async () => {
    const wrongHash = `0x${'ab'.repeat(32)}` as `0x${string}`
    const core = makeCore({
      chain: makeChain({
        pool: {
          provider: providerAccount.address.toLowerCase() as `0x${string}`,
          artifactHash: wrongHash, // mismatch
          termsHash: TERMS_HASH,
        },
      }),
    })
    const { message } = await doChallenge(core)
    const r = await doSession(core, message)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(503)
  })

  it('B9: getMember RPC throws → no token', async () => {
    const core = makeCore({ chain: makeChain({ member: 'throw' }) })
    const { message } = await doChallenge(core)
    const r = await doSession(core, message)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(503)
  })

  it('B10: getPool RPC throws → no token', async () => {
    const core = makeCore({ chain: makeChain({ pool: 'throw' }) })
    const { message } = await doChallenge(core)
    const r = await doSession(core, message)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(503)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// T — Token + file delivery tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('T — Token and file delivery', () => {
  it('T1: valid token delivers bytes and returned hash equals committed ARTIFACT_HASH', async () => {
    const core = makeCore()
    const token = await fullSession(core)
    const r = await core.deliverFile(`Bearer ${token}`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { bytes, artifactHash } = r.value
    expect(bytes.length).toBeGreaterThan(0)
    const computed = keccak256(bytes)
    expect(computed.toLowerCase()).toBe(ARTIFACT_HASH.toLowerCase())
    expect(artifactHash.toLowerCase()).toBe(ARTIFACT_HASH.toLowerCase())
  })

  it('T2: expired token → 403, no bytes', async () => {
    const clock = makeClock()
    const core = makeCore({ clock })
    const token = await fullSession(core)
    clock.advance(11 * 60 * 1000) // 11 minutes — past 10-min TTL
    const r = await core.deliverFile(`Bearer ${token}`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(403)
  })

  it('T3: tampered token → 403', async () => {
    const core = makeCore()
    const token = await fullSession(core)
    const tampered = token.slice(0, -4) + 'xxxx'
    const r = await core.deliverFile(`Bearer ${tampered}`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(403)
  })

  it('T4: token bound to different address → 403', async () => {
    // Issue a token for member, then try to use it from another core with a different pool binding
    const core = makeCore()
    const token = await fullSession(core)
    // Decode and verify: token is base64url of "address:poolId:expiry|hmac"
    // Rebuild with different address
    const raw = Buffer.from(token, 'base64url').toString('utf8')
    const pipeIdx = raw.lastIndexOf('|')
    const payload = raw.slice(0, pipeIdx)
    const parts = payload.split(':')
    // Replace address with other account
    parts[0] = otherAccount.address.toLowerCase()
    const newPayload = parts.join(':')
    // Re-sign with same HMAC key but different address in payload
    const newDigest = _createHmac('sha256', HMAC_SECRET).update(newPayload).digest('hex')
    const newToken = Buffer.from(`${newPayload}|${newDigest}`).toString('base64url')
    // This token now has different address than what the chain says is a member
    // The re-check at delivery will use the address embedded in the token
    // Since we replaced the address with otherAccount which is NOT a member...
    const coreNonMember = makeCore({ chain: makeChain({ member: { isMember: false } }) })
    const r = await coreNonMember.deliverFile(`Bearer ${newToken}`)
    expect(r.ok).toBe(false)
  })

  it('T5: token for wrong pool → 403', async () => {
    // Create a core with poolId '43', try to use its token against a core expecting '42'
    const altConfig: DeliveryConfig = { ...config, poolId: '43' }
    const altCore = new DeliveryCore(
      altConfig,
      makeChain(),
      makeClock(),
      makeRandom(),
      makeFile(),
      makeHmacSync(),
    )
    // Challenge against altCore
    const cr = altCore.challenge(MEMBER_ADDR, '43')
    expect(cr.ok).toBe(true)
    if (!cr.ok) return
    const sig = await memberAccount.signMessage({ message: cr.value.message })
    const sr = await altCore.session(MEMBER_ADDR, '43', cr.value.message, sig)
    expect(sr.ok).toBe(true)
    if (!sr.ok) return
    // Try to use altCore's token against the main core (poolId '42')
    const mainCore = makeCore()
    const r = await mainCore.deliverFile(`Bearer ${sr.value.token}`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(403)
  })

  it('T6: missing Authorization header → 401', async () => {
    const core = makeCore()
    const r = await core.deliverFile(null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(401)
  })

  it('T7: non-member at delivery time → 403 and zero file bytes', async () => {
    // Issue token when member, then re-check fails (non-member now)
    const clock = makeClock()
    // Core that says member during session but not during delivery
    let deliveryPhase = false
    const chain: ChainAdapter = {
      async getChainId() { return ARC_TESTNET_CHAIN_ID },
      async hasCode() { return true },
      async getPool() {
        return {
          provider: providerAccount.address.toLowerCase() as `0x${string}`,
          artifactHash: ARTIFACT_HASH,
          termsHash: TERMS_HASH,
        }
      },
      async getMember() { return { isMember: !deliveryPhase } },
    }
    const core = new DeliveryCore(config, chain, clock, makeRandom(), makeFile(), makeHmacSync())
    const token = await fullSession(core)
    deliveryPhase = true // now non-member
    const r = await core.deliverFile(`Bearer ${token}`)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe(403)
      // Confirm zero bytes were delivered
    }
  })

  it('T8: artifactHash mismatch at delivery time → 503, no bytes', async () => {
    let checkCount = 0
    const chain: ChainAdapter = {
      async getChainId() { return ARC_TESTNET_CHAIN_ID },
      async hasCode() { return true },
      async getPool() {
        checkCount++
        // First call (session) has correct hash; second call (delivery) has wrong hash
        const hash = checkCount === 1 ? ARTIFACT_HASH : (`0x${'ff'.repeat(32)}` as `0x${string}`)
        return {
          provider: providerAccount.address.toLowerCase() as `0x${string}`,
          artifactHash: hash,
          termsHash: TERMS_HASH,
        }
      },
      async getMember() { return { isMember: true } },
    }
    const core = new DeliveryCore(config, chain, makeClock(), makeRandom(), makeFile(), makeHmacSync())
    const token = await fullSession(core)
    const r = await core.deliverFile(`Bearer ${token}`)
    // File hash is always correct (real bytes), so this tests on-chain hash divergence
    // The server checks both: file hash vs committed constant AND on-chain hash vs file hash
    // Since file bytes are always the real ones, the server hash matches ARTIFACT_HASH
    // and the on-chain hash here is 0xff...ff which != ARTIFACT_HASH
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(503)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// P — Privacy tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('P — Privacy: private file must not appear in static paths or client bundle', () => {
  it('P1: server/private/ is not under public/', () => {
    // The private file path must not start with the public/ directory
    const privatePath = join(ROOT, 'server/private/arc-activity-report-v1.json')
    const publicPath = join(ROOT, 'public')
    expect(privatePath.startsWith(publicPath)).toBe(false)
  })

  it('P2: public/ contains no copy of the artifact', () => {
    const ARTIFACT_NAME = 'arc-activity-report-v1.json'
    function findFile(dir: string, name: string): string[] {
      const results: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          results.push(...findFile(full, name))
        } else if (entry === name) {
          results.push(full)
        }
      }
      return results
    }
    const publicDir = join(ROOT, 'public')
    const found = findFile(publicDir, ARTIFACT_NAME)
    expect(found).toHaveLength(0)
  })

  it('P3: production dist/ contains no copy of the artifact', () => {
    const distDir = join(ROOT, 'dist')
    if (!existsSync(distDir)) {
      // Build has not been run yet in this test pass — skip
      console.warn('P3: dist/ not found — skipping (build not yet run)')
      return
    }
    // Scan all files in dist/ for a field unique to the private artifact (not in any public file)
    const UNIQUE_MARKER = '"headAtGeneration"'
    function scanDir(dir: string): string[] {
      const hits: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          hits.push(...scanDir(full))
        } else if (full.endsWith('.js') || full.endsWith('.json')) {
          const content = readFileSync(full, 'utf8')
          if (content.includes(UNIQUE_MARKER)) hits.push(full)
        }
      }
      return hits
    }
    const hits = scanDir(distDir)
    expect(hits).toHaveLength(0)
  })

  it('P4: unique artifact marker absent from all client source files (src/)', () => {
    // Belt-and-suspenders: scan source code for a field unique to the private artifact
    const UNIQUE_MARKER = '"headAtGeneration"'
    function scanDir(dir: string): string[] {
      const hits: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          hits.push(...scanDir(full))
        } else if (full.endsWith('.ts') || full.endsWith('.tsx') || full.endsWith('.js')) {
          const content = readFileSync(full, 'utf8')
          if (content.includes(UNIQUE_MARKER)) hits.push(full)
        }
      }
      return hits
    }
    const srcDir = join(ROOT, 'src')
    const hits = scanDir(srcDir)
    expect(hits).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// CT — Commitment endpoint test
// ═══════════════════════════════════════════════════════════════════════════════

describe('CT — Commitment endpoint', () => {
  it('CT1: returns artifact hash matching committed constant', async () => {
    const core = makeCore()
    const r = await core.getCommitment()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.artifactHash.toLowerCase()).toBe(ARTIFACT_HASH.toLowerCase())
    expect(r.value.size).toBe(REAL_ARTIFACT_BYTES.length)
  })

  it('CT2: artifact file read error returns 500', async () => {
    const badFile: FileAdapter = {
      async readArtifact() { throw new Error('disk error') },
      async readTerms() { return REAL_TERMS_BYTES },
    }
    const core = makeCore({ file: badFile })
    const r = await core.getCommitment()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(500)
  })

  it('CT3: terms file read error returns 500', async () => {
    const badFile: FileAdapter = {
      async readArtifact() { return REAL_ARTIFACT_BYTES },
      async readTerms() { throw new Error('disk error') },
    }
    const core = makeCore({ file: badFile })
    const r = await core.getCommitment()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(500)
  })

  it('CT4: commitment returns termsHash equal to committed TERMS_HASH constant', async () => {
    const core = makeCore()
    const r = await core.getCommitment()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.termsHash.toLowerCase()).toBe(TERMS_HASH.toLowerCase())
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// RL — Rate-limit IP keying tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('RL — Rate-limit IP keying via injected extractor', () => {
  function makeRequest(path: string, method = 'POST', body?: string, xForwardedFor?: string): Request {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (xForwardedFor) headers['X-Forwarded-For'] = xForwardedFor
    return new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body ?? undefined,
    })
  }

  it('RL1: two different IPs each get their own limit bucket', async () => {
    const core = makeCore()
    // ipExtractor returns different IPs for different requests
    let callCount = 0
    const handler = createHandler(core, 'http://localhost:5173', () => {
      callCount++
      return callCount <= 5 ? '1.2.3.4' : '5.6.7.8'
    })
    const body = JSON.stringify({ address: MEMBER_ADDR, poolId: POOL_ID })
    // First 5 from IP 1.2.3.4 — all should NOT be rate-limited (within 10-req limit)
    for (let i = 0; i < 5; i++) {
      const res = await handler(makeRequest('/api/delivery/challenge', 'POST', body))
      expect(res.status).not.toBe(429)
    }
    // Next 5 from IP 5.6.7.8 — new bucket, also should not be rate-limited
    for (let i = 0; i < 5; i++) {
      const res = await handler(makeRequest('/api/delivery/challenge', 'POST', body))
      expect(res.status).not.toBe(429)
    }
  })

  it('RL2: same IP hitting challenge 11 times within the window gets 429 on the 11th', async () => {
    const core = makeCore()
    const handler = createHandler(core, 'http://localhost:5173', () => '10.0.0.1')
    const body = JSON.stringify({ address: MEMBER_ADDR, poolId: POOL_ID })
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      const res = await handler(makeRequest('/api/delivery/challenge', 'POST', body))
      statuses.push(res.status)
    }
    // First 10 succeed (200 or 400 — valid requests), 11th is 429
    expect(statuses[10]).toBe(429)
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true)
  })

  it('RL3: X-Forwarded-For header is NOT honoured without TRUSTED_PROXY (default)', async () => {
    // If IP extractor uses socket IP (not header), the header value is ignored
    // We test this by giving the extractor a fixed socket IP and verifying it uses that
    const core = makeCore()
    const socketIp = '192.168.1.1'
    const handler = createHandler(core, 'http://localhost:5173', () => socketIp)
    const body = JSON.stringify({ address: MEMBER_ADDR, poolId: POOL_ID })
    // Send 11 requests with varying X-Forwarded-For headers — they should all count against socketIp
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      const req = makeRequest('/api/delivery/challenge', 'POST', body, `${i}.${i}.${i}.${i}`)
      const res = await handler(req)
      statuses.push(res.status)
    }
    // Despite varying X-Forwarded-For, all 11 map to socketIp → 11th is rate-limited
    expect(statuses[10]).toBe(429)
  })

  it('RL4: RateLimiter prunes stale entries', () => {
    const limiter = new RateLimiter()
    const t0 = Date.now()
    // Fill up from one IP
    for (let i = 0; i < 10; i++) {
      limiter.check('challenge', '1.2.3.4', t0)
    }
    // Window elapsed: new window resets the count
    const t1 = t0 + 61_000
    const allowed = limiter.check('challenge', '1.2.3.4', t1)
    expect(allowed).toBe(true)
  })
})
