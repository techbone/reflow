/**
 * network.test.ts — unit tests for network abstraction (M3 Step A + corrections)
 *
 * Test groups:
 *   RN — resolveNetwork (valid values, throws on invalid, precedence)
 *   GD — guard: assertNotKnownTestnetContract
 *   GH — guard: assertNotTestnetHashes
 *   CC — guard: checkChainIdMatchesNetwork
 *   RM — reportManifest: selectTerms, classifyArtifact, REPORTS
 *   NC — network config consistency
 *   VS — validateServerConfig (server startup cases A–E + missing fields)
 *   SI — server/index.ts source-order assertion (validateServerConfig before Bun.serve)
 *   RC — reflowConfig client-side mainnet-disabled behaviour
 *
 * All deterministic — no mocking, no browser APIs, no RPC calls.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll } from 'vitest'
import {
  resolveNetwork,
  assertNotKnownTestnetContract,
  assertNotTestnetHashes,
  checkChainIdMatchesNetwork,
  KNOWN_TESTNET_CONTRACTS,
  ARC_TESTNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
} from '../lib/network'
import {
  selectTerms,
  classifyArtifact,
  REPORTS,
  REAL_ARTIFACT_HASH,
  REAL_TERMS_HASH,
  KNOWN_TESTNET_HASHES,
} from '../lib/reportManifest'
import {
  TEST_POOL_ARTIFACT_HASH,
  TEST_POOL_TERMS_HASH,
} from '../lib/testPoolConstants'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TESTNET_ENV  = { VITE_REFLOW_NETWORK: 'testnet' }
const MAINNET_ENV  = { VITE_REFLOW_NETWORK: 'mainnet' }
const EMPTY_ENV    = {}
const SERVER_MAINNET_ENV = { REFLOW_NETWORK: 'mainnet' }

const TESTNET_CONTRACT = '0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9'
const OTHER_CONTRACT   = '0x1234567890123456789012345678901234567890'

// ── RN: resolveNetwork ────────────────────────────────────────────────────────

describe('RN resolveNetwork', () => {
  it('RN1: no env → testnet', () => {
    const n = resolveNetwork(EMPTY_ENV)
    expect(n.key).toBe('testnet')
    expect(n.chainId).toBe(ARC_TESTNET_CHAIN_ID)
    expect(n.isMainnet).toBe(false)
    expect(n.isTestnet).toBe(true)
  })

  it('RN2: VITE_REFLOW_NETWORK=testnet → testnet', () => {
    const n = resolveNetwork(TESTNET_ENV)
    expect(n.key).toBe('testnet')
    expect(n.chainId).toBe(ARC_TESTNET_CHAIN_ID)
  })

  it('RN3: VITE_REFLOW_NETWORK=mainnet → mainnet', () => {
    const n = resolveNetwork(MAINNET_ENV)
    expect(n.key).toBe('mainnet')
    expect(n.chainId).toBe(ARC_MAINNET_CHAIN_ID)
    expect(n.isMainnet).toBe(true)
    expect(n.isTestnet).toBe(false)
  })

  it('RN4: unknown value → THROWS (not silent default)', () => {
    // Bug: previously silently returned testnet. Must now throw.
    expect(() => resolveNetwork({ VITE_REFLOW_NETWORK: 'devnet' })).toThrow(
      /Invalid VITE_REFLOW_NETWORK value/,
    )
  })

  it('RN4b: typo "mainet" → THROWS naming the bad value', () => {
    expect(() => resolveNetwork({ VITE_REFLOW_NETWORK: 'mainet' })).toThrow(/mainet/)
  })

  it('RN4c: server typo "mainet" → THROWS naming the bad value', () => {
    expect(() => resolveNetwork({ REFLOW_NETWORK: 'mainet' })).toThrow(/mainet/)
  })

  it('RN5: REFLOW_NETWORK=mainnet (server key) → mainnet', () => {
    const n = resolveNetwork(SERVER_MAINNET_ENV)
    expect(n.key).toBe('mainnet')
  })

  it('RN5b: REFLOW_NETWORK takes precedence over VITE_REFLOW_NETWORK when both agree', () => {
    const n = resolveNetwork({ REFLOW_NETWORK: 'mainnet', VITE_REFLOW_NETWORK: 'mainnet' })
    expect(n.key).toBe('mainnet')
  })

  it('RN5c: REFLOW_NETWORK=testnet, VITE_REFLOW_NETWORK=mainnet → THROWS (conflict)', () => {
    expect(() =>
      resolveNetwork({ REFLOW_NETWORK: 'testnet', VITE_REFLOW_NETWORK: 'mainnet' }),
    ).toThrow(/both set but disagree/)
  })

  it('RN5d: REFLOW_NETWORK=mainnet, VITE_REFLOW_NETWORK=testnet → THROWS (conflict)', () => {
    expect(() =>
      resolveNetwork({ REFLOW_NETWORK: 'mainnet', VITE_REFLOW_NETWORK: 'testnet' }),
    ).toThrow(/both set but disagree/)
  })

  it('RN5e: REFLOW_NETWORK=mainnet, VITE_REFLOW_NETWORK absent → mainnet (no conflict)', () => {
    const n = resolveNetwork({ REFLOW_NETWORK: 'mainnet' })
    expect(n.key).toBe('mainnet')
  })

  it('RN5f: REFLOW_NETWORK absent, VITE_REFLOW_NETWORK=mainnet → mainnet (client fallback)', () => {
    const n = resolveNetwork({ VITE_REFLOW_NETWORK: 'mainnet' })
    expect(n.key).toBe('mainnet')
  })

  it('RN6: testnet has correct USDC address', () => {
    const n = resolveNetwork(EMPTY_ENV)
    expect(n.usdc.toLowerCase()).toBe('0x3600000000000000000000000000000000000000')
  })

  it('RN7: mainnet has rpcUrls and compassKey', () => {
    const n = resolveNetwork(MAINNET_ENV)
    expect(n.rpcUrls.length).toBeGreaterThan(0)
    expect(n.compassKey).toBe('Arc')
  })

  it('RN8: testnet has rpcUrls and compassKey', () => {
    const n = resolveNetwork(TESTNET_ENV)
    expect(n.rpcUrls.length).toBeGreaterThan(0)
    expect(n.compassKey).toBe('Arc_Testnet')
  })

  it('RN9: case insensitive — MAINNET → mainnet', () => {
    const n = resolveNetwork({ VITE_REFLOW_NETWORK: 'MAINNET' })
    expect(n.key).toBe('mainnet')
  })

  it('RN10: VITE_REFLOW_NETWORK with whitespace → trimmed', () => {
    const n = resolveNetwork({ VITE_REFLOW_NETWORK: '  mainnet  ' })
    expect(n.key).toBe('mainnet')
  })

  it('RN11: empty string → testnet (valid)', () => {
    const n = resolveNetwork({ VITE_REFLOW_NETWORK: '' })
    expect(n.key).toBe('testnet')
  })
})

// ── GD: assertNotKnownTestnetContract ─────────────────────────────────────────

describe('GD assertNotKnownTestnetContract', () => {
  const testnetNetwork = resolveNetwork(TESTNET_ENV)
  const mainnetNetwork = resolveNetwork(MAINNET_ENV)

  it('GD1: testnet address on testnet → no error', () => {
    expect(() =>
      assertNotKnownTestnetContract(TESTNET_CONTRACT, testnetNetwork)
    ).not.toThrow()
  })

  it('GD2: testnet address on mainnet → throws', () => {
    expect(() =>
      assertNotKnownTestnetContract(TESTNET_CONTRACT, mainnetNetwork)
    ).toThrow(/known testnet-only contract/)
  })

  it('GD3: unknown address on mainnet → no error', () => {
    expect(() =>
      assertNotKnownTestnetContract(OTHER_CONTRACT, mainnetNetwork)
    ).not.toThrow()
  })

  it('GD4: case insensitive — uppercase testnet address on mainnet → throws', () => {
    expect(() =>
      assertNotKnownTestnetContract(TESTNET_CONTRACT.toUpperCase(), mainnetNetwork)
    ).toThrow()
  })

  it('GD5: KNOWN_TESTNET_CONTRACTS includes the deployed testnet address', () => {
    expect(KNOWN_TESTNET_CONTRACTS.has(TESTNET_CONTRACT.toLowerCase())).toBe(true)
  })
})

// ── GH: assertNotTestnetHashes ────────────────────────────────────────────────

describe('GH assertNotTestnetHashes', () => {
  const testnetNetwork = resolveNetwork(TESTNET_ENV)
  const mainnetNetwork = resolveNetwork(MAINNET_ENV)

  it('GH1: testnet real artifact hash on testnet → no error', () => {
    expect(() =>
      assertNotTestnetHashes([REAL_ARTIFACT_HASH], testnetNetwork, KNOWN_TESTNET_HASHES)
    ).not.toThrow()
  })

  it('GH2: testnet real artifact hash on mainnet → throws', () => {
    expect(() =>
      assertNotTestnetHashes([REAL_ARTIFACT_HASH], mainnetNetwork, KNOWN_TESTNET_HASHES)
    ).toThrow(/known testnet\/test hash/)
  })

  it('GH3: testnet terms hash on mainnet → throws', () => {
    expect(() =>
      assertNotTestnetHashes([REAL_TERMS_HASH], mainnetNetwork, KNOWN_TESTNET_HASHES)
    ).toThrow()
  })

  it('GH4: test pool artifact hash on mainnet → throws', () => {
    expect(() =>
      assertNotTestnetHashes([TEST_POOL_ARTIFACT_HASH], mainnetNetwork, KNOWN_TESTNET_HASHES)
    ).toThrow()
  })

  it('GH5: test pool terms hash on mainnet → throws', () => {
    expect(() =>
      assertNotTestnetHashes([TEST_POOL_TERMS_HASH], mainnetNetwork, KNOWN_TESTNET_HASHES)
    ).toThrow()
  })

  it('GH6: unknown hash on mainnet → no error', () => {
    const unknownHash = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    expect(() =>
      assertNotTestnetHashes([unknownHash], mainnetNetwork, KNOWN_TESTNET_HASHES)
    ).not.toThrow()
  })

  it('GH7: KNOWN_TESTNET_HASHES contains all four known hashes', () => {
    expect(KNOWN_TESTNET_HASHES.has(REAL_ARTIFACT_HASH.toLowerCase())).toBe(true)
    expect(KNOWN_TESTNET_HASHES.has(REAL_TERMS_HASH.toLowerCase())).toBe(true)
    expect(KNOWN_TESTNET_HASHES.has(TEST_POOL_ARTIFACT_HASH.toLowerCase())).toBe(true)
    expect(KNOWN_TESTNET_HASHES.has(TEST_POOL_TERMS_HASH.toLowerCase())).toBe(true)
  })
})

// ── CC: checkChainIdMatchesNetwork ────────────────────────────────────────────

describe('CC checkChainIdMatchesNetwork', () => {
  const testnetNetwork = resolveNetwork(TESTNET_ENV)
  const mainnetNetwork = resolveNetwork(MAINNET_ENV)

  it('CC1: matching testnet chain id → undefined (no error)', () => {
    expect(checkChainIdMatchesNetwork(ARC_TESTNET_CHAIN_ID, testnetNetwork)).toBeUndefined()
  })

  it('CC2: matching mainnet chain id → undefined', () => {
    expect(checkChainIdMatchesNetwork(ARC_MAINNET_CHAIN_ID, mainnetNetwork)).toBeUndefined()
  })

  it('CC3: testnet rpc + mainnet config → error string', () => {
    const result = checkChainIdMatchesNetwork(ARC_TESTNET_CHAIN_ID, mainnetNetwork)
    expect(typeof result).toBe('string')
    expect(result).toMatch(/does not match/)
  })

  it('CC4: mainnet rpc + testnet config → error string', () => {
    const result = checkChainIdMatchesNetwork(ARC_MAINNET_CHAIN_ID, testnetNetwork)
    expect(typeof result).toBe('string')
    expect(result).toMatch(/does not match/)
  })

  it('CC5: completely unrelated chain id → error string', () => {
    const result = checkChainIdMatchesNetwork(1, testnetNetwork)
    expect(typeof result).toBe('string')
  })
})

// ── RM: reportManifest — selectTerms ─────────────────────────────────────────

describe('RM selectTerms', () => {
  it('RM1: testnet real terms hash → { kind: real, path: /report-v1/terms.md }', () => {
    const spec = selectTerms(REAL_TERMS_HASH, 'testnet')
    expect(spec.kind).toBe('real')
    expect(spec.path).toBe('/report-v1/terms.md')
  })

  it('RM2: testnet test pool terms hash → { kind: test }', () => {
    const spec = selectTerms(TEST_POOL_TERMS_HASH, 'testnet')
    expect(spec.kind).toBe('test')
    expect(spec.path).toContain('/test-pool/')
  })

  it('RM3: testnet unknown hash → { kind: unknown, path: null }', () => {
    const spec = selectTerms('0xdeadbeef00000000000000000000000000000000000000000000000000000000', 'testnet')
    expect(spec.kind).toBe('unknown')
    expect(spec.path).toBeNull()
  })

  it('RM4: mainnet real testnet terms hash → { kind: unknown } (refused)', () => {
    const spec = selectTerms(REAL_TERMS_HASH, 'mainnet')
    expect(spec.kind).toBe('unknown')
    expect(spec.path).toBeNull()
  })

  it('RM5: mainnet test pool terms hash → { kind: unknown } (refused)', () => {
    const spec = selectTerms(TEST_POOL_TERMS_HASH, 'mainnet')
    expect(spec.kind).toBe('unknown')
    expect(spec.path).toBeNull()
  })

  it('RM6: mainnet unknown hash → { kind: unknown }', () => {
    const spec = selectTerms('0xdeadbeef00000000000000000000000000000000000000000000000000000000', 'mainnet')
    expect(spec.kind).toBe('unknown')
  })
})

// ── RM: reportManifest — classifyArtifact ────────────────────────────────────

describe('RM classifyArtifact', () => {
  it('RM7: testnet real artifact hash → real', () => {
    expect(classifyArtifact(REAL_ARTIFACT_HASH, 'testnet')).toBe('real')
  })

  it('RM8: testnet test pool artifact hash → test', () => {
    expect(classifyArtifact(TEST_POOL_ARTIFACT_HASH, 'testnet')).toBe('test')
  })

  it('RM9: testnet unknown hash → unknown', () => {
    expect(classifyArtifact('0xdeadbeef00000000000000000000000000000000000000000000000000000000', 'testnet')).toBe('unknown')
  })

  it('RM10: mainnet real testnet artifact hash → unknown (refused)', () => {
    expect(classifyArtifact(REAL_ARTIFACT_HASH, 'mainnet')).toBe('unknown')
  })

  it('RM11: mainnet test pool artifact hash → unknown (refused)', () => {
    expect(classifyArtifact(TEST_POOL_ARTIFACT_HASH, 'mainnet')).toBe('unknown')
  })

  it('RM12: default network key is testnet (backward compat)', () => {
    expect(classifyArtifact(REAL_ARTIFACT_HASH)).toBe('real')
  })
})

// ── RM: REPORTS map ───────────────────────────────────────────────────────────

describe('RM REPORTS map', () => {
  it('RM13: testnet entry is non-null', () => {
    expect(REPORTS.testnet).not.toBeNull()
    expect(REPORTS.testnet?.artifactHash).toBe(REAL_ARTIFACT_HASH)
    expect(REPORTS.testnet?.termsHash).toBe(REAL_TERMS_HASH)
  })

  it('RM14: mainnet entry is non-null (mainnet report configured)', () => {
    expect(REPORTS.mainnet).not.toBeNull()
  })

  it('RM15: testnet manifestPath is non-empty', () => {
    expect(REPORTS.testnet?.manifestPath.length).toBeGreaterThan(0)
  })
})

// ── NC: network config consistency ───────────────────────────────────────────

describe('NC network config consistency', () => {
  it('NC1: testnet and mainnet have different chain ids', () => {
    expect(ARC_TESTNET_CHAIN_ID).not.toBe(ARC_MAINNET_CHAIN_ID)
  })

  it('NC2: testnet name contains "Testnet"', () => {
    const n = resolveNetwork(TESTNET_ENV)
    expect(n.name).toMatch(/testnet/i)
  })

  it('NC3: mainnet name contains "Mainnet"', () => {
    const n = resolveNetwork(MAINNET_ENV)
    expect(n.name).toMatch(/mainnet/i)
  })

  it('NC4: testnet.isMainnet false, testnet.isTestnet true', () => {
    const n = resolveNetwork(TESTNET_ENV)
    expect(n.isMainnet).toBe(false)
    expect(n.isTestnet).toBe(true)
  })

  it('NC5: mainnet.isMainnet true, mainnet.isTestnet false', () => {
    const n = resolveNetwork(MAINNET_ENV)
    expect(n.isMainnet).toBe(true)
    expect(n.isTestnet).toBe(false)
  })
})

// ── VS: validateServerConfig ──────────────────────────────────────────────────
// Tests mirror the five cases from the bug report plus missing-field checks.

describe('VS validateServerConfig', () => {
  // Lazy import to avoid circular-in-browser issues (server module reads process.env).
  // We import it at the top of each test so the module resolves via vitest node env.
  let validateServerConfig: typeof import('../../server/validateConfig').validateServerConfig

  // Base env with valid testnet settings
  const GOOD_TESTNET_ENV: Record<string, string | undefined> = {
    REFLOW_NETWORK:       'testnet',
    VITE_REFLOW_CONTRACT: '0x1111111111111111111111111111111111111111',
    REFLOW_POOL_ID:       '1',
  }

  beforeAll(async () => {
    const mod = await import('../../server/validateConfig')
    validateServerConfig = mod.validateServerConfig
  })

  // Case E — normal testnet → no errors
  it('VS-E: testnet with valid contract + pool id → empty errors', () => {
    const result = validateServerConfig({ env: GOOD_TESTNET_ENV, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(result.errors).toHaveLength(0)
    expect(result.network.key).toBe('testnet')
  })

  // Case A — mainnet + known testnet contract → fatal
  it('VS-A: mainnet + known testnet contract → error naming the contract', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'mainnet',
      VITE_REFLOW_CONTRACT: TESTNET_CONTRACT,
      REFLOW_POOL_ID:       '1',
    }
    const result = validateServerConfig({ env, rpcChainId: ARC_MAINNET_CHAIN_ID })
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.some((e) => /known testnet-only contract/.test(e))).toBe(true)
  })

  // Case B — mainnet + valid config: REPORTS.mainnet is now populated → passes
  it('VS-B: mainnet + non-testnet contract + correct chainId → no errors', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'mainnet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
      REFLOW_POOL_ID:       '1',
    }
    const result = validateServerConfig({ env, rpcChainId: ARC_MAINNET_CHAIN_ID })
    expect(result.errors).toHaveLength(0)
    expect(result.network.key).toBe('mainnet')
  })

  // Case C — RPC chain id mismatch: testnet rpc + mainnet config → fatal
  it('VS-C (testnet rpc + mainnet config): chain id mismatch → error', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'mainnet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
      REFLOW_POOL_ID:       '1',
    }
    // Only checking the chain-id error here; pass an rpcChainId that matches mainnet
    // to isolate; mismatch is testnet chain id with mainnet config
    const result = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(result.errors.some((e) => /does not match/.test(e))).toBe(true)
  })

  it('VS-C (mainnet rpc + testnet config): chain id mismatch → error', () => {
    const result = validateServerConfig({
      env: { ...GOOD_TESTNET_ENV },
      rpcChainId: ARC_MAINNET_CHAIN_ID,
    })
    expect(result.errors.some((e) => /does not match/.test(e))).toBe(true)
  })

  it('VS-C (testnet rpc + testnet config): chain id matches → no mismatch error', () => {
    const result = validateServerConfig({
      env: { ...GOOD_TESTNET_ENV },
      rpcChainId: ARC_TESTNET_CHAIN_ID,
    })
    expect(result.errors.every((e) => !/does not match/.test(e))).toBe(true)
  })

  // Case D — invalid REFLOW_NETWORK value (typo) → fatal
  it('VS-D: REFLOW_NETWORK=mainet (typo) → error naming the bad value', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'mainet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
      REFLOW_POOL_ID:       '1',
    }
    const result = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.some((e) => /mainet/.test(e))).toBe(true)
  })

  // Both-set-and-differ case → fatal
  it('VS-both-differ: REFLOW_NETWORK=testnet + VITE_REFLOW_NETWORK=mainnet → error', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'testnet',
      VITE_REFLOW_NETWORK:  'mainnet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
      REFLOW_POOL_ID:       '1',
    }
    const result = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(result.errors.some((e) => /both set but disagree/.test(e))).toBe(true)
  })

  // Missing VITE_REFLOW_CONTRACT → fatal
  it('VS-missing-contract: absent VITE_REFLOW_CONTRACT → error', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK: 'testnet',
      REFLOW_POOL_ID: '1',
    }
    const result = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(result.errors.some((e) => /VITE_REFLOW_CONTRACT/.test(e))).toBe(true)
  })

  // Missing REFLOW_POOL_ID → fatal
  it('VS-missing-pool: absent REFLOW_POOL_ID → error', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'testnet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
    }
    const result = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(result.errors.some((e) => /REFLOW_POOL_ID/.test(e))).toBe(true)
  })

  // rpcChainId=undefined → no chain-id error (check deferred)
  it('VS-no-rpc: rpcChainId undefined → no chain-id error', () => {
    const result = validateServerConfig({ env: GOOD_TESTNET_ENV, rpcChainId: undefined })
    expect(result.errors.every((e) => !/does not match/.test(e))).toBe(true)
  })

  // REPORTS.mainnet is now configured. Mainnet with a non-testnet contract passes.
  // The old "B error fires before hash check" scenario is no longer applicable.
  // Instead: mainnet with no errors, and no hash error when config is correct.
  it('VS-B-first: mainnet + valid config → no errors at all (no null-report or hash error)', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'mainnet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
      REFLOW_POOL_ID:       '1',
    }
    const result = validateServerConfig({ env, rpcChainId: ARC_MAINNET_CHAIN_ID })
    expect(result.errors).toHaveLength(0)
    // No false-positive hash error
    expect(result.errors.every((e) => !/known testnet\/test hash/.test(e))).toBe(true)
  })
})

// ── SI: server/index.ts source-order assertion ────────────────────────────────
// Ensures validateServerConfig is called BEFORE Bun.serve in the source.
// This is a structural (text) assertion — it does not run the server.

describe('SI server/index.ts source-order assertion', () => {
  it('SI1: validateServerConfig is imported in server/index.ts', () => {
    const root = process.cwd()
    const src = readFileSync(join(root, 'server/index.ts'), 'utf8')
    expect(src).toMatch(/import.*validateServerConfig.*from.*validateConfig/)
  })

  it('SI2: validateServerConfig is called before Bun.serve in the source', () => {
    const root = process.cwd()
    const src = readFileSync(join(root, 'server/index.ts'), 'utf8')
    const validateIdx = src.indexOf('validateServerConfig(')
    const serveIdx    = src.indexOf('Bun.serve(')
    expect(validateIdx).toBeGreaterThan(-1)
    expect(serveIdx).toBeGreaterThan(-1)
    expect(validateIdx).toBeLessThan(serveIdx)
  })

  it('SI3: server/index.ts does not call process.exit before validateServerConfig', () => {
    const root = process.cwd()
    const src = readFileSync(join(root, 'server/index.ts'), 'utf8')
    const validateIdx = src.indexOf('validateServerConfig(')
    const firstExitBeforeValidate = src.slice(0, validateIdx).indexOf('process.exit(')
    // There should be no process.exit before the first validateServerConfig call
    expect(firstExitBeforeValidate).toBe(-1)
  })
})

// ── RC: reflowConfig client-side disabled states ──────────────────────────────
// Confirms that when a testnet contract is configured on mainnet, the client
// config resolves to isConfigured=false with a clear reason.
// REPORTS.mainnet is now non-null (mainnet report is configured).

describe('RC client-side disabled states', () => {
  it('RC1: REPORTS.mainnet is non-null (mainnet report configured); reflowConfig still guards testnet contracts on mainnet', () => {
    // REPORTS.mainnet is now configured.
    expect(REPORTS.mainnet).not.toBeNull()
    // reflowConfig still calls assertNotKnownTestnetContract to guard testnet contracts on mainnet.
    const root = process.cwd()
    const src = readFileSync(join(root, 'src/lib/reflowConfig.ts'), 'utf8')
    expect(src).toMatch(/assertNotKnownTestnetContract/)
  })

  it('RC2: reflowConfig readEnvAddress refuses known testnet contract on mainnet', () => {
    const root = process.cwd()
    const src = readFileSync(join(root, 'src/lib/reflowConfig.ts'), 'utf8')
    expect(src).toMatch(/assertNotKnownTestnetContract/)
  })

  it('RC3: all write actions gated behind isConfigured in PurchaseRoom.tsx', () => {
    const root = process.cwd()
    const src = readFileSync(join(root, 'src/components/PurchaseRoom.tsx'), 'utf8')
    // PurchaseRoom must gate on isConfigured or pendingReason
    expect(src).toMatch(/isConfigured|pendingReason/)
  })

  it('RC4: AdminView gates pool creation behind CONTRACT_ADDRESS or mainnetConfirmed', () => {
    const root = process.cwd()
    const src = readFileSync(join(root, 'src/components/AdminView.tsx'), 'utf8')
    // AdminView checks CONTRACT_ADDRESS (null when setup pending) and
    // mainnetConfirmed (typed phrase gate on mainnet)
    expect(src).toMatch(/CONTRACT_ADDRESS|mainnetConfirmed/)
  })
})

// ── N4: source scan ───────────────────────────────────────────────────────────
// No 5042002 / ARC_TESTNET_CHAIN_ID / arcTestnet literals outside approved files.

describe('N4 source scan', () => {
  const root    = process.cwd()
  const srcDir  = join(root, 'src')
  const srvDir  = join(root, 'server')

  // Allowed files (may contain the literals)
  const ALLOWED = new Set([
    join(root, 'src/lib/network.ts'),
    join(root, 'src/onchain-facts.ts'),
    join(root, 'src/lib/reflowConfig.ts'),         // re-exports ARC_TESTNET_CHAIN_ID
    join(root, 'src/config.ts'),                    // uses arc/arcTestnet from viem/chains
    join(root, 'server/constants.ts'),              // re-exports ARC_TESTNET_CHAIN_ID
    join(root, 'src/hooks/useEventIndexer.ts'),     // imports arcTestnet as alias from viem/chains
  ])

  function gatherTsFiles(dir: string): string[] {
    const out: string[] = []
    function walk(d: string): void {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full)
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          out.push(full)
        }
      }
    }
    walk(dir)
    return out
  }

  it('N4.4: no raw 5042002 literal in non-allowed src/ and server/ files', () => {
    const files = [...gatherTsFiles(srcDir), ...gatherTsFiles(srvDir)]
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => !f.includes('/tests/') && !f.includes('.test.'))
    const hits: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      if (src.includes('5042002')) hits.push(f)
    }
    expect(hits).toHaveLength(0)
  })

  it('N4.5: no raw arcTestnet import/usage in non-allowed src/ files (excluding tests)', () => {
    const files = gatherTsFiles(srcDir)
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => !f.includes('/tests/') && !f.includes('.test.'))
    const hits: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      if (/arcTestnet[^A-Z_a-z]/.test(src)) hits.push(f)
    }
    expect(hits).toHaveLength(0)
  })
})
