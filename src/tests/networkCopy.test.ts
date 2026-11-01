/**
 * networkCopy.test.ts — M3 cleanup: network-aware copy tests
 *
 * Test groups:
 *
 *   NC_ORC  — TxOrchestrator chain-mismatch + no-code messages name the correct network
 *   NC_PARSE — parseOnchainError wrong-chain message names the correct network
 *   NC_SCAN  — Whole-source scan: no hardcoded testnet-only strings in non-test source
 *   NC_TEXT  — poolFootnoteText pure-function: no cross-network leakage
 *   NC_RENDER — HowItWorks rendered HTML: no hardcoded "Arc Testnet"
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, statSync } from 'node:fs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── NC_ORC — TxOrchestrator chain messages ────────────────────────────────────

import { TxOrchestrator } from '../lib/TxOrchestrator'
import type { RpcAdapter, WalletAdapter, StorageAdapter } from '../lib/TxOrchestrator'

const CONTRACT   = '0x1111111111111111111111111111111111111111' as `0x${string}`
const USDC       = '0x3600000000000000000000000000000000000000' as `0x${string}`
const WALLET     = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`
const POOL_ID    = 1n

/** Minimal passing RPC adapter — all reads succeed with realistic values. */
function makeMinimalRpc(overrides: Partial<RpcAdapter> = {}): RpcAdapter {
  return {
    getChainId:                    () => Promise.resolve(5042002),
    getCode:                       () => Promise.resolve('0xdeadbeef'),
    readContract_usdc:             () => Promise.resolve(USDC),
    readContract_decimals:         () => Promise.resolve(6),
    readContract_poolExists:       () => Promise.resolve(true),
    readContract_balanceOf:        () => Promise.resolve(10_000_000n),
    readContract_allowance:        () => Promise.resolve(10_000_000n),
    simulateApprove:               () => Promise.resolve(),
    simulatePurchaseFirst:         () => Promise.resolve(),
    simulateJoin:                  () => Promise.resolve(),
    simulateClaim:                 () => Promise.resolve(),
    estimateGas_approve:           () => Promise.resolve(100_000n),
    estimateGas_purchaseFirst:     () => Promise.resolve(100_000n),
    estimateGas_join:              () => Promise.resolve(100_000n),
    estimateGas_claim:             () => Promise.resolve(100_000n),
    getGasPrice:                   () => Promise.resolve(1_000_000_000n),
    getNativeBalance:              () => Promise.resolve(10n ** 19n),
    getTransactionCount:           () => Promise.resolve(0),
    getBlockNumber:                () => Promise.resolve(1000n),
    getTransactionReceipt:         () => Promise.resolve(null as never),
    getTransaction:                () => Promise.resolve(null as never),
    ...overrides,
  }
}

function makeMinimalWallet(chainId: number): WalletAdapter {
  return {
    currentAccount: () => ({ address: WALLET, chainId }),
    writeApprove:        () => Promise.resolve('0x' + 'aa'.repeat(32) as `0x${string}`),
    writePurchaseFirst:  () => Promise.resolve('0x' + 'ab'.repeat(32) as `0x${string}`),
    writeJoin:           () => Promise.resolve('0x' + 'ac'.repeat(32) as `0x${string}`),
    writeClaim:          () => Promise.resolve('0x' + 'ad'.repeat(32) as `0x${string}`),
  }
}

function makeMemStorage(): StorageAdapter {
  const store: Record<string, string> = {}
  return {
    getItem:    (k) => store[k] ?? null,
    setItem:    (k, v) => { store[k] = v },
    removeItem: (k) => { delete store[k] },
  }
}

