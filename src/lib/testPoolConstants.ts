/**
 * Test pool constants for the Reflow Arc Testnet demonstration.
 *
 * These hashes are keccak256 of the exact byte content of the committed
 * placeholder files in public/test-pool/. The unit test in
 * src/tests/adminPool.test.ts re-hashes those files and asserts they match.
 *
 * createPool arguments for the test pool:
 *   price        = TEST_POOL_PRICE       (1.20 USDC in 6-decimal units)
 *   artifactHash = TEST_POOL_ARTIFACT_HASH
 *   termsHash    = TEST_POOL_TERMS_HASH
 *   deadline     = now + TEST_POOL_DEADLINE_SECS
 *   cap          = TEST_POOL_CAP
 */

import { keccak256 } from 'viem'

// ── Committed file paths (relative to the app's public root) ──────────────────
export const TEST_POOL_ARTIFACT_PATH = '/test-pool/artifact.txt'
export const TEST_POOL_TERMS_PATH    = '/test-pool/terms.txt'

// ── Expected hashes (keccak256 of the exact raw bytes of each committed file) ──
// Re-derived at build time by the unit test; do not edit without re-running tests.
export const TEST_POOL_ARTIFACT_HASH =
  '0xb49f6ced8268a6d5af62366fcedff510607e0bf7c148e88841bdfd54382fd190' as `0x${string}`

export const TEST_POOL_TERMS_HASH =
  '0x43c39dd1b020ecb217ed1e2ee99a702706b3eb5d346f06252abae7d01c52150c' as `0x${string}`

// ── Pool parameters ────────────────────────────────────────────────────────────
/** 1.20 USDC (6-decimal units) */
export const TEST_POOL_PRICE = 1_200_000n

/** Max members (same as the illustrative example in the UI) */
export const TEST_POOL_CAP = 4

/** Lifetime in seconds: 30 days */
export const TEST_POOL_DEADLINE_SECS = 30 * 24 * 60 * 60

// ── Hash utilities ─────────────────────────────────────────────────────────────

/**
 * Hash raw bytes the same way the contract expects: keccak256 of the file bytes.
 * viem's keccak256 accepts a Uint8Array directly.
 *
 * @param bytes - Raw bytes of the file (Uint8Array or Buffer).
 */
export function hashFileBytes(bytes: Uint8Array): `0x${string}` {
  return keccak256(bytes)
}

/**
 * Fetch both test-pool files and return their keccak256 hashes.
 * Used at create-time to verify the committed files match the constants
 * before broadcasting the transaction.
 *
 * @throws if either fetch fails or either hash mismatches the constants.
 */
export async function computeAndVerifyTestHashes(): Promise<{
  artifactHash: `0x${string}`
  termsHash: `0x${string}`
}> {
  const [artifactRes, termsRes] = await Promise.all([
    fetch(TEST_POOL_ARTIFACT_PATH),
    fetch(TEST_POOL_TERMS_PATH),
  ])

  if (!artifactRes.ok) {
    throw new Error(`Failed to fetch artifact file: ${artifactRes.status} ${artifactRes.statusText}`)
  }
  if (!termsRes.ok) {
    throw new Error(`Failed to fetch terms file: ${termsRes.status} ${termsRes.statusText}`)
  }

  const [artifactBuf, termsBuf] = await Promise.all([
    artifactRes.arrayBuffer(),
    termsRes.arrayBuffer(),
  ])

  const artifactHash = hashFileBytes(new Uint8Array(artifactBuf))
  const termsHash    = hashFileBytes(new Uint8Array(termsBuf))

  if (artifactHash.toLowerCase() !== TEST_POOL_ARTIFACT_HASH.toLowerCase()) {
    throw new Error(
      `Artifact hash mismatch.\n` +
      `  Expected: ${TEST_POOL_ARTIFACT_HASH}\n` +
      `  Got:      ${artifactHash}\n` +
      `The committed file does not match the constant. Do not proceed.`,
    )
  }
  if (termsHash.toLowerCase() !== TEST_POOL_TERMS_HASH.toLowerCase()) {
    throw new Error(
      `Terms hash mismatch.\n` +
      `  Expected: ${TEST_POOL_TERMS_HASH}\n` +
      `  Got:      ${termsHash}\n` +
      `The committed file does not match the constant. Do not proceed.`,
    )
  }

  return { artifactHash, termsHash }
}
