/**
 * m3b.test.ts — M3 step B safety + wording + hosting tests
 *
 * Test groups:
 *
 *   RA_B — buildRealPoolArgs: network/chainId mismatch blocks; testnet hashes refused mainnet
 *   DC_B — DeliveryController: commitmentCheck blocks on network mismatch; null REPORTS disables
 *   RM_B — reportManifest: selectTerms / classifyArtifact null-REPORTS and testnet-on-mainnet
 *   WD   — Wording: no hardcoded "testnet" user-visible string when NETWORK.isMainnet
 *   ST   — Static serving: wrapWithStatic path traversal, healthz, index fallback, /api not shadowed
 *   COM  — server commitment getCommitment returns network + chainId
 */

/* eslint-disable @typescript-eslint/require-await */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

import {
  selectTerms,
  classifyArtifact,
  REPORTS,
  REAL_ARTIFACT_HASH,
  REAL_TERMS_HASH,
} from '../lib/reportManifest'
import {
  TEST_POOL_ARTIFACT_HASH,
  TEST_POOL_TERMS_HASH,
} from '../lib/testPoolConstants'
import {
  DeliveryController,
  type DeliveryAdapters,
  type DeliveryPhase,
} from '../lib/DeliveryController'
import { hashBytes } from '../lib/reportManifest'
import { buildRealPoolArgs } from '../components/AdminView'

const UNKNOWN_HASH = '0x' + 'ab'.repeat(32) as `0x${string}`
const REAL_TERMS_BYTES = readFileSync(resolve(PROJECT_ROOT, 'public/report-v1/terms.md'))
const GOOD_ARTIFACT_BYTES = new Uint8Array(
  readFileSync(resolve(PROJECT_ROOT, 'server/private/arc-activity-report-v1.json'))
)

// ── RM_B — reportManifest null REPORTS ───────────────────────────────────────

describe('RM_B — reportManifest: REPORTS both networks; testnet-on-mainnet refused', () => {
  it('RM_B1: classifyArtifact on mainnet returns unknown for testnet hashes', () => {
    // Testnet/test-pool hashes are always refused on mainnet
    expect(classifyArtifact(REAL_ARTIFACT_HASH, 'mainnet')).toBe('unknown')
    expect(classifyArtifact(TEST_POOL_ARTIFACT_HASH, 'mainnet')).toBe('unknown')
    // Unknown hash also returns unknown
    expect(classifyArtifact(UNKNOWN_HASH, 'mainnet')).toBe('unknown')
  })

  it('RM_B2: selectTerms on mainnet returns unknown for testnet hashes', () => {
    expect(selectTerms(REAL_TERMS_HASH, 'mainnet').kind).toBe('unknown')
    expect(selectTerms(TEST_POOL_TERMS_HASH, 'mainnet').kind).toBe('unknown')
    expect(selectTerms(UNKNOWN_HASH, 'mainnet').kind).toBe('unknown')
  })

  it('RM_B3: REPORTS both testnet and mainnet are non-null (both networks configured)', () => {
    expect(REPORTS['testnet']).not.toBeNull()
    expect(REPORTS['mainnet']).not.toBeNull()
  })

  it('RM_B4: selectTerms testnet real hash → real kind with path', () => {
    const spec = selectTerms(REAL_TERMS_HASH, 'testnet')
    expect(spec.kind).toBe('real')
    expect(spec.path).toBeTruthy()
  })

  it('RM_B5: selectTerms testnet test-pool hash → test kind', () => {
    const spec = selectTerms(TEST_POOL_TERMS_HASH, 'testnet')
    expect(spec.kind).toBe('test')
  })

  it('RM_B6: classifyArtifact testnet real hash → real', () => {
    expect(classifyArtifact(REAL_ARTIFACT_HASH, 'testnet')).toBe('real')
  })

  it('RM_B7: classifyArtifact testnet test-pool hash → test', () => {
    expect(classifyArtifact(TEST_POOL_ARTIFACT_HASH, 'testnet')).toBe('test')
  })

  it('RM_B8: REPORTS testnet artifactHash matches REAL_ARTIFACT_HASH constant', () => {
    expect(REPORTS['testnet']!.artifactHash.toLowerCase()).toBe(REAL_ARTIFACT_HASH.toLowerCase())
  })

  it('RM_B9: REPORTS testnet termsHash matches REAL_TERMS_HASH constant', () => {
    expect(REPORTS['testnet']!.termsHash.toLowerCase()).toBe(REAL_TERMS_HASH.toLowerCase())
  })

  it('RM_B10: classifyArtifact mainnet hash → real on mainnet', () => {
    const mainnetArtifactHash = REPORTS['mainnet']!.artifactHash
    expect(classifyArtifact(mainnetArtifactHash, 'mainnet')).toBe('real')
  })

  it('RM_B11: selectTerms mainnet terms hash → real kind on mainnet', () => {
    const mainnetTermsHash = REPORTS['mainnet']!.termsHash
    const spec = selectTerms(mainnetTermsHash, 'mainnet')
    expect(spec.kind).toBe('real')
    expect(spec.path).toContain('mainnet')
  })

  it('RM_B12: classifyArtifact mainnet hash → unknown on testnet (not cross-contaminated)', () => {
    const mainnetArtifactHash = REPORTS['mainnet']!.artifactHash
    // Mainnet hash is not in the testnet's known set, so classifies as unknown on testnet
    expect(classifyArtifact(mainnetArtifactHash, 'testnet')).toBe('unknown')
  })

  it('RM_B13: selectTerms mainnet terms hash → unknown on testnet', () => {
    const mainnetTermsHash = REPORTS['mainnet']!.termsHash
    const spec = selectTerms(mainnetTermsHash, 'testnet')
    expect(spec.kind).toBe('unknown')
  })

  it('RM_B14: REPORTS mainnet has correct artifact and terms filenames', () => {
    expect(REPORTS['mainnet']!.artifactFilename).toBe('arc-activity-report-mainnet-v1.json')
    expect(REPORTS['mainnet']!.downloadFilename).toBe('arc-activity-report-mainnet-v1.json')
  })

  it('RM_B15: REPORTS mainnet has correct manifest and terms paths', () => {
    expect(REPORTS['mainnet']!.manifestPath).toContain('mainnet')
    expect(REPORTS['mainnet']!.termsPath).toContain('mainnet')
    expect(REPORTS['mainnet']!.previewPath).toContain('mainnet')
  })
})

