/**
 * reportManifest.ts — per-network report constants and classification helpers.
 *
 * REPORTS maps each network key to its report config (or null when not yet published).
 * selectTerms and classifyArtifact accept a NetworkKey so the same functions work
 * for both testnet and mainnet, and refuse testnet hashes on mainnet.
 */

import { keccak256 } from 'viem'
import type { NetworkKey } from './network'

// ── Testnet report (current) ──────────────────────────────────────────────────

/** keccak256 of the private delivery artifact file (arc-activity-report-v1.json) */
export const REAL_ARTIFACT_HASH =
  '0x9f133dfc1902678ccadff6a874ab99e22e786de98e6c0464ddc6a0c872858d68' as const

/** keccak256 of public/report-v1/terms.md */
export const REAL_TERMS_HASH =
  '0xcc64d34b5c37803e0c410295d41c5bf83139701d5bb256b8900bcb0c3d146b50' as const

/** Path to the public JSON manifest file */
export const REAL_MANIFEST_PATH = '/report-v1/manifest.json'

/** Path to the public preview JSON file */
export const REAL_PREVIEW_PATH = '/report-v1/preview.json'

// ── Test pool hashes (placeholder content) ───────────────────────────────────

/** keccak256 of public/test-pool/artifact.txt */
const TEST_ARTIFACT_HASH =
  '0xb49f6ced8268a6d5af62366fcedff510607e0bf7c148e88841bdfd54382fd190' as const

/** keccak256 of public/test-pool/terms.txt */
const TEST_TERMS_HASH =
  '0x43c39dd1b020ecb217ed1e2ee99a702706b3eb5d346f06252abae7d01c52150c' as const

// ── REPORTS map ───────────────────────────────────────────────────────────────

export interface ReportConfig {
  artifactHash:    `0x${string}`
  termsHash:       `0x${string}`
  manifestPath:    string
  /** Path to the public preview JSON (headline stats). */
  previewPath:     string
  termsPath:       string
  /** Filename of the private artifact file (lives in the private server dir) */
  artifactFilename: string
  /** Suggested download filename served to the browser */
  downloadFilename: string
}

// ── Mainnet report ────────────────────────────────────────────────────────────

/** keccak256 of the mainnet private delivery artifact (arc-activity-report-mainnet-v1.json) */
export const MAINNET_ARTIFACT_HASH =
  '0x202799799200624d68ece590b67f68a62e4739382f8f72965ee577937d201b10' as const

/** keccak256 of public/report-mainnet-v1/terms.md */
export const MAINNET_TERMS_HASH =
  '0x2e30e6919339d57066255eb75123d45ede7d1651536e4dcdce848366896dd073' as const

/** Path to the mainnet public JSON manifest */
export const MAINNET_MANIFEST_PATH = '/report-mainnet-v1/manifest.json'

/**
 * Per-network report constants.
 * Both networks are now configured. null would disable buy/join/unlock for that network.
 */
export const REPORTS: Record<NetworkKey, ReportConfig | null> = {
  testnet: {
    artifactHash:    REAL_ARTIFACT_HASH,
    termsHash:       REAL_TERMS_HASH,
    manifestPath:    REAL_MANIFEST_PATH,
    previewPath:     REAL_PREVIEW_PATH,
    termsPath:       '/report-v1/terms.md',
    artifactFilename: 'arc-activity-report-v1.json',
    downloadFilename: 'arc-activity-report-v1.json',
  },
  mainnet: {
    artifactHash:    MAINNET_ARTIFACT_HASH,
    termsHash:       MAINNET_TERMS_HASH,
    manifestPath:    MAINNET_MANIFEST_PATH,
    previewPath:     '/report-mainnet-v1/preview.json',
    termsPath:       '/report-mainnet-v1/terms.md',
    artifactFilename: 'arc-activity-report-mainnet-v1.json',
    downloadFilename: 'arc-activity-report-mainnet-v1.json',
  },
}

// ── Known testnet hashes set (for guards) ─────────────────────────────────────

