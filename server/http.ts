/**
 * Thin Bun HTTP wrapper around DeliveryCore.
 *
 * Rate limiting uses the socket peer address (requestIP) as the key by default.
 * X-Forwarded-For is only trusted when TRUSTED_PROXY=true is set in env.
 * The ipExtractor function is injected at construction time so tests can
 * supply deterministic IPs without depending on real socket state.
 *
 * No signatures, tokens or secrets are logged.
 *
 * Static file serving (SERVE_STATIC=true):
 *   When enabled via wrapWithStatic(), the handler also serves GET requests
 *   against a configured dist/ directory.  Path-traversal is blocked by
 *   resolving the requested path against the dist root and rejecting any
 *   result that does not start with the root (e.g. /../etc/passwd).
 *   /api/* routes are never shadowed.
 *   Directories and missing files fall back to index.html for SPA routing.
 *   Server-side private/ content is never accessible through this handler.
 */

import { existsSync, statSync, readFileSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import type { DeliveryCore } from './core/delivery.js'

const BODY_SIZE_LIMIT = 4096 // bytes

// Per-IP rate limits (sliding window)
const CHALLENGE_LIMIT = 10  // per IP per window
const SESSION_LIMIT = 5     // per IP per window
const RATE_WINDOW_MS = 60_000

interface RateEntry { count: number; windowStart: number }

export class RateLimiter {
  private readonly challengeRates = new Map<string, RateEntry>()
  private readonly sessionRates = new Map<string, RateEntry>()

  check(kind: 'challenge' | 'session', key: string, nowMs: number): boolean {
    const map = kind === 'challenge' ? this.challengeRates : this.sessionRates
    const limit = kind === 'challenge' ? CHALLENGE_LIMIT : SESSION_LIMIT
    // Prune stale entries before checking
    this._prune(map, nowMs)
    const entry = map.get(key)
    if (!entry || nowMs - entry.windowStart > RATE_WINDOW_MS) {
      map.set(key, { count: 1, windowStart: nowMs })
      return true
    }
    if (entry.count >= limit) return false
    entry.count++
    return true
  }

  private _prune(map: Map<string, RateEntry>, nowMs: number): void {
    for (const [key, entry] of map) {
      if (nowMs - entry.windowStart > RATE_WINDOW_MS) {
        map.delete(key)
      }
    }
  }
}

function json(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  }
}

/**
 * Create the HTTP handler.
 *
 * @param core         The DeliveryCore instance.
 * @param publicOrigin Allowed CORS origin.
 * @param ipExtractor  Function that returns a rate-limiting key for the request.
 *                     In production this is `(req) => socketIp ?? xForwardedFor ?? 'unknown'`.
 *                     In tests this returns a synthetic IP string.
 */