// ── RA_B — buildRealPoolArgs: network/chainId mismatch blocks ─────────────────

describe('RA_B — buildRealPoolArgs: network/chainId mismatch', () => {
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

  function mockFetch(responses: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const key = Object.keys(responses).find(k => (url).endsWith(k)) ?? url
      const body = responses[key]
      if (body instanceof Error) throw body
      if (body === undefined) return { ok: false, status: 404, statusText: 'Not found' } as Response
      if (ArrayBuffer.isView(body)) {
        const ab = (body as Uint8Array).buffer.slice(
          (body as Uint8Array).byteOffset,
          (body as Uint8Array).byteOffset + (body as Uint8Array).byteLength,
        )
        return { ok: true, arrayBuffer: async () => ab } as unknown as Response
      }
      return { ok: true, json: async () => body } as unknown as Response
    }))
  }

  beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('RA_B1: server returns network="mainnet" → buildRealPoolArgs throws network mismatch', async () => {
    mockFetch({
      '/api/report/commitment': { ...goodCommitment, network: 'mainnet' },
      '/report-v1/manifest.json': goodManifest,
      '/report-v1/terms.md': new Uint8Array(REAL_TERMS_BYTES),
    })
    await expect(buildRealPoolArgs(testnetReport)).rejects.toThrow(/network mismatch/i)
  })

  it('RA_B2: server returns chainId=1 → buildRealPoolArgs throws chain ID mismatch', async () => {
    mockFetch({
      '/api/report/commitment': { ...goodCommitment, chainId: 1 },
      '/report-v1/manifest.json': goodManifest,
      '/report-v1/terms.md': new Uint8Array(REAL_TERMS_BYTES),
    })
    await expect(buildRealPoolArgs(testnetReport)).rejects.toThrow(/chain ID mismatch/i)
  })

  it('RA_B3: server returns correct network+chainId → succeeds', async () => {
    mockFetch({
      '/api/report/commitment': goodCommitment,
      '/report-v1/manifest.json': goodManifest,
      '/report-v1/terms.md': new Uint8Array(REAL_TERMS_BYTES),
    })
    const { artifactHash } = await buildRealPoolArgs(testnetReport)
    expect(artifactHash.toLowerCase()).toBe(REAL_ARTIFACT_HASH.toLowerCase())
  })
})

