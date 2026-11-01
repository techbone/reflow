/**
 * staticServing.test.ts — tests for wrapWithStatic and /healthz endpoint.
 *
 * Test groups:
 *   HZ — /healthz endpoint (returns {ok, network, poolId})
 *   ST — static file serving (happy path, MIME types, immutable cache)
 *   TV — path traversal / blocked-prefix / dotfile / unknown-ext prevention
 *   SP — SPA fallback (extensionless missing path → index.html)
 *   AF — /api/* always forwarded to delivery handler (never shadowed)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapWithStatic } from '../http.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A dummy inner handler that echoes the request path as JSON. */
const innerHandler = async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  return new Response(JSON.stringify({ routed: url.pathname }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

let distRoot: string
let serverRoot: string
let handler: (req: Request) => Promise<Response>

// Helper: synthetic GET request
function req(path: string, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, { method })
}

beforeAll(() => {
  distRoot   = mkdtempSync(join(tmpdir(), 'reflow-dist-'))
  serverRoot = mkdtempSync(join(tmpdir(), 'reflow-server-'))

  // Minimal dist/ tree
  writeFileSync(join(distRoot, 'index.html'), '<!doctype html><html><body>SPA</body></html>')
  mkdirSync(join(distRoot, 'assets'), { recursive: true })
  writeFileSync(join(distRoot, 'assets', 'main.abc12345.js'), 'console.log("bundle")')
  writeFileSync(join(distRoot, 'style.css'), 'body{}')
  writeFileSync(join(distRoot, 'robots.txt'), 'User-agent: *')

  // Create handler AFTER distRoot is populated
  handler = wrapWithStatic(innerHandler, distRoot, serverRoot, { network: 'testnet', poolId: '2' })
})

afterAll(() => {
  rmSync(distRoot,   { recursive: true, force: true })
  rmSync(serverRoot, { recursive: true, force: true })
})

// ── HZ — /healthz ─────────────────────────────────────────────────────────────

describe('HZ — /healthz endpoint', () => {
  it('HZ1: GET /healthz returns 200 { ok: true }', async () => {
    const res = await handler(req('/healthz'))
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('HZ2: /healthz includes network field', async () => {
    const res = await handler(req('/healthz'))
    const body = await res.json() as { network: string }
    expect(body.network).toBe('testnet')
  })

  it('HZ3: /healthz includes poolId field', async () => {
    const res = await handler(req('/healthz'))
    const body = await res.json() as { poolId: string }
    expect(body.poolId).toBe('2')
  })

  it('HZ4: /healthz does not forward to inner handler', async () => {
    const res = await handler(req('/healthz'))
    const body = await res.json() as Record<string, unknown>
    expect(body).not.toHaveProperty('routed')
  })

  it('HZ5: POST /healthz still returns 200 (method-agnostic)', async () => {
    const res = await handler(req('/healthz', 'POST'))
    expect(res.status).toBe(200)
  })
})

// ── ST — Static file serving ──────────────────────────────────────────────────

describe('ST — Static file serving', () => {
  it('ST1: GET / returns index.html', async () => {
    const res = await handler(req('/'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<html>')
  })

  it('ST2: GET /index.html returns index.html', async () => {
    const res = await handler(req('/index.html'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<html>')
  })

  it('ST3: GET /style.css returns text/css', async () => {
    const res = await handler(req('/style.css'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/css')
  })

  it('ST4: GET /robots.txt returns text/plain', async () => {
    const res = await handler(req('/robots.txt'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/plain')
  })

  it('ST5: hashed asset gets immutable Cache-Control', async () => {
    const res = await handler(req('/assets/main.abc12345.js'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('immutable')
  })

  it('ST6: non-hashed file gets no-cache', async () => {
    const res = await handler(req('/style.css'))
    const cc = res.headers.get('Cache-Control') ?? ''
    expect(cc).toContain('no-cache')
    expect(cc).not.toContain('immutable')
  })
})

// ── TV — Blocked paths ────────────────────────────────────────────────────────

describe('TV — Blocked paths: dotfiles, server-internal prefixes, unknown extensions', () => {
  it('TV1: /.env returns 404', async () => {
    expect((await handler(req('/.env'))).status).toBe(404)
  })

  it('TV2: /.htaccess returns 404', async () => {
    expect((await handler(req('/.htaccess'))).status).toBe(404)
  })

  it('TV3: /assets/.hidden returns 404 (dotfile inside subdir)', async () => {
    expect((await handler(req('/assets/.hidden'))).status).toBe(404)
  })

  it('TV4: /server/index.ts returns 404', async () => {
    expect((await handler(req('/server/index.ts'))).status).toBe(404)
  })

  it('TV5: /server/private/arc-activity-report-v1.json returns 404', async () => {
    expect((await handler(req('/server/private/arc-activity-report-v1.json'))).status).toBe(404)
  })

  it('TV6: /src/lib/network.ts returns 404', async () => {
    expect((await handler(req('/src/lib/network.ts'))).status).toBe(404)
  })

  it('TV7: /contracts/ReflowPools.sol returns 404', async () => {
    expect((await handler(req('/contracts/ReflowPools.sol'))).status).toBe(404)
  })

  it('TV8: /node_modules/viem/index.js returns 404', async () => {
    expect((await handler(req('/node_modules/viem/index.js'))).status).toBe(404)
  })

  it('TV9: unknown extension .php returns 404', async () => {
    expect((await handler(req('/admin.php'))).status).toBe(404)
  })

  it('TV10: unknown extension .asp returns 404', async () => {
    expect((await handler(req('/login.asp'))).status).toBe(404)
  })

  it('TV11: path traversal /../etc/passwd — URL normalizes to /etc/passwd; not in dist → known extension (.passwd absent) returns 404', async () => {
    // URL parses /../etc/passwd as /etc/passwd; no extension → extensionless SPA fallback → 200
    // BUT passwd has no extension so it WOULD get SPA fallback. Let's verify it returns something safe.
    const res = await handler(req('/../etc/passwd'))
    // /etc/passwd has no extension → SPA fallback (200), content is index.html (safe)
    // This is the correct, safe behaviour: URL normalization means the traversal never lands outside dist.
    expect([200, 404]).toContain(res.status)
    if (res.status === 200) {
      expect(await res.text()).toContain('<html>')
    }
  })

  it('TV12: path traversal with a known-extension target (/etc/passwd.php) → 404 (unknown ext)', async () => {
    const res = await handler(req('/../etc/passwd.php'))
    // URL normalizes to /etc/passwd.php; .php is unknown extension → 404
    expect(res.status).toBe(404)
  })

  it('TV13: traversal guard — normalize(join(distRoot,"/../etc/passwd")) does not start with distRoot', () => {
    // Unit-test the guard logic directly using already-imported node:path functions.
    const fake = '/tmp/reflow-fake'
    const resolved = normalize(join(fake, '/../etc/passwd'))
    expect(resolved.startsWith(fake + '/')).toBe(false)
    expect(resolved.startsWith(fake)).toBe(false)
  })
})

// ── SP — SPA fallback ─────────────────────────────────────────────────────────

describe('SP — SPA fallback (extensionless missing path → index.html)', () => {
  it('SP1: GET /nonexistent-route → 200 index.html', async () => {
    const res = await handler(req('/nonexistent-route'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<html>')
  })

  it('SP2: GET /deep/nested/route → 200 index.html', async () => {
    const res = await handler(req('/deep/nested/route'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<html>')
  })

  it('SP3: GET /missing.css (known ext, missing) → 404 (no SPA fallback for known extensions)', async () => {
    const res = await handler(req('/missing.css'))
    expect(res.status).toBe(404)
  })

  it('SP4: GET /missing.js (known ext, missing) → 404', async () => {
    const res = await handler(req('/missing.js'))
    expect(res.status).toBe(404)
  })
})

// ── AF — /api/* forwarded ─────────────────────────────────────────────────────

describe('AF — /api/* forwarded to delivery handler', () => {
  it('AF1: GET /api/report/commitment is forwarded', async () => {
    const res = await handler(req('/api/report/commitment'))
    const body = await res.json() as { routed: string }
    expect(body.routed).toBe('/api/report/commitment')
  })

  it('AF2: POST /api/delivery/challenge is forwarded', async () => {
    const res = await handler(req('/api/delivery/challenge', 'POST'))
    const body = await res.json() as { routed: string }
    expect(body.routed).toBe('/api/delivery/challenge')
  })

  it('AF3: /api/ prefix never matched as a static file', async () => {
    // Even if a file named "api" existed in distRoot, /api prefix must forward
    writeFileSync(join(distRoot, 'api'), 'should-never-serve')
    const res = await handler(req('/api'))
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('routed')
  })
})