export function createHandler(
  core: DeliveryCore,
  publicOrigin: string,
  ipExtractor: (req: Request) => string,
) {
  const limiter = new RateLimiter()

  return async function handler(req: Request): Promise<Response> {
    const cors = corsHeaders(publicOrigin)
    const url = new URL(req.url)
    const ip = ipExtractor(req)
    const nowMs = Date.now()

    // Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    // ── GET /api/report/commitment ──────────────────────────────────────
    if (url.pathname === '/api/report/commitment' && req.method === 'GET') {
      const result = await core.getCommitment()
      if (!result.ok) return json(result.error.code, { error: 'Service error' }, cors)
      return json(200, result.value, cors)
    }

    // ── POST /api/delivery/challenge ────────────────────────────────────
    if (url.pathname === '/api/delivery/challenge' && req.method === 'POST') {
      if (!limiter.check('challenge', ip, nowMs)) {
        return json(429, { error: 'Rate limit exceeded' }, cors)
      }
      const body = await readBody(req)
      if (body === null) return json(413, { error: 'Request too large' }, cors)
      let parsed: { address?: unknown; poolId?: unknown }
      try { parsed = JSON.parse(body) } catch { return json(400, { error: 'Invalid JSON' }, cors) }
      if (typeof parsed.address !== 'string' || typeof parsed.poolId !== 'string') {
        return json(400, { error: 'Missing address or poolId' }, cors)
      }
      const result = core.challenge(parsed.address, parsed.poolId)
      if (!result.ok) return json(result.error.code, { error: result.error.reason }, cors)
      return json(200, result.value, cors)
    }

    // ── POST /api/delivery/session ──────────────────────────────────────
    if (url.pathname === '/api/delivery/session' && req.method === 'POST') {
      if (!limiter.check('session', ip, nowMs)) {
        return json(429, { error: 'Rate limit exceeded' }, cors)
      }
      const body = await readBody(req)
      if (body === null) return json(413, { error: 'Request too large' }, cors)
      let parsed: { address?: unknown; poolId?: unknown; message?: unknown; signature?: unknown }
      try { parsed = JSON.parse(body) } catch { return json(400, { error: 'Invalid JSON' }, cors) }
      if (
        typeof parsed.address !== 'string' ||
        typeof parsed.poolId !== 'string' ||
        typeof parsed.message !== 'string' ||
        typeof parsed.signature !== 'string'
      ) {
        return json(400, { error: 'Missing required fields' }, cors)
      }
      const result = await core.session(parsed.address, parsed.poolId, parsed.message, parsed.signature)
      if (!result.ok) return json(result.error.code, { error: result.error.reason }, cors)
      return json(200, result.value, cors)
    }

    // ── GET /api/delivery/file ──────────────────────────────────────────
    if (url.pathname === '/api/delivery/file' && req.method === 'GET') {
      const authHeader = req.headers.get('authorization')
      const result = await core.deliverFile(authHeader)
      if (!result.ok) return json(result.error.code, { error: result.error.reason }, cors)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new Response(result.value.bytes as any, {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="arc-activity-report-v1.json"',
          'Cache-Control': 'private, no-store',
          'X-Artifact-Keccak256': result.value.artifactHash,
        },
      })
    }

    return json(404, { error: 'Not found' }, cors)
  }
}

async function readBody(req: Request): Promise<string | null> {
  try {
    const reader = req.body?.getReader()
    if (!reader) return ''
    let total = 0
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > BODY_SIZE_LIMIT) { reader.cancel(); return null }
      chunks.push(value)
    }
    return new TextDecoder().decode(
      chunks.reduce((a, b) => {
        const c = new Uint8Array(a.length + b.length)
        c.set(a)
        c.set(b, a.length)
        return c
      }, new Uint8Array(0))
    )
  } catch {
    return null
  }
}

// ── MIME types for static serving ─────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/plain; charset=utf-8',
}

// ── Paths that must never fall through to the SPA fallback ───────────────────

/** Path prefixes that are 404 even when the file doesn't exist in dist. */
const BLOCKED_PREFIXES = ['/server', '/src', '/contracts', '/node_modules', '/scripts']

/** Returns true when the path segment (the last component) starts with a dot. */
function isDotfile(pathname: string): boolean {
  const parts = pathname.split('/')
  const last = parts[parts.length - 1] ?? ''
  return last.startsWith('.')
}

/**
 * Return true when the path has a file extension that is NOT in the MIME table.
 * Extensionless paths (SPA routes) and known extensions are allowed through.
 */
function isUnknownExtension(pathname: string): boolean {
  const ext = extname(pathname)
  if (!ext) return false          // extensionless → SPA route, allow
  return !(ext in MIME)           // unknown extension → block
}

/**
 * Wrap a delivery handler so that:
 *  - GET /healthz returns 200 { ok, network, poolId } immediately.
 *  - GET /api/* is forwarded to the delivery handler unchanged.
 *  - Dotfiles (.env, .git, …) return 404.
 *  - Paths starting /server, /src, /contracts, /node_modules, /scripts return 404.
 *  - Paths with an unknown file extension (not in MIME table) return 404.
 *  - Path traversal is blocked by resolving against `distRoot` and prefix-checking.
 *  - Known static assets are served from `distRoot`.
 *  - Extensionless paths that are missing from dist fall back to index.html (SPA).
 *
 * @param inner      The delivery handler returned by createHandler().
 * @param distRoot   Absolute path to the built frontend (e.g. /app/dist).
 * @param _serverRoot Reserved (unused — the guard is path-prefix-based, not dir-check).
 * @param meta       Optional metadata included in /healthz response.
 */