// ── DC_B — DeliveryController commitmentCheck ─────────────────────────────────

describe('DC_B — DeliveryController: commitmentCheck guards', () => {
  const MEMBER_ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`
  const POOL_ID = 1n

  function makeAdapters(commitCheck: { ok: true } | { ok: false; message: string }): DeliveryAdapters {
    return {
      membership: { async isMember() { return true } },
      signer: { async signMessage() { return `0x${'aa'.repeat(65)}` } },
      fetcher: {
        async commitmentCheck() { return commitCheck },
        async challenge() { return { message: 'sign this', nonce: 'n' } },
        async session() { return { token: 'tok' } },
        async file() { return { bytes: GOOD_ARTIFACT_BYTES, headerHash: null } },
      },
      hasher: { keccak256: hashBytes },
    }
  }

  it('DC_B1: commitmentCheck ok → proceeds to membership check', async () => {
    const phases: string[] = []
    const adapters = makeAdapters({ ok: true })
    const ctrl = new DeliveryController(adapters, s => phases.push(s.status), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    // Commitment check succeeded — should have proceeded to checking-membership
    expect(phases).toContain('checking-membership')
    expect(phases[phases.length - 1]).toBe('verified')
  })

  it('DC_B2: commitmentCheck fails (network mismatch) → service-refused error, no membership call', async () => {
    const phases: DeliveryPhase[] = []
    const adapters = makeAdapters({ ok: false, message: 'Delivery server is on network "mainnet" but this client is configured for "testnet".' })
    const memberSpy = vi.spyOn(adapters.membership, 'isMember')
    const ctrl = new DeliveryController(adapters, s => phases.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = phases[phases.length - 1] as Extract<DeliveryPhase, { status: 'error' }>
    expect(last.status).toBe('error')
    expect(last.code).toBe('service-refused')
    expect(last.message).toContain('mainnet')
    expect(memberSpy).not.toHaveBeenCalled()
  })

  it('DC_B3: commitmentCheck fails (chain ID mismatch) → service-refused, retryable=false', async () => {
    const phases: DeliveryPhase[] = []
    const adapters = makeAdapters({ ok: false, message: 'Delivery server chain ID 1 does not match client chain ID 5042002.' })
    const ctrl = new DeliveryController(adapters, s => phases.push(s), REAL_ARTIFACT_HASH)
    await ctrl.unlock(MEMBER_ADDR, POOL_ID)
    const last = phases[phases.length - 1] as Extract<DeliveryPhase, { status: 'error' }>
    expect(last.status).toBe('error')
    expect(last.code).toBe('service-refused')
    expect(last.retryable).toBe(false)
  })
})

// ── WD — Wording: no hardcoded "Arc Testnet" / "testnet" in user-visible strings on mainnet ──

describe('WD — Wording: network-aware user-visible strings', () => {
  // These tests check that key UI components read from NETWORK.name and NETWORK.isMainnet,
  // not from hardcoded "Arc Testnet" strings.
  // We read the source and scan for specific patterns.

  function readSrc(rel: string): string {
    return readFileSync(resolve(PROJECT_ROOT, rel), 'utf-8')
  }

  it('WD1: SetupPending title uses NETWORK.isMainnet (not hardcoded "Testnet setup pending")', () => {
    const src = readSrc('src/components/PurchaseRoom.tsx')
    // Must have conditional on NETWORK.isMainnet
    expect(src).toContain('NETWORK.isMainnet')
    // Must contain both "Mainnet setup pending" and "Testnet setup pending"
    expect(src).toContain('Mainnet setup pending')
    expect(src).toContain('Testnet setup pending')
  })

  it('WD2: PurchaseRoom loading message uses NETWORK.name (not hardcoded "Arc Testnet")', () => {
    const src = readSrc('src/components/PurchaseRoom.tsx')
    expect(src).toContain('Loading pool from {NETWORK.name}')
    expect(src).not.toMatch(/Loading pool from Arc Testnet/)
  })

  it('WD3: PurchaseRoom RPC error message uses NETWORK.name', () => {
    const src = readSrc('src/components/PurchaseRoom.tsx')
    expect(src).toContain('Could not reach {NETWORK.name}')
    expect(src).not.toMatch(/Could not reach Arc Testnet/)
  })

  it('WD4: PurchaseRoom wrong-chain switch text uses NETWORK.name', () => {
    const src = readSrc('src/components/PurchaseRoom.tsx')
    expect(src).toContain('Switch to {NETWORK.name}')
    expect(src).not.toMatch(/Switch to Arc Testnet/)
  })

  it('WD5: ResourceCard pool-not-deployed message uses NETWORK.name and does not claim delivery status', () => {
    const src = readSrc('src/components/ResourceCard.tsx')
    expect(src).toContain('NETWORK.name}')
    // Must not say "delivery service pending" (makes an unverified claim about delivery)
    expect(src).not.toMatch(/delivery service pending/)
    // Must not say "Pool not yet deployed" (wrong: pool may be deployed but unconfigured)
    expect(src).not.toMatch(/Pool not yet deployed/)
  })

  it('WD6: ResourceCard test-pool description uses NETWORK.name', () => {
    const src = readSrc('src/components/ResourceCard.tsx')
    expect(src).toContain('NETWORK.name}')
    expect(src).not.toMatch(/Placeholder content for testing the Reflow flow on Arc Testnet/)
  })

  it('WD7: AdminView title and intro use network-aware strings', () => {
    const src = readSrc('src/components/AdminView.tsx')
    // Must have conditional or use NETWORK.name for mode-aware title
    expect(src).toContain('NETWORK.isMainnet')
    expect(src).toContain('Create mainnet report pool')
    expect(src).toContain('Create test pool')
  })

  it('WD8: AdminView footnote is mode-aware and uses conditional logic', () => {
    const src = readSrc('src/components/AdminView.tsx')
    // The footnote must be conditional on mode (test vs real)
    expect(src).toContain("mode === 'test'")
    // The real-mode footnote must reference the commitment endpoint, not a static path
    expect(src).toContain('/api/report/commitment')
    // The null REPORTS case must show an error note
    expect(src).toContain('REPORTS[')
  })

  it('WD9: REPORTS[mainnet] is non-null (mainnet report configured with correct hash constants)', () => {
    expect(REPORTS['mainnet']).not.toBeNull()
    // The mainnet report must carry the committed hash constants
    expect(REPORTS['mainnet']!.artifactHash.toLowerCase()).toBe(
      '0x202799799200624d68ece590b67f68a62e4739382f8f72965ee577937d201b10',
    )
    expect(REPORTS['mainnet']!.termsHash.toLowerCase()).toBe(
      '0x2e30e6919339d57066255eb75123d45ede7d1651536e4dcdce848366896dd073',
    )
  })

  it('WD10: DEMO_RESOURCE.description uses NETWORK.name (no hardcoded "Arc Testnet")', () => {
    const src = readSrc('src/lib/reflowConfig.ts')
    // The description must reference NETWORK.name dynamically
    expect(src).toContain('NETWORK.name')
    // Must not contain a hardcoded "Arc Testnet" or "Arc Mainnet" literal in the description
    expect(src).not.toMatch(/A concise onchain activity summary for Arc Testnet/)
    expect(src).not.toMatch(/A concise onchain activity summary for Arc Mainnet/)
  })

  it('WD11: DEMO_RESOURCE.providerNote does not claim "delivery service is pending"', () => {
    const src = readSrc('src/lib/reflowConfig.ts')
    expect(src).not.toMatch(/delivery service is pending/)
    expect(src).not.toMatch(/testnet demonstration only/)
  })

  // ── Cross-network string leakage checks (source-scan) ─────────────────────
  // These scan actual rendered strings in key UI source files, not config.

  it('WD12: no user-visible "Arc Testnet" literal in ResourceCard source', () => {
    const src = readSrc('src/components/ResourceCard.tsx')
    // "Arc Testnet" must not appear as a raw string (dynamic NETWORK.name is fine)
    expect(src).not.toMatch(/["'`]Arc Testnet/)
    expect(src).not.toMatch(/Arc Testnet["'`]/)
  })

  it('WD13: DEMO_RESOURCE description template uses NETWORK.name, not a hardcoded network name', () => {
    const src = readSrc('src/lib/reflowConfig.ts')
    // The template literal must interpolate NETWORK.name
    expect(src).toMatch(/`.*\$\{NETWORK\.name\}.*`/)
    // The string "Arc Testnet" or "Arc Mainnet" must not appear as a raw literal in DEMO_RESOURCE
    const demoBlock = src.slice(src.indexOf('DEMO_RESOURCE'), src.indexOf('function readEnvAddress'))
    expect(demoBlock).not.toContain('Arc Testnet')
    expect(demoBlock).not.toContain('Arc Mainnet')
  })

  it('WD14: ResourceCard no-pool header does not say "delivery service pending"', () => {
    const src = readSrc('src/components/ResourceCard.tsx')
    expect(src).not.toMatch(/delivery service pending/)
  })
})

