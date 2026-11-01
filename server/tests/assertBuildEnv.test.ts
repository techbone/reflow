/**
 * assertBuildEnv.test.ts — tests for the Docker build-time env validation logic.
 *
 * We test the same guards that assert-build-env.ts exercises, without spawning
 * a subprocess (process.exit cannot be mocked cleanly in vitest without extra
 * plumbing). Each case corresponds to one of the six checks in the script.
 *
 * Test groups:
 *   ABE — assert-build-env logic (checks 1-6)
 */

import { describe, it, expect } from 'vitest'
import {
  resolveNetwork,
  assertNotKnownTestnetContract,
  KNOWN_TESTNET_CONTRACTS,
} from '../../src/lib/network.js'
import { REPORTS } from '../../src/lib/reportManifest.js'

const TESTNET_CONTRACT = '0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9'
const MAINNET_CONTRACT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const VALID_ADDRESS    = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

// ── Re-implement the six checks as pure functions (mirrors assert-build-env.ts) ──

function check1_network(env: Record<string, string | undefined>): { ok: boolean; error?: string } {
  try { resolveNetwork(env); return { ok: true } }
  catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) } }
}

function check2_contract(contract: string): { ok: boolean; error?: string } {
  if (!contract.trim()) return { ok: false, error: 'VITE_REFLOW_CONTRACT is not set' }
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract.trim())) return { ok: false, error: `Not a valid address: ${contract}` }
  return { ok: true }
}

function check3_poolId(poolId: string): { ok: boolean; error?: string } {
  const s = poolId.trim()
  if (!s) return { ok: false, error: 'Pool ID is not set' }
  const n = parseInt(s, 10)
  if (!Number.isInteger(n) || n <= 0 || String(n) !== s) return { ok: false, error: `Invalid pool ID: ${poolId}` }
  return { ok: true }
}

function check4_fromBlock(fromBlock: string): { ok: boolean; error?: string } {
  const s = fromBlock.trim()
  if (!s) return { ok: true } // optional
  const n = parseInt(s, 10)
  if (!Number.isInteger(n) || n < 0 || String(n) !== s) return { ok: false, error: `Invalid fromBlock: ${fromBlock}` }
  return { ok: true }
}

function check5_mainnetContract(contract: string, networkKey: 'testnet' | 'mainnet'): { ok: boolean; error?: string } {
  if (networkKey !== 'mainnet') return { ok: true }
  const net = resolveNetwork({ VITE_REFLOW_NETWORK: 'mainnet' })
  try { assertNotKnownTestnetContract(contract, net); return { ok: true } }
  catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) } }
}

function check6_artifactFile(networkKey: 'testnet' | 'mainnet', filesPresent: string[]): { ok: boolean; error?: string } {
  const report = REPORTS[networkKey]
  if (report === null) return { ok: false, error: `REPORTS["${networkKey}"] is null` }
  const expected = report.artifactFilename
  if (!filesPresent.includes(expected)) {
    return { ok: false, error: `Private artifact file not found: server/private/${expected}` }
  }
  return { ok: true }
}

// ── ABE tests ─────────────────────────────────────────────────────────────────

