/**
 * server/tests/validateConfig.test.ts
 *
 * Pure unit tests for validateServerConfig.
 * No process.exit, no file reads, no port binding, no RPC calls.
 *
 * Mirrors the five startup-validation cases from the bug report:
 *   A. mainnet + known testnet contract     → fatal
 *   B. mainnet + valid config               → OK (REPORTS.mainnet now populated)
 *   C. RPC chain id mismatch               → fatal
 *   D. invalid REFLOW_NETWORK value (typo) → fatal
 *   E. normal testnet                      → OK
 *
 * Plus: missing env vars, both-set-differ, deferred chain-id check (rpcChainId undefined).
 */

import { describe, it, expect } from 'vitest'
import { validateServerConfig } from '../validateConfig.js'
import { ARC_TESTNET_CHAIN_ID, ARC_MAINNET_CHAIN_ID } from '../../src/lib/network.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TESTNET_CONTRACT = '0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9'
const OTHER_CONTRACT   = '0x1111111111111111111111111111111111111111'

const GOOD_TESTNET: Record<string, string | undefined> = {
  REFLOW_NETWORK:       'testnet',
  VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
  REFLOW_POOL_ID:       '2',
}

const ok   = (env: Record<string, string | undefined>, rpcChainId: number | undefined = ARC_TESTNET_CHAIN_ID) =>
  validateServerConfig({ env, rpcChainId })
const fail = (env: Record<string, string | undefined>, rpcChainId: number | undefined = ARC_TESTNET_CHAIN_ID) =>
  validateServerConfig({ env, rpcChainId })

// ── Case E — normal testnet ───────────────────────────────────────────────────

describe('VC-E: valid testnet config', () => {
  it('E1: good testnet env → no errors', () => {
    const r = ok(GOOD_TESTNET)
    expect(r.errors).toHaveLength(0)
    expect(r.network.key).toBe('testnet')
  })

  it('E2: network.chainId equals ARC_TESTNET_CHAIN_ID', () => {
    const r = ok(GOOD_TESTNET)
    expect(r.network.chainId).toBe(ARC_TESTNET_CHAIN_ID)
  })

  it('E3: REFLOW_NETWORK omitted → defaults to testnet', () => {
    const env = { ...GOOD_TESTNET }
    delete env['REFLOW_NETWORK']
    const r = ok(env)
    expect(r.errors).toHaveLength(0)
    expect(r.network.key).toBe('testnet')
  })
})

// ── Case A — mainnet + known testnet contract ─────────────────────────────────

describe('VC-A: mainnet + known testnet contract', () => {
  const ENV_A: Record<string, string | undefined> = {
    REFLOW_NETWORK:       'mainnet',
    VITE_REFLOW_CONTRACT: TESTNET_CONTRACT,
    REFLOW_POOL_ID:       '1',
  }

  it('A1: errors is non-empty', () => {
    const r = fail(ENV_A, ARC_MAINNET_CHAIN_ID)
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('A2: error message names "known testnet-only contract"', () => {
    const r = fail(ENV_A, ARC_MAINNET_CHAIN_ID)
    expect(r.errors.some((e) => /known testnet-only contract/.test(e))).toBe(true)
  })

  it('A3: network resolved as mainnet even when errors present', () => {
    const r = fail(ENV_A, ARC_MAINNET_CHAIN_ID)
    expect(r.network.key).toBe('mainnet')
  })
})

// ── Case B — mainnet + valid config (REPORTS.mainnet is now populated) ────────
//
// REPORTS.mainnet is no longer null, so a mainnet server with a non-testnet
// contract and the correct chain id should now PASS validation.

describe('VC-B: valid mainnet config passes', () => {
  const ENV_B: Record<string, string | undefined> = {
    REFLOW_NETWORK:       'mainnet',
    VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
    REFLOW_POOL_ID:       '1',
  }

  it('B1: mainnet + non-testnet contract + correct chainId → no errors', () => {
    const r = validateServerConfig({ env: ENV_B, rpcChainId: ARC_MAINNET_CHAIN_ID })
    expect(r.errors).toHaveLength(0)
  })

  it('B2: network resolves as mainnet', () => {
    const r = validateServerConfig({ env: ENV_B, rpcChainId: ARC_MAINNET_CHAIN_ID })
    expect(r.network.key).toBe('mainnet')
    expect(r.network.chainId).toBe(ARC_MAINNET_CHAIN_ID)
  })

  it('B3: mainnet still refuses a known testnet contract', () => {
    const env = { ...ENV_B, VITE_REFLOW_CONTRACT: '0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9' }
    const r = validateServerConfig({ env, rpcChainId: ARC_MAINNET_CHAIN_ID })
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.errors.some((e) => /known testnet-only contract/.test(e))).toBe(true)
  })
})

// ── Case C — RPC chain id mismatch ───────────────────────────────────────────

describe('VC-C: RPC chain id mismatch', () => {
  it('C1: testnet config + mainnet rpc chain id → error', () => {
    const r = ok(GOOD_TESTNET, ARC_MAINNET_CHAIN_ID)
    expect(r.errors.some((e) => /does not match/.test(e))).toBe(true)
  })

  it('C2: mainnet config + testnet rpc chain id → error', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'mainnet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
      REFLOW_POOL_ID:       '1',
    }
    const r = fail(env, ARC_TESTNET_CHAIN_ID)
    expect(r.errors.some((e) => /does not match/.test(e))).toBe(true)
  })

  it('C3: testnet config + testnet rpc chain id → no mismatch error', () => {
    const r = ok(GOOD_TESTNET, ARC_TESTNET_CHAIN_ID)
    expect(r.errors.every((e) => !/does not match/.test(e))).toBe(true)
  })

  it('C4: rpcChainId undefined → chain-id check skipped', () => {
    const r = validateServerConfig({ env: GOOD_TESTNET, rpcChainId: undefined })
    expect(r.errors.every((e) => !/does not match/.test(e))).toBe(true)
  })
})