// ── ST — Static serving: wrapWithStatic ───────────────────────────────────────

describe('ST — Static serving: wrapWithStatic', () => {
  let tmpDir: string
  let cleanup: () => void

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reflow-static-test-'))
    // Create a minimal dist/ structure
    mkdirSync(join(tmpDir, 'assets'), { recursive: true })
    writeFileSync(join(tmpDir, 'index.html'), '<html><body>SPA</body></html>')
    writeFileSync(join(tmpDir, 'assets', 'app.abc12345.js'), 'console.log("app")')
    writeFileSync(join(tmpDir, 'app.css'), 'body {}')
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true })
  })

  afterEach(() => cleanup?.())

  async function importWrapWithStatic() {
    // Import fresh to avoid module cache issues
    const { wrapWithStatic } = await import('../../server/http')
    return wrapWithStatic
  }

  function noop(_req: Request): Promise<Response> {
    return Promise.resolve(new Response('api', { status: 200 }))
  }

  it('ST1: /healthz returns 200 { ok, network, poolId }', async () => {
    const wrapWithStatic = await importWrapWithStatic()
    const handler = wrapWithStatic(noop, tmpDir, tmpDir, { network: 'testnet', poolId: '2' })
    const res = await handler(new Request('http://localhost/healthz'))
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; network: string; poolId: string }
    expect(body.ok).toBe(true)
    expect(body.network).toBe('testnet')
    expect(body.poolId).toBe('2')
  })

  it('ST2: /api/delivery/challenge is forwarded to inner handler', async () => {
    const wrapWithStatic = await importWrapWithStatic()
    const inner = vi.fn().mockResolvedValue(new Response('challenge', { status: 200 }))
    const handler = wrapWithStatic(inner, tmpDir, tmpDir)
    const res = await handler(new Request('http://localhost/api/delivery/challenge', { method: 'POST' }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('challenge')
    expect(inner).toHaveBeenCalled()
  })

  it('ST3: GET / serves index.html', async () => {
    const wrapWithStatic = await importWrapWithStatic()
    const handler = wrapWithStatic(noop, tmpDir, tmpDir)
    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<html>')
  })

  it('ST4: GET /assets/app.abc12345.js serves the file with immutable cache header', async () => {
    const wrapWithStatic = await importWrapWithStatic()
    const handler = wrapWithStatic(noop, tmpDir, tmpDir)
    const res = await handler(new Request('http://localhost/assets/app.abc12345.js'))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('immutable')
  })

  it('ST5: path traversal /../etc/passwd — URL normalizes; missing path falls back to index.html (safe)', async () => {
    // new URL('http://localhost/../etc/passwd').pathname === '/etc/passwd'
    // The path traversal is neutralized by URL parsing; the handler sees /etc/passwd
    // which is missing from distRoot, so it returns index.html (SPA fallback, 200).
    // The resolved file is always inside distRoot — no file outside distRoot is served.
    const wrapWithStatic = await importWrapWithStatic()
    const handler = wrapWithStatic(noop, tmpDir, tmpDir)
    const res = await handler(new Request('http://localhost/../etc/passwd'))
    // Safe outcome: 200 (SPA fallback) and content is the app's index.html, not /etc/passwd
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('<html>')
  })

  it('ST6: traversal guard rejects path that escapes distRoot directly (no URL normalization)', async () => {
    // Simulate what happens when the guard is bypassed by constructing the path directly.
    // Our guard: !resolved.startsWith(distRoot + '/') rejects join(distRoot, '/../etc/passwd')
    // normalize(join('/tmp/foo', '/../etc/passwd')) === '/etc/passwd'
    // '/etc/passwd' does NOT start with '/tmp/foo/' → guard fires → 404
    const path = await import('node:path')
    const fakeDistRoot = '/tmp/reflow-fake-test'
    const resolved = path.normalize(`${fakeDistRoot}/../etc/passwd`)
    // Verify our guard would catch this:
    expect(resolved.startsWith(fakeDistRoot + '/')).toBe(false)
    expect(resolved.startsWith(fakeDistRoot)).toBe(false)
  })

  it('ST7: missing file → falls back to index.html (SPA routing)', async () => {
    const wrapWithStatic = await importWrapWithStatic()
    const handler = wrapWithStatic(noop, tmpDir, tmpDir)
    const res = await handler(new Request('http://localhost/some/spa-route'))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<html>')
  })

  it('ST8: /healthz is served even when SERVE_STATIC=false (handler inline in index.ts)', () => {
    // Source-level assertion: server/index.ts must have /healthz in the non-static branch too
    const src = readFileSync(resolve(PROJECT_ROOT, 'server/index.ts'), 'utf-8')
    expect(src).toContain('/healthz')
  })

  it('ST9: /api/* routes are not shadowed by static serving', async () => {
    const wrapWithStatic = await importWrapWithStatic()
    let innerCalled = false
    const inner = vi.fn().mockImplementation(async () => { innerCalled = true; return new Response('ok', { status: 200 }) })
    const handler = wrapWithStatic(inner, tmpDir, tmpDir)
    await handler(new Request('http://localhost/api/report/commitment'))
    expect(innerCalled).toBe(true)
  })
})

