/**
 * Committed hashes for the report delivery service.
 * These are the keccak256 values of the exact bytes of the committed files.
 * The server checks that the live private file's hash matches at startup.
 * The on-chain pool must have matching artifactHash and termsHash for delivery.
 *
 * Per-network constants are in REPORTS (src/lib/reportManifest.ts).
 * These server-side constants mirror them for use in server-only code.
 */

// Chain IDs — re-exported for server code and server tests.
export { ARC_TESTNET_CHAIN_ID, ARC_MAINNET_CHAIN_ID } from '../src/lib/network.js'

/** keccak256 of server/private/arc-activity-report-v1.json — testnet report */
export const ARTIFACT_HASH =
  '0x9f133dfc1902678ccadff6a874ab99e22e786de98e6c0464ddc6a0c872858d68' as `0x${string}`

/** keccak256 of public/report-v1/terms.md — testnet report */
export const TERMS_HASH =
  '0xcc64d34b5c37803e0c410295d41c5bf83139701d5bb256b8900bcb0c3d146b50' as `0x${string}`

/** keccak256 of server/private/arc-activity-report-mainnet-v1.json — mainnet report */
export const MAINNET_ARTIFACT_HASH =
  '0x202799799200624d68ece590b67f68a62e4739382f8f72965ee577937d201b10' as `0x${string}`

/** keccak256 of public/report-mainnet-v1/terms.md — mainnet report */
export const MAINNET_TERMS_HASH =
  '0x2e30e6919339d57066255eb75123d45ede7d1651536e4dcdce848366896dd073' as `0x${string}`

/**
 * ReflowPools ABI — the canonical source of truth.
 * Re-exported from the shared frontend module so the server decodes
 * by field name, not by positional index.
 */
export { REFLOW_POOLS_ABI } from '../src/lib/reflowAbi.js'
