/**
 * Reflow delivery server entry point.
 * Reads configuration from environment variables only — never from client code.
 *
 * Required env:
 *   VITE_REFLOW_CONTRACT  — deployed contract address (same var as frontend uses)
 *   REFLOW_POOL_ID        — pool id to serve (required; NOT VITE_ — server only)
 *   PUBLIC_ORIGIN         — allowed CORS origin (default: http://localhost:5173)
 *
 * Optional env:
 *   REFLOW_NETWORK        — 'testnet' (default) | 'mainnet'; must match RPC chain id
 *   VITE_REFLOW_NETWORK   — fallback if REFLOW_NETWORK is absent (set one or both to
 *                           the same value; differing values are refused)
 *   RPC_URL               — override RPC endpoint (default: from resolveNetwork)
 *   RPC_PROXY_BASE_URL    — Circle RPC proxy base
 *   RPC_PROXY_TOKEN       — Circle RPC proxy auth token
 *   RPC_PROXY_CHAINS      — comma-separated list of proxy-covered chain keys
 *   HMAC_SECRET           — 32-byte hex secret; generated at startup if absent.
 *                           Tokens issued before a restart are invalidated on restart.
 *   DELIVERY_PORT         — HTTP port (default: 8791). Set this if 8791 is taken;
 *                           set the same value in .env so Vite's /api proxy follows.
 *   PORT                  — fallback port if DELIVERY_PORT is unset (legacy; default: 8791)
 *   DOMAIN                — EIP-4361 domain (default: localhost:5173)
 *   TRUSTED_PROXY         — set to "true" to honour X-Forwarded-For for rate limiting.
 *                           Only set this when behind a known trusted reverse proxy.
 *   SERVE_STATIC          — set to "true" to serve the built frontend (dist/) from
 *                           the same process. Path-traversal is blocked. The /api/*
 *                           routes always take priority. /healthz is always served
 *                           regardless of SERVE_STATIC.
 *
 * Run: bun run server/index.ts
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, keccak256 } from 'viem'
import {
  DeliveryCore,
  type ClockAdapter,
  type RandomAdapter,
  type FileAdapter,
  type HmacAdapter,
} from './core/delivery.js'
import { createHandler, makeProductionIpExtractor, wrapWithStatic } from './http.js'
import { makeChainAdapter } from './chainAdapter.js'
import { REPORTS } from '../src/lib/reportManifest.js'
import { DEFAULT_DELIVERY_PORT } from './serverPort.js'
import { validateServerConfig } from './validateConfig.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Phase 1: resolve + validate config (BEFORE any side-effects) ──────────────
//
// validateServerConfig is called synchronously with the env map.
// The RPC chain-id check needs an async eth_chainId call, so we first run the
// sync checks, then do the RPC check, then bind the port.

const syncResult = validateServerConfig({ env: process.env as Record<string, string | undefined>, rpcChainId: undefined })

if (syncResult.errors.length > 0) {
  for (const e of syncResult.errors) {
    console.error('[delivery] FATAL:', e)
  }
  process.exit(1)
}

const NETWORK = syncResult.network
console.log(`[delivery] Network: ${NETWORK.name} (chain id ${NETWORK.chainId})`)

// ── Phase 2: resolve runtime env vars ─────────────────────────────────────────

const CONTRACT = process.env['VITE_REFLOW_CONTRACT'] as `0x${string}`
const POOL_ID  = process.env['REFLOW_POOL_ID'] as string

const PUBLIC_ORIGIN = process.env['PUBLIC_ORIGIN'] ?? 'http://localhost:5173'
const DOMAIN        = process.env['DOMAIN'] ?? 'localhost:5173'
const PORT          = parseInt(
  process.env['DELIVERY_PORT'] ?? process.env['PORT'] ?? String(DEFAULT_DELIVERY_PORT),
  10,
)
const TRUSTED_PROXY = process.env['TRUSTED_PROXY'] === 'true'

// RPC: prefer Circle proxy if available for this chain, else fall back to registry
const proxyChains = (process.env['RPC_PROXY_CHAINS'] ?? '').split(',').map((s) => s.trim())
const rpcUrl: string =
  process.env['RPC_URL']
    ? process.env['RPC_URL']
    : process.env['RPC_PROXY_BASE_URL'] && proxyChains.includes(NETWORK.compassKey)
      ? `${process.env['RPC_PROXY_BASE_URL']}/api/rpc/${NETWORK.compassKey}?_rpc_token=${process.env['RPC_PROXY_TOKEN']}`
      : (() => {
          const url = NETWORK.rpcUrls[0]
          console.warn('[delivery] RPC proxy not configured; using public RPC — may rate-limit under load:', url)
          return url
        })()

// Generate HMAC secret at startup if not provided.
let hmacSecret: Buffer
if (process.env['HMAC_SECRET']) {
  hmacSecret = Buffer.from(process.env['HMAC_SECRET'], 'hex')
} else {
  hmacSecret = randomBytes(32)
  console.warn(
    '[delivery] HMAC_SECRET not set — generating ephemeral secret. Tokens will be invalidated on restart.',
  )
}

// ── Phase 3: adapters ─────────────────────────────────────────────────────────

const viemClient = createPublicClient({ transport: http(rpcUrl) })
const chainAdapter = makeChainAdapter(viemClient as unknown as import('./chainAdapter.js').ViemLike)

const clockAdapter:  ClockAdapter  = { nowMs: () => Date.now() }
const randomAdapter: RandomAdapter = { randomHex: () => '0x' + randomBytes(16).toString('hex') }

const PRIVATE_DIR = join(__dirname, 'private')
const PUBLIC_DIR  = join(__dirname, '..', 'public')

// Pick report files by active network.
// validateServerConfig already refused if REPORTS[network.key] would be null.
const reportConfigOrNull = REPORTS[NETWORK.key]
if (reportConfigOrNull === null) {
  console.error(`[delivery] FATAL: REPORTS["${NETWORK.key}"] is null — no report configured for this network.`)
  process.exit(1)
}
// After the exit(1) guard above, reportConfigOrNull is guaranteed non-null.
// TypeScript does not narrow through process.exit, so we assert here.
const reportConfig = reportConfigOrNull!

const artifactFileName  = reportConfig.artifactFilename
const termsFilePath     = join(PUBLIC_DIR, ...reportConfig.termsPath.split('/').filter(Boolean))

const fileAdapter: FileAdapter = {
  async readArtifact() {
    return new Uint8Array(readFileSync(join(PRIVATE_DIR, artifactFileName)))
  },
  async readTerms() {
    return new Uint8Array(readFileSync(termsFilePath))
  },
}

const hmacAdapter: HmacAdapter = {
  sign(payload) {
    return createHmac('sha256', hmacSecret).update(payload).digest('hex')
  },
  verify(payload, digest) {
    const expected = createHmac('sha256', hmacSecret).update(payload).digest('hex')
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(digest, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  },
}

// ── Phase 4: startup integrity check ─────────────────────────────────────────
// Verify the artifact hash matches the committed constant for this network BEFORE binding port.

const expectedArtifactHash = reportConfig.artifactHash
const artifactFilePath = join(PRIVATE_DIR, artifactFileName)
let artifactBytes: Buffer
try {
  artifactBytes = readFileSync(artifactFilePath)
} catch {
  console.error(`[delivery] FATAL: private artifact file not found: ${artifactFilePath}`)
  process.exit(1)
}
const liveHash = keccak256(new Uint8Array(artifactBytes))
if (liveHash.toLowerCase() !== expectedArtifactHash.toLowerCase()) {
  console.error(
    `[delivery] FATAL: private artifact hash mismatch for ${NETWORK.key}.\n` +
    `  Expected: ${expectedArtifactHash}\n` +
    `  Got:      ${liveHash}\n` +
    `  File:     ${artifactFilePath}`,
  )
  process.exit(1)
}
console.log(`[delivery] Artifact integrity OK (${NETWORK.key}):`, liveHash)

// ── Phase 5: async RPC chain-id check (BEFORE Bun.serve) ─────────────────────

async function startServer(): Promise<void> {
  // Re-run validateServerConfig with the live RPC chain id so the chain-id
  // check runs with all the same validation logic.
  let rpcChainId: number
  try {
    rpcChainId = Number(await viemClient.getChainId())
  } catch (e) {
    console.error('[delivery] FATAL: could not read chain id from RPC:', e)
    process.exit(1)
  }

  const rpcResult = validateServerConfig({
    env: process.env as Record<string, string | undefined>,
    rpcChainId,
  })

  // Only the chain-id error is new here; report any new errors.
  const newErrors = rpcResult.errors.filter(
    (err) => !syncResult.errors.includes(err),
  )
  if (newErrors.length > 0) {
    for (const e of newErrors) {
      console.error('[delivery] FATAL:', e)
    }
    process.exit(1)
  }

  console.log(`[delivery] Chain id check OK: RPC returned ${rpcChainId} (${NETWORK.name})`)

  // ── Phase 6: create core + HTTP handler, then bind port ──────────────────────

  const core = new DeliveryCore(
    {
      contractAddress: CONTRACT,
      poolId:          POOL_ID,
      domain:          DOMAIN,
      uri:             PUBLIC_ORIGIN,
      chainId:         NETWORK.chainId,
      networkKey:      NETWORK.key,
      artifactHash:    reportConfig.artifactHash,
    },
    chainAdapter,
    clockAdapter,
    randomAdapter,
    fileAdapter,
    hmacAdapter,
  )

  let bunServer: { requestIP: (req: Request) => { address: string } | null } | null = null
  const ipExtractor = makeProductionIpExtractor(TRUSTED_PROXY, (req) => bunServer?.requestIP(req) ?? null)
  const deliveryHandler = createHandler(core, PUBLIC_ORIGIN, ipExtractor)

  // SERVE_STATIC=true: serve built frontend from dist/ alongside the API.
  // The handler also provides /healthz.
  const SERVE_STATIC = process.env['SERVE_STATIC'] === 'true'
  const distRoot   = join(__dirname, '..', 'dist')
  const serverRoot = __dirname
  const healthzBody = JSON.stringify({ ok: true, network: NETWORK.key, poolId: POOL_ID })
  const handler = SERVE_STATIC
    ? wrapWithStatic(deliveryHandler, distRoot, serverRoot, { network: NETWORK.key, poolId: POOL_ID })
    : async (req: Request): Promise<Response> => {
        const url = new URL(req.url)
        if (url.pathname === '/healthz') {
          return new Response(healthzBody, {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          })
        }
        return deliveryHandler(req)
      }

  try {
    bunServer = Bun.serve({
      port: PORT,
      fetch: handler,
    })
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      console.error(
        `[delivery] FATAL: port ${PORT} is already in use.` +
        ` Set DELIVERY_PORT=<free-port> in .env to use a different port.`,
      )
      process.exit(1)
    }
    throw err
  }

  console.log(`[delivery] Server listening on :${PORT}`)
  console.log(`[delivery] Contract: ${CONTRACT}, Pool: ${POOL_ID}, Chain: ${NETWORK.chainId} (${NETWORK.name})`)
  console.log(`[delivery] CORS origin: ${PUBLIC_ORIGIN}`)
  console.log(`[delivery] TRUSTED_PROXY: ${TRUSTED_PROXY}`)
  if (SERVE_STATIC) {
    console.log(`[delivery] SERVE_STATIC=true — serving frontend from: ${distRoot}`)
  }
}

void startServer()