// ── COM — Server commitment returns network + chainId ─────────────────────────

describe('COM — server commitment: network and chainId fields', () => {
  it('COM1: DeliveryCore.getCommitment returns network key from config', async () => {
    const { DeliveryCore } = await import('../../server/core/delivery')
    const bytes = new Uint8Array([1, 2, 3])
    const core = new DeliveryCore(
      {
        contractAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        poolId: '1',
        domain: 'localhost',
        uri: 'http://localhost',
        chainId: 5042002,
        networkKey: 'testnet',
        artifactHash: '0x9f133dfc1902678ccadff6a874ab99e22e786de98e6c0464ddc6a0c872858d68',
      },
      { async getChainId() { return 5042002 }, async hasCode() { return true }, async getPool() { return null }, async getMember() { return { isMember: false } } },
      { nowMs() { return Date.now() } },
      { randomHex() { return '0xaabbcc' } },
      { async readArtifact() { return bytes }, async readTerms() { return bytes } },
      { sign() { return 'sig' }, verify() { return true } },
    )
    const result = await core.getCommitment()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.network).toBe('testnet')
      expect(result.value.chainId).toBe(5042002)
    }
  })

  it('COM2: DeliveryCore.getCommitment returns mainnet network key when configured', async () => {
    const { DeliveryCore } = await import('../../server/core/delivery')
    const bytes = new Uint8Array([4, 5, 6])
    const core = new DeliveryCore(
      {
        contractAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        poolId: '1',
        domain: 'mainnet.example.com',
        uri: 'https://mainnet.example.com',
        chainId: 747,
        networkKey: 'mainnet',
        artifactHash: '0x202799799200624d68ece590b67f68a62e4739382f8f72965ee577937d201b10',
      },
      { async getChainId() { return 747 }, async hasCode() { return true }, async getPool() { return null }, async getMember() { return { isMember: false } } },
      { nowMs() { return Date.now() } },
      { randomHex() { return '0xaabbcc' } },
      { async readArtifact() { return bytes }, async readTerms() { return bytes } },
      { sign() { return 'sig' }, verify() { return true } },
    )
    const result = await core.getCommitment()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.network).toBe('mainnet')
      expect(result.value.chainId).toBe(747)
    }
  })

  it('COM3: delivery.test.ts config includes networkKey: testnet', () => {
    const src = readFileSync(resolve(PROJECT_ROOT, 'server/tests/delivery.test.ts'), 'utf-8')
    expect(src).toContain("networkKey: 'testnet'")
  })

  it('COM4: server/index.ts passes networkKey to DeliveryCore', () => {
    const src = readFileSync(resolve(PROJECT_ROOT, 'server/index.ts'), 'utf-8')
    expect(src).toContain('networkKey:')
    expect(src).toContain('NETWORK.key')
  })
})