describe('NC_ORC — TxOrchestrator network-named error messages', () => {
  it('NC_ORC1: mainnet orchestrator + wrong wallet chain → message names Arc Mainnet and chain id 5042', async () => {
    const ARC_MAINNET_CHAIN_ID = 5042
    const rpc = makeMinimalRpc({ getChainId: () => Promise.resolve(ARC_MAINNET_CHAIN_ID) })
    // Wallet reports testnet chain id — chain mismatch
    const wallet = makeMinimalWallet(5042002)
    const storage = makeMemStorage()
    const orc = new TxOrchestrator(
      CONTRACT, POOL_ID, rpc, wallet, storage,
      ARC_MAINNET_CHAIN_ID, USDC,
      undefined, undefined,
      'Arc Mainnet',
    )
    await orc.execute({ action: 'purchaseFirst', price: 1_200_000n }, WALLET, 5042002)
    expect(orc.state.phase).toBe('error')
    const msg = orc.state.errorMsg ?? ''
    expect(msg).toContain('Arc Mainnet')
    expect(msg).toContain(String(ARC_MAINNET_CHAIN_ID))
    expect(msg.toLowerCase()).not.toContain('testnet')
  })

  it('NC_ORC2: testnet orchestrator + wrong wallet chain → message names Arc Testnet and chain id 5042002', async () => {
    const ARC_TESTNET_CHAIN_ID = 5042002
    const rpc = makeMinimalRpc({ getChainId: () => Promise.resolve(ARC_TESTNET_CHAIN_ID) })
    // Wallet reports mainnet chain id — chain mismatch
    const wallet = makeMinimalWallet(5042)
    const storage = makeMemStorage()
    const orc = new TxOrchestrator(
      CONTRACT, POOL_ID, rpc, wallet, storage,
      ARC_TESTNET_CHAIN_ID, USDC,
      undefined, undefined,
      'Arc Testnet',
    )
    await orc.execute({ action: 'purchaseFirst', price: 1_200_000n }, WALLET, 5042)
    expect(orc.state.phase).toBe('error')
    const msg = orc.state.errorMsg ?? ''
    expect(msg).toContain('Arc Testnet')
    expect(msg).toContain(String(ARC_TESTNET_CHAIN_ID))
    expect(msg.toLowerCase()).not.toContain('mainnet')
  })

  it('NC_ORC3: mainnet orchestrator + no deployed code → message names Arc Mainnet, not Testnet', async () => {
    const ARC_MAINNET_CHAIN_ID = 5042
    const rpc = makeMinimalRpc({
      getChainId: () => Promise.resolve(ARC_MAINNET_CHAIN_ID),
      getCode:    () => Promise.resolve('0x'),
    })
    const wallet = makeMinimalWallet(ARC_MAINNET_CHAIN_ID)
    const storage = makeMemStorage()
    const orc = new TxOrchestrator(
      CONTRACT, POOL_ID, rpc, wallet, storage,
      ARC_MAINNET_CHAIN_ID, USDC,
      undefined, undefined,
      'Arc Mainnet',
    )
    await orc.execute({ action: 'purchaseFirst', price: 1_200_000n }, WALLET, ARC_MAINNET_CHAIN_ID)
    expect(orc.state.phase).toBe('error')
    const msg = orc.state.errorMsg ?? ''
    expect(msg).toContain('Arc Mainnet')
    expect(msg.toLowerCase()).not.toContain('testnet')
  })

  it('NC_ORC4: testnet orchestrator + no deployed code → message names Arc Testnet, not Mainnet', async () => {
    const ARC_TESTNET_CHAIN_ID = 5042002
    const rpc = makeMinimalRpc({
      getChainId: () => Promise.resolve(ARC_TESTNET_CHAIN_ID),
      getCode:    () => Promise.resolve('0x'),
    })
    const wallet = makeMinimalWallet(ARC_TESTNET_CHAIN_ID)
    const storage = makeMemStorage()
    const orc = new TxOrchestrator(
      CONTRACT, POOL_ID, rpc, wallet, storage,
      ARC_TESTNET_CHAIN_ID, USDC,
      undefined, undefined,
      'Arc Testnet',
    )
    await orc.execute({ action: 'purchaseFirst', price: 1_200_000n }, WALLET, ARC_TESTNET_CHAIN_ID)
    expect(orc.state.phase).toBe('error')
    const msg = orc.state.errorMsg ?? ''
    expect(msg).toContain('Arc Testnet')
    expect(msg.toLowerCase()).not.toContain('mainnet')
  })
})

// ── NC_PARSE — parseOnchainError network-aware wrong-chain message ────────────

import { parseOnchainError } from '../lib/parseOnchainError'

describe('NC_PARSE — parseOnchainError network name in wrong-chain message', () => {
  it('NC_PARSE1: wrong-chain error with networkName="Arc Mainnet" → message names Arc Mainnet', () => {
    const result = parseOnchainError(new Error('wrong chain switch'), 'Arc Mainnet')
    expect(result.kind).toBe('wrong-chain')
    expect(result.message).toContain('Arc Mainnet')
    expect(result.message.toLowerCase()).not.toContain('testnet')
  })

  it('NC_PARSE2: wrong-chain error with networkName="Arc Testnet" → message names Arc Testnet', () => {
    const result = parseOnchainError(new Error('wrong chain switch'), 'Arc Testnet')
    expect(result.kind).toBe('wrong-chain')
    expect(result.message).toContain('Arc Testnet')
    expect(result.message.toLowerCase()).not.toContain('mainnet')
  })

  it('NC_PARSE3: non-chain error is unaffected by networkName', () => {
    const result = parseOnchainError(new Error('insufficient funds'), 'Arc Mainnet')
    expect(result.kind).toBe('insufficient-balance')
  })
})