export function wrapWithStatic(
  inner: (req: Request) => Promise<Response>,
  distRoot: string,
  _serverRoot: string,
  meta: { network?: string; poolId?: string } = {},
): (req: Request) => Promise<Response> {
  return async function staticHandler(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const { pathname } = url

    // /healthz — always first, method-agnostic
    if (pathname === '/healthz') {
      return new Response(
        JSON.stringify({ ok: true, network: meta.network ?? 'unknown', poolId: meta.poolId ?? 'unknown' }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
      )
    }

    // /api/* — forward to delivery handler unchanged
    if (pathname.startsWith('/api')) {
      return inner(req)
    }

    // Static: only GET / HEAD (pass everything else to the inner handler for a proper 404)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return inner(req)
    }

    // ── Security / sanity guards — all return 404 ─────────────────────────────

    // Dotfiles: .env, .git, .htaccess, …
    if (isDotfile(pathname)) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Server-internal path prefixes
    for (const prefix of BLOCKED_PREFIXES) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // Unknown file extensions (a .php or .asp probe should not get index.html)
    if (isUnknownExtension(pathname)) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }

    // ── Resolve against distRoot ──────────────────────────────────────────────

    const relPath = pathname === '/' ? '/index.html' : pathname
    const resolved = normalize(join(distRoot, relPath))

    // Path traversal guard (defence-in-depth: URL parsing already collapses ..,
    // but we check the resolved path never escapes distRoot)
    if (!resolved.startsWith(distRoot + '/') && resolved !== distRoot) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }

    let filePath = resolved
    let isFile: boolean
    try {
      isFile = existsSync(filePath) && statSync(filePath).isFile()
    } catch {
      isFile = false
    }

    // SPA fallback: extensionless paths missing from dist → index.html
    if (!isFile) {
      // Only extensionless paths get the SPA fallback; known-extension misses are 404
      if (extname(pathname)) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        })
      }
      filePath = join(distRoot, 'index.html')
      if (!existsSync(filePath)) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    let bytes: Buffer
    try {
      bytes = readFileSync(filePath)
    } catch {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }

    const ext = extname(filePath)
    const mime = MIME[ext] ?? 'application/octet-stream'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Response(bytes as any, {
      status: 200,
      headers: {
        'Content-Type': mime,
        // Long-lived cache for content-hashed assets; everything else must revalidate
        'Cache-Control': /\.[0-9a-f]{8,}\./.test(relPath)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      },
    })
  }
}

/**
 * Build the production IP extractor.
 *
 * Uses Bun's socket peer address (requestIP) as the canonical key.
 * Falls back to X-Forwarded-For ONLY when trustedProxy is true
 * (i.e. TRUSTED_PROXY=true env var is set), which should only be set
 * when the server is behind a trusted reverse proxy that sets this header.
 *
 * @param trustedProxy  Set to true only when behind a known trusted proxy.
 * @param requestIP     Bun's server.requestIP(req) call, passed as a closure.
 */
export function makeProductionIpExtractor(
  trustedProxy: boolean,
  requestIP: (req: Request) => { address: string } | null,
): (req: Request) => string {
  return (req: Request): string => {
    // Always prefer the socket address unless behind a trusted proxy
    if (!trustedProxy) {
      const peer = requestIP(req)
      if (peer?.address) return peer.address
      // Fallback only when requestIP is unavailable (e.g. non-Bun environments)
      return 'unknown'
    }
    // Trusted proxy mode: honour X-Forwarded-For (first entry is the real client)
    const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) return forwarded
    const peer = requestIP(req)
    if (peer?.address) return peer.address
    return 'unknown'
  }
}