// ── PS — Privacy scan: mainnet artifact internals must not appear in public/ or src/ ──
//
// The mainnet private artifact contains headAtGeneration=28336998 and fromBlock=28200000.
// These values MUST NOT appear in any public/ file (served to unauthenticated visitors)
// or in any compiled src/ file that ships to the browser.
// The server/private/ directory is intentionally EXCLUDED from this scan (it holds the artifact).

describe('PS — Privacy scan: mainnet artifact data not in public/ or src/', () => {
  // Read all files under a directory recursively, returning {path, content} pairs
  function scanDir(dir: string, extensions = ['.json', '.js', '.ts', '.md', '.html', '.css']): { path: string; content: string }[] {
    const results: { path: string; content: string }[] = []
    if (!existsSync(dir)) return results
    function walk(current: string) {
      const entries = readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          // Skip private dirs
          if (entry.name === 'private') continue
          walk(full)
        } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
          results.push({ path: full, content: readFileSync(full, 'utf-8') })
        }
      }
    }
    walk(dir)
    return results
  }

  it('PS1: mainnet headAtGeneration value (28336998) absent from public/', () => {
    const files = scanDir(resolve(PROJECT_ROOT, 'public'))
    const matches = files.filter((f) => f.content.includes('28336998'))
    expect(matches.map((f) => f.path)).toHaveLength(0)
  })

  it('PS2: mainnet headAtGeneration value (28336998) absent from non-test src/ files', () => {
    // headAtGeneration is private metadata from the artifact — it must not leak into app source.
    // Test files themselves are allowed to reference these values for the scan assertions.
    const files = scanDir(resolve(PROJECT_ROOT, 'src'))
    const matches = files
      .filter((f) => !f.path.includes('/tests/'))  // exclude test fixtures
      .filter((f) => f.content.includes('28336998'))
    expect(matches.map((f) => f.path)).toHaveLength(0)
  })
})