// ── NC_SCAN — whole-source scan for hardcoded testnet strings ─────────────────
//
// Allowlisted files are permitted to contain these strings because they define
// the testnet configuration itself (not user-visible copy that would appear in
// mainnet mode).
//
// Banned literals (case-sensitive):
//   "Arc Testnet"    — hardcoded network name; must come from NETWORK.name
//   "testnet only"   — always wrong in mainnet mode
//   "no real funds"  — always wrong in mainnet mode

const SCAN_BANNED: RegExp[] = [
  /["'`]Arc Testnet["'`]/,     // exact string literal: "Arc Testnet", 'Arc Testnet', `Arc Testnet`
  /testnet only/i,
  /no real funds/i,
]

// Files whose content is legitimately allowed to contain these strings.
// These are either config/constant files that define the testnet network, or files
// that contain the strings exclusively inside an explicit ternary guarded by
// networkIsMainnet === false (poolFootnoteText in PurchaseRoom.tsx).
const SCAN_ALLOWLIST = new Set([
  'src/lib/network.ts',
  'src/onchain-facts.ts',
  'src/lib/testPoolConstants.ts',
  'src/lib/reportManifest.ts',
  // poolFootnoteText returns "testnet only / no real funds" only when networkIsMainnet===false
  'src/components/PurchaseRoom.tsx',
  // App.tsx footer renders "testnet only / no real funds" only in the NETWORK.isMainnet===false branch
  'src/App.tsx',
])

/** Recursively list all .ts and .tsx files under a directory, excluding node_modules and tests. */
function listSourceFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'tests' || entry === 'test') continue
      results.push(...listSourceFiles(full))
    } else if (st.isFile() && (entry.endsWith('.ts') || entry.endsWith('.tsx'))) {
      results.push(full)
    }
  }
  return results
}