/**
 * All hashes that are known testnet or test hashes.
 * Used by assertNotTestnetHashes in network.ts.
 */
export const KNOWN_TESTNET_HASHES: ReadonlySet<string> = new Set([
  REAL_ARTIFACT_HASH.toLowerCase(),
  REAL_TERMS_HASH.toLowerCase(),
  TEST_ARTIFACT_HASH.toLowerCase(),
  TEST_TERMS_HASH.toLowerCase(),
])

// ── Terms selection ───────────────────────────────────────────────────────────

/** Outcome of selectTerms: which kind of terms file and its URL path. */
export type TermsKind = 'real' | 'test' | 'unknown'

export interface TermsSpec {
  kind: TermsKind
  /** Fetch-able path (relative), or null for 'unknown'. */
  path: string | null
}

/**
 * Given an on-chain termsHash and the active network key, return the
 * corresponding local file path.
 *
 * On mainnet, testnet/test hashes are returned as 'unknown' (refused).
 */
export function selectTerms(termsHash: `0x${string}`, networkKey: NetworkKey = 'testnet'): TermsSpec {
  const h = termsHash.toLowerCase()
  const report = REPORTS[networkKey]

  // If mainnet has no configured report, refuse all hashes
  if (report === null) {
    return { kind: 'unknown', path: null }
  }

  // On mainnet, known testnet hashes are always refused
  if (networkKey === 'mainnet') {
    if (KNOWN_TESTNET_HASHES.has(h)) {
      return { kind: 'unknown', path: null }
    }
  }

  // Match against the configured report for this network
  if (h === report.termsHash.toLowerCase()) {
    return { kind: 'real', path: report.termsPath }
  }

  // Testnet: also recognise test pool terms
  if (networkKey === 'testnet' && h === TEST_TERMS_HASH.toLowerCase()) {
    return { kind: 'test', path: '/test-pool/terms.txt' }
  }

  return { kind: 'unknown', path: null }
}

// ── Artifact classification ───────────────────────────────────────────────────

export type ArtifactKind = 'real' | 'test' | 'unknown'

/**
 * Given an on-chain artifactHash and the active network key, classify the artifact.
 *
 * On mainnet, known testnet hashes are classified as 'unknown'.
 */
export function classifyArtifact(artifactHash: `0x${string}`, networkKey: NetworkKey = 'testnet'): ArtifactKind {
  const h = artifactHash.toLowerCase()
  const report = REPORTS[networkKey]

  // If network has no configured report, refuse all hashes
  if (report === null) {
    return 'unknown'
  }

  // On mainnet, known testnet hashes are refused
  if (networkKey === 'mainnet') {
    if (KNOWN_TESTNET_HASHES.has(h)) {
      return 'unknown'
    }
  }

  // Match against the configured report for this network
  if (h === report.artifactHash.toLowerCase()) return 'real'

  // Testnet: also recognise test pool artifacts
  if (networkKey === 'testnet' && h === TEST_ARTIFACT_HASH.toLowerCase()) return 'test'

  return 'unknown'
}

// ── Hash utility ──────────────────────────────────────────────────────────────

/** keccak256 of a Uint8Array (wrapper for viem so callers don't import viem). */
export function hashBytes(bytes: Uint8Array): `0x${string}` {
  return keccak256(bytes)
}

// ── Manifest types ────────────────────────────────────────────────────────────

export interface ReportManifest {
  title?:       string
  version?:     string
  description?: string
  artifact?: {
    keccak256?: string
    size?:      number
    /** Deprecated: use size instead. */
    bytes?:     number
  }
  terms?: {
    keccak256?: string
  }
  source?: {
    fromBlock?: number
    toBlock?:   number
    fromUtc?:   string
    toUtc?:     string
  }
  preview?: {
    contractCount?: number
    txCount?:       number
    walletCount?:   number
    dateRange?:     string
  }
}

export interface ReportPreview {
  headline: Array<{ label: string; value: string }>
  notice?:  string
}