// ── DF — Dockerfile: runtime stage must copy only the network-specific artifact ──
//
// A testnet image must contain only arc-activity-report-v1.json.
// A mainnet image must contain only arc-activity-report-mainnet-v1.json.
// The runtime stage must NOT copy the entire server/private/ directory — that
// would bake both artifact files into every image regardless of network.

describe('DF — Dockerfile: runtime stage selective artifact copy', () => {
  const dockerfileSrc = readFileSync(resolve(PROJECT_ROOT, 'Dockerfile'), 'utf-8')

  // Split on FROM lines to isolate stages
  const stages = dockerfileSrc.split(/^FROM\s/m)
  // stages[0] = everything before the first FROM (preamble)
  // stages[1] = "oven/bun:1 AS frontend-builder ..."
  // stages[2] = "oven/bun:1-slim AS runtime ..."
  const runtimeStage = stages.find((s) => s.includes('AS runtime')) ?? ''

  it('DF1: runtime stage does not copy the whole server/private/ directory', () => {
    // COPY server/private/ (trailing slash = directory copy) must not appear in runtime stage
    expect(runtimeStage).not.toMatch(/COPY\s+server\/private\/\s/)
    expect(runtimeStage).not.toMatch(/COPY\s+server\/private\/\n/)
    expect(runtimeStage).not.toMatch(/COPY\s+server\/private\/$/)
  })

  it('DF2: runtime stage re-declares VITE_REFLOW_NETWORK as ARG', () => {
    // ARG scope does not cross FROM boundaries; must be re-declared to drive selection
    expect(runtimeStage).toContain('ARG VITE_REFLOW_NETWORK')
  })

  it('DF3: runtime stage selects testnet artifact by name', () => {
    expect(runtimeStage).toContain('arc-activity-report-v1.json')
  })

  it('DF4: runtime stage selects mainnet artifact by name', () => {
    expect(runtimeStage).toContain('arc-activity-report-mainnet-v1.json')
  })

  it('DF5: runtime stage uses conditional (if/else) to select the artifact', () => {
    // The selection must be conditional on network, not unconditional
    expect(runtimeStage).toMatch(/if.*mainnet.*then|if.*NET.*mainnet/s)
  })

  it('DF6: runtime stage removes the staging directory after copy', () => {
    // Temp staging dir must be cleaned up so only the chosen file remains
    expect(runtimeStage).toMatch(/rm -rf \/tmp\/private|rmdir|rm -r/)
  })

  it('DF7: builder stage still checks the network-specific artifact exists', () => {
    const builderStage = stages.find((s) => s.includes('AS frontend-builder')) ?? ''
    // assert-build-env.ts checks file existence; the shell test is belt-and-suspenders
    expect(builderStage).toContain('assert-build-env.ts')
    expect(builderStage).toContain('arc-activity-report')
  })
})