describe('ABE — assert-build-env check 1: VITE_REFLOW_NETWORK', () => {
  it('ABE1: empty env → testnet (ok)', () => {
    expect(check1_network({}).ok).toBe(true)
  })
  it('ABE2: testnet → ok', () => {
    expect(check1_network({ VITE_REFLOW_NETWORK: 'testnet' }).ok).toBe(true)
  })
  it('ABE3: mainnet → ok', () => {
    expect(check1_network({ VITE_REFLOW_NETWORK: 'mainnet' }).ok).toBe(true)
  })
  it('ABE4: typo "mainnnet" → error', () => {
    const r = check1_network({ VITE_REFLOW_NETWORK: 'mainnnet' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Invalid/)
  })
  it('ABE5: both set and differ → error', () => {
    const r = check1_network({ REFLOW_NETWORK: 'mainnet', VITE_REFLOW_NETWORK: 'testnet' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/disagree/)
  })
})

describe('ABE — assert-build-env check 2: VITE_REFLOW_CONTRACT', () => {
  it('ABE6: unset → error', () => {
    expect(check2_contract('').ok).toBe(false)
  })
  it('ABE7: valid address → ok', () => {
    expect(check2_contract(VALID_ADDRESS).ok).toBe(true)
  })
  it('ABE8: short address → error', () => {
    expect(check2_contract('0xabc').ok).toBe(false)
  })
  it('ABE9: missing 0x prefix → error', () => {
    expect(check2_contract('ab'.repeat(20)).ok).toBe(false)
  })
})

describe('ABE — assert-build-env check 3: REFLOW_POOL_ID', () => {
  it('ABE10: unset → error', () => {
    expect(check3_poolId('').ok).toBe(false)
  })
  it('ABE11: "2" → ok', () => {
    expect(check3_poolId('2').ok).toBe(true)
  })
  it('ABE12: "0" → error (must be positive)', () => {
    expect(check3_poolId('0').ok).toBe(false)
  })
  it('ABE13: "2.5" → error', () => {
    expect(check3_poolId('2.5').ok).toBe(false)
  })
  it('ABE14: "-1" → error', () => {
    expect(check3_poolId('-1').ok).toBe(false)
  })
})

describe('ABE — assert-build-env check 4: VITE_REFLOW_FROM_BLOCK', () => {
  it('ABE15: unset → ok (optional)', () => {
    expect(check4_fromBlock('').ok).toBe(true)
  })
  it('ABE16: "68201692" → ok', () => {
    expect(check4_fromBlock('68201692').ok).toBe(true)
  })
  it('ABE17: "0" → ok', () => {
    expect(check4_fromBlock('0').ok).toBe(true)
  })
  it('ABE18: "-1" → error', () => {
    expect(check4_fromBlock('-1').ok).toBe(false)
  })
  it('ABE19: "1.5" → error', () => {
    expect(check4_fromBlock('1.5').ok).toBe(false)
  })
})

describe('ABE — assert-build-env check 5: mainnet must not use testnet contract', () => {
  it('ABE20: testnet + testnet contract → ok (no check on testnet)', () => {
    expect(check5_mainnetContract(TESTNET_CONTRACT, 'testnet').ok).toBe(true)
  })
  it('ABE21: mainnet + mainnet contract → ok', () => {
    expect(check5_mainnetContract(MAINNET_CONTRACT, 'mainnet').ok).toBe(true)
  })
  it('ABE22: mainnet + known testnet contract → error', () => {
    const r = check5_mainnetContract(TESTNET_CONTRACT, 'mainnet')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/testnet-only/)
  })
  it('ABE23: KNOWN_TESTNET_CONTRACTS contains the deployed address', () => {
    expect(KNOWN_TESTNET_CONTRACTS.has(TESTNET_CONTRACT)).toBe(true)
  })
})

describe('ABE — assert-build-env check 6: network-specific artifact file must be present', () => {
  const TESTNET_FILE  = 'arc-activity-report-v1.json'
  const MAINNET_FILE  = 'arc-activity-report-mainnet-v1.json'

  it('ABE24: testnet + testnet artifact present → ok', () => {
    expect(check6_artifactFile('testnet', [TESTNET_FILE]).ok).toBe(true)
  })
  it('ABE25: mainnet + mainnet artifact present → ok', () => {
    expect(check6_artifactFile('mainnet', [MAINNET_FILE]).ok).toBe(true)
  })
  it('ABE26: mainnet + testnet file only (wrong file) → error', () => {
    const r = check6_artifactFile('mainnet', [TESTNET_FILE])
    expect(r.ok).toBe(false)
    expect(r.error).toContain(MAINNET_FILE)
  })
  it('ABE27: testnet + no file → error', () => {
    const r = check6_artifactFile('testnet', [])
    expect(r.ok).toBe(false)
    expect(r.error).toContain(TESTNET_FILE)
  })
  it('ABE28: REPORTS.testnet.artifactFilename is the testnet filename', () => {
    expect(REPORTS['testnet']?.artifactFilename).toBe(TESTNET_FILE)
  })
  it('ABE29: REPORTS.mainnet.artifactFilename is the mainnet filename', () => {
    expect(REPORTS['mainnet']?.artifactFilename).toBe(MAINNET_FILE)
  })
  it('ABE30: both files present → each network passes independently', () => {
    const both = [TESTNET_FILE, MAINNET_FILE]
    expect(check6_artifactFile('testnet', both).ok).toBe(true)
    expect(check6_artifactFile('mainnet', both).ok).toBe(true)
  })
})