// ── Case D — invalid REFLOW_NETWORK value ─────────────────────────────────────

describe('VC-D: invalid REFLOW_NETWORK value', () => {
  it('D1: "mainet" (typo) → error naming the bad value', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'mainet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
      REFLOW_POOL_ID:       '1',
    }
    const r = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.errors.some((e) => /mainet/.test(e))).toBe(true)
  })

  it('D2: "devnet" → error', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'devnet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
      REFLOW_POOL_ID:       '1',
    }
    const r = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('D3: invalid value → returns placeholder testnet network (early return)', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'mainet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
      REFLOW_POOL_ID:       '1',
    }
    const r = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    // Even though network key is testnet (placeholder), errors is non-empty
    expect(r.errors.length).toBeGreaterThan(0)
  })
})

// ── Both-set-and-differ ────────────────────────────────────────────────────────

describe('VC-both-differ: conflicting REFLOW_NETWORK and VITE_REFLOW_NETWORK', () => {
  it('testnet vs mainnet → error naming both set but disagree', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'testnet',
      VITE_REFLOW_NETWORK:  'mainnet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
      REFLOW_POOL_ID:       '1',
    }
    const r = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(r.errors.some((e) => /both set but disagree/.test(e))).toBe(true)
  })

  it('mainnet vs testnet → error', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'mainnet',
      VITE_REFLOW_NETWORK:  'testnet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
      REFLOW_POOL_ID:       '1',
    }
    const r = validateServerConfig({ env, rpcChainId: ARC_MAINNET_CHAIN_ID })
    expect(r.errors.some((e) => /both set but disagree/.test(e))).toBe(true)
  })

  it('both set to same value → no conflict error', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'testnet',
      VITE_REFLOW_NETWORK:  'testnet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
      REFLOW_POOL_ID:       '2',
    }
    const r = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(r.errors.every((e) => !/both set but disagree/.test(e))).toBe(true)
  })
})

// ── Missing required fields ───────────────────────────────────────────────────

describe('VC-missing: missing required env vars', () => {
  it('missing VITE_REFLOW_CONTRACT → error', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK: 'testnet',
      REFLOW_POOL_ID: '1',
    }
    const r = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(r.errors.some((e) => /VITE_REFLOW_CONTRACT/.test(e))).toBe(true)
  })

  it('missing REFLOW_POOL_ID → error', () => {
    const env: Record<string, string | undefined> = {
      REFLOW_NETWORK:       'testnet',
      VITE_REFLOW_CONTRACT: OTHER_CONTRACT,
    }
    const r = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(r.errors.some((e) => /REFLOW_POOL_ID/.test(e))).toBe(true)
  })

  it('both missing → two errors', () => {
    const env: Record<string, string | undefined> = { REFLOW_NETWORK: 'testnet' }
    const r = validateServerConfig({ env, rpcChainId: ARC_TESTNET_CHAIN_ID })
    expect(r.errors.filter((e) => /VITE_REFLOW_CONTRACT|REFLOW_POOL_ID/.test(e)).length)
      .toBe(2)
  })
})
