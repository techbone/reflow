#!/usr/bin/env bun
/**
 * assert-build-env.ts
 *
 * Run by the Dockerfile BEFORE `bun run build` to catch misconfigured build
 * args early — before a broken SPA is baked into the image.
 *
 * Checks (fail-fast, one clear message per failure):
 *   1. VITE_REFLOW_NETWORK is valid ('testnet' | 'mainnet' | '').
 *   2. VITE_REFLOW_CONTRACT is set and looks like an address.
 *   3. REFLOW_POOL_ID (or VITE_REFLOW_POOL_ID) is set and is a positive integer.
 *   4. VITE_REFLOW_FROM_BLOCK is a non-negative integer when set.
 *   5. On mainnet: VITE_REFLOW_CONTRACT must not be a known testnet contract.
 *   6. Network-specific private artifact file must exist in server/private/.
 *
 * Exit 0 on success, exit 1 with a clear error message on failure.
 *
 * Importing from src/lib/ is safe here: these are pure TS modules with no
 * browser globals, Vite transforms, or circular deps. Bun runs them natively.
 */

import { resolveNetwork, assertNotKnownTestnetContract, KNOWN_TESTNET_CONTRACTS } from '../src/lib/network'
import { REPORTS } from '../src/lib/reportManifest'
import { existsSync } from 'node:fs'
import { join as pathJoin, dirname as pathDirname } from 'node:path'
import { fileURLToPath as pathFileURLToPath } from 'node:url'

function fail(msg: string): never {
  console.error(`\n[assert-build-env] FATAL: ${msg}\n`)
  process.exit(1)
}

function ok(msg: string): void {
  console.log(`[assert-build-env] OK: ${msg}`)
}

// ── Read env ──────────────────────────────────────────────────────────────────

const env = process.env as Record<string, string | undefined>

// ── Check 1: VITE_REFLOW_NETWORK is valid ─────────────────────────────────────

let network: ReturnType<typeof resolveNetwork>
try {
  // resolveNetwork throws on invalid values; we pass process.env directly.
  // It reads REFLOW_NETWORK (server) then VITE_REFLOW_NETWORK (client).
  // In a Docker build context only VITE_ vars are set as ARGs.
  network = resolveNetwork(env)
  ok(`network = "${network.key}" (${network.name})`)
} catch (e) {
  fail(String(e instanceof Error ? e.message : e))
}

// ── Check 2: VITE_REFLOW_CONTRACT ─────────────────────────────────────────────

const contract = (env['VITE_REFLOW_CONTRACT'] ?? '').trim()
if (!contract) {
  fail('VITE_REFLOW_CONTRACT is not set. Pass it as --build-arg VITE_REFLOW_CONTRACT=0x...')
}
if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
  fail(`VITE_REFLOW_CONTRACT="${contract}" is not a valid 0x-prefixed Ethereum address.`)
}
ok(`VITE_REFLOW_CONTRACT = ${contract}`)

// ── Check 3: REFLOW_POOL_ID / VITE_REFLOW_POOL_ID ────────────────────────────

const poolId = (env['REFLOW_POOL_ID'] ?? env['VITE_REFLOW_POOL_ID'] ?? '').trim()
if (!poolId) {
  fail(
    'REFLOW_POOL_ID (server) or VITE_REFLOW_POOL_ID (client) is not set. ' +
    'Pass it as --build-arg VITE_REFLOW_POOL_ID=<id> and set REFLOW_POOL_ID as a Fly secret.',
  )
}
const poolIdNum = parseInt(poolId, 10)
if (!Number.isInteger(poolIdNum) || poolIdNum <= 0 || String(poolIdNum) !== poolId) {
  fail(`Pool ID "${poolId}" is not a valid positive integer.`)
}
ok(`pool id = ${poolIdNum}`)

// ── Check 4: VITE_REFLOW_FROM_BLOCK (optional, but must be a number if set) ───

const fromBlock = (env['VITE_REFLOW_FROM_BLOCK'] ?? '').trim()
if (fromBlock !== '') {
  const n = parseInt(fromBlock, 10)
  if (!Number.isInteger(n) || n < 0 || String(n) !== fromBlock) {
    fail(`VITE_REFLOW_FROM_BLOCK="${fromBlock}" is not a valid non-negative integer.`)
  }
  ok(`VITE_REFLOW_FROM_BLOCK = ${n}`)
} else {
  ok('VITE_REFLOW_FROM_BLOCK not set (optional — indexer will scan from chain head)')
}

// ── Check 5: mainnet must not use a known testnet contract ────────────────────

if (network.isMainnet) {
  try {
    assertNotKnownTestnetContract(contract, network)
    ok('Contract is not a known testnet-only address — mainnet deploy OK')
  } catch (e) {
    fail(String(e instanceof Error ? e.message : e))
  }
} else {
  // Testnet: warn if the contract is NOT in the known set (unusual but not fatal)
  const isKnown = KNOWN_TESTNET_CONTRACTS.has(contract.toLowerCase())
  if (!isKnown) {
    console.warn(
      `[assert-build-env] WARN: VITE_REFLOW_CONTRACT=${contract} is not a recognised ` +
      `testnet address. Proceeding — if this is intentional, ignore this warning.`,
    )
  } else {
    ok('VITE_REFLOW_CONTRACT is the known testnet deployment')
  }
}

// ── Check 6: network-specific private artifact file must be present ──────────
// Testnet builds require arc-activity-report-v1.json.
// Mainnet builds require arc-activity-report-mainnet-v1.json.
// A mainnet build must NOT silently use the testnet artifact (and vice versa).

const __dirname6 = pathDirname(pathFileURLToPath(import.meta.url))
const projectRoot = pathJoin(__dirname6, '..')
const report = REPORTS[network.key]

if (report === null) {
  fail(
    `VITE_REFLOW_NETWORK=${network.key} but REPORTS["${network.key}"] is null in src/lib/reportManifest.ts. ` +
    `Publish the ${network.key} report, fill in REPORTS["${network.key}"], then rebuild.`,
  )
}

// Non-null assertion safe: we just failed if report is null.
const expectedArtifactFile = (report).artifactFilename
const artifactPath = pathJoin(projectRoot, 'server', 'private', expectedArtifactFile)

if (!existsSync(artifactPath)) {
  fail(
    `Private artifact file not found: server/private/${expectedArtifactFile}\n` +
    `  This file is required for a ${network.key} build and must be present in your local working directory.\n` +
    `  It is gitignored; obtain it from the secure file store and place it at the path above.`,
  )
}
ok(`Private artifact file present: server/private/${expectedArtifactFile}`)

console.log('\n[assert-build-env] All checks passed.\n')