/** Strip line comments and block comments from source before scanning. */
function stripComments(src: string): string {
  // Remove block comments /* ... */
  src = src.replace(/\/\*[\s\S]*?\*\//g, '')
  // Remove line comments // ...
  src = src.replace(/\/\/.*/g, '')
  return src
}

describe('NC_SCAN — no hardcoded testnet-only strings in non-test source', () => {
  const srcDir    = resolve(PROJECT_ROOT, 'src')
  const serverDir = resolve(PROJECT_ROOT, 'server')

  const allFiles = [
    ...listSourceFiles(srcDir),
    ...listSourceFiles(serverDir),
  ].map((f) => f.replace(PROJECT_ROOT + '/', '')) // project-relative

  const nonAllowlisted = allFiles.filter((f) => !SCAN_ALLOWLIST.has(f))

  for (const banned of SCAN_BANNED) {
    it(`NC_SCAN: no file contains ${banned} in non-comment, non-allowlisted source`, () => {
      const violations: string[] = []
      for (const relPath of nonAllowlisted) {
        const src = readFileSync(resolve(PROJECT_ROOT, relPath), 'utf-8')
        const stripped = stripComments(src)
        if (banned.test(stripped)) {
          violations.push(relPath)
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `Banned pattern ${banned} found in:\n${violations.map((f) => `  ${f}`).join('\n')}`,
        )
      }
    })
  }
})

// ── NC_TEXT — poolFootnoteText pure function ──────────────────────────────────

import { poolFootnoteText } from '../components/PurchaseRoom'

describe('NC_TEXT — poolFootnoteText: no cross-network leakage', () => {
  // Mainnet checks
  it('NC_TEXT1: mainnet + real → no "testnet", contains "real USDC"', () => {
    const t = poolFootnoteText(true, 'Arc Mainnet', 'real')
    expect(t.toLowerCase()).not.toContain('testnet')
    expect(t.toLowerCase()).toContain('real usdc')
    expect(t).toContain('Arc Mainnet')
  })

  it('NC_TEXT2: mainnet + test → no "testnet" string (the word "test" in "Test pool" is OK)', () => {
    const t = poolFootnoteText(true, 'Arc Mainnet', 'test')
    expect(t.toLowerCase()).not.toContain('testnet')
    expect(t.toLowerCase()).toContain('real usdc')
  })

  it('NC_TEXT3: mainnet + unknown → no "testnet", no "no real funds"', () => {
    const t = poolFootnoteText(true, 'Arc Mainnet', 'unknown')
    expect(t.toLowerCase()).not.toContain('testnet')
    expect(t.toLowerCase()).not.toContain('no real funds')
    expect(t.toLowerCase()).toContain('real usdc')
  })

  it('NC_TEXT4: mainnet + null → no "testnet", no "no real funds"', () => {
    const t = poolFootnoteText(true, 'Arc Mainnet', null)
    expect(t.toLowerCase()).not.toContain('testnet')
    expect(t.toLowerCase()).not.toContain('no real funds')
  })

  // Testnet checks
  it('NC_TEXT5: testnet + real → no "real USDC", no "mainnet"', () => {
    const t = poolFootnoteText(false, 'Arc Testnet', 'real')
    expect(t.toLowerCase()).not.toContain('real usdc')
    expect(t.toLowerCase()).not.toContain('mainnet')
  })

  it('NC_TEXT6: testnet + test → no "real USDC", no "mainnet"', () => {
    const t = poolFootnoteText(false, 'Arc Testnet', 'test')
    expect(t.toLowerCase()).not.toContain('real usdc')
    expect(t.toLowerCase()).not.toContain('mainnet')
  })

  it('NC_TEXT7: testnet + unknown → mentions "testnet", "no real funds"', () => {
    const t = poolFootnoteText(false, 'Arc Testnet', 'unknown')
    expect(t.toLowerCase()).toContain('testnet')
    expect(t.toLowerCase()).toContain('no real funds')
  })

  it('NC_TEXT8: testnet + null → mentions "testnet", "no real funds"', () => {
    const t = poolFootnoteText(false, 'Arc Testnet', null)
    expect(t.toLowerCase()).toContain('testnet')
    expect(t.toLowerCase()).toContain('no real funds')
  })
})

// ── NC_RENDER — HowItWorks rendered HTML ─────────────────────────────────────
//
// HowItWorks has no wallet hooks so it can be rendered with renderToStaticMarkup.
// ResourceCard and ReceiptView have hooks; we test them via source scan instead.

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { HowItWorks } from '../components/HowItWorks'

describe('NC_RENDER — component render text', () => {
  it('NC_RENDER1: HowItWorks HTML contains no literal "Arc Testnet"', () => {
    const html = renderToStaticMarkup(createElement(HowItWorks))
    // "Arc Testnet" must not appear as a literal string — it must come from NETWORK.name
    // In test env NETWORK resolves to testnet so the name will appear; what matters is
    // the source no longer hardcodes it.
    // Verify source directly:
    const src = readFileSync(resolve(PROJECT_ROOT, 'src/components/HowItWorks.tsx'), 'utf-8')
    expect(stripComments(src)).not.toMatch(/"Arc Testnet"/)
    expect(stripComments(src)).not.toMatch(/'Arc Testnet'/)
    // The USDC item must use a dynamic expression
    expect(src).toContain('NETWORK.name')
    // Rendered HTML should contain the network name (resolved from NETWORK in test env)
    expect(html).toMatch(/6-decimal ERC-20 on /)
  })

  it('NC_RENDER2: ReceiptView source uses NETWORK.name not literal "Arc Testnet"', () => {
    const src = readFileSync(resolve(PROJECT_ROOT, 'src/components/ReceiptView.tsx'), 'utf-8')
    expect(stripComments(src)).not.toMatch(/"Arc Testnet"/)
    expect(stripComments(src)).not.toMatch(/'Arc Testnet'/)
    expect(src).toContain('NETWORK.name')
  })

  it('NC_RENDER3: ResourceCard source uses NETWORK.name not literal "Arc Testnet"', () => {
    const src = readFileSync(resolve(PROJECT_ROOT, 'src/components/ResourceCard.tsx'), 'utf-8')
    expect(stripComments(src)).not.toMatch(/"Arc Testnet"/)
    expect(stripComments(src)).not.toMatch(/'Arc Testnet'/)
  })

  it('NC_RENDER4: ReceiptView explorer link label no longer says "ArcScan"', () => {
    const src = readFileSync(resolve(PROJECT_ROOT, 'src/components/ReceiptView.tsx'), 'utf-8')
    expect(src).not.toContain('ArcScan')
    expect(src).toContain('Arc explorer')
  })

  it('NC_RENDER5: PurchaseRoom footnote source does not say "local service during development"', () => {
    const src = readFileSync(resolve(PROJECT_ROOT, 'src/components/PurchaseRoom.tsx'), 'utf-8')
    expect(src).not.toContain('local service during development')
  })
})
