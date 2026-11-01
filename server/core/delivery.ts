/**
 * Delivery core — framework-free.
 * All external dependencies (chain reads, clock, random, file I/O, HMAC) are
 * injected via adapters so tests drive the same code the HTTP layer uses.
 *
 * Honest limits:
 *  - EOA signatures only (viem verifyMessage). EIP-1271 / smart-contract wallets
 *    are NOT supported; the session endpoint returns a clear 4xx with an
 *    explanation so the caller can show a useful error.
 *  - Nonce store is in-memory; it resets on server restart.
 *  - Delivery cannot stop a member from copying the received bytes.
 */

import { verifyMessage, keccak256 } from 'viem'

// ─── Adapter interfaces ────────────────────────────────────────────────────

export interface ChainAdapter {
  /** Return the chain id of the connected RPC. Must equal DeliveryConfig.chainId. */
  getChainId(): Promise<number>
  /** Return true if the contract address has non-empty bytecode. */
  hasCode(address: `0x${string}`): Promise<boolean>
  /** Read getPool from the contract. Returns null if the pool does not exist. */
  getPool(
    contract: `0x${string}`,
    poolId: bigint,
  ): Promise<{
    provider: `0x${string}`
    artifactHash: `0x${string}`
    termsHash: `0x${string}`
  } | null>
  /** Read getMember from the contract. Throws on RPC error. */
  getMember(
    contract: `0x${string}`,
    poolId: bigint,
    address: `0x${string}`,
  ): Promise<{ isMember: boolean }>
}

export interface ClockAdapter {
  nowMs(): number
}

export interface RandomAdapter {
  /** Return >=16 cryptographically random bytes as a hex string (0x-prefixed). */
  randomHex(): string
}

export interface FileAdapter {
  /** Return the exact bytes of the private artifact file. */
  readArtifact(): Promise<Uint8Array>
  /** Return the exact bytes of the public terms file (public/report-v1/terms.md). */
  readTerms(): Promise<Uint8Array>
}

export interface HmacAdapter {
  /** Sign a payload string; return a hex digest. */
  sign(payload: string): string
  /** Verify a payload against a digest. Constant-time where possible. */
  verify(payload: string, digest: string): boolean
}

// ─── Internal types ────────────────────────────────────────────────────────

interface NonceRecord {
  address: `0x${string}`
  poolId: string
  message: string
  issuedAtMs: number
  expiresAtMs: number
  used: boolean
}

export interface DeliveryConfig {
  contractAddress: `0x${string}`
  poolId: string
  domain: string
  /** Chain URI for EIP-4361 message, e.g. "https://..." */
  uri: string
  /** Network key ('testnet' | 'mainnet') — returned in /api/report/commitment */
  networkKey: string
  /** Chain id — must match the RPC's eth_chainId; used in EIP-4361 messages. */
  chainId: number
  /**
   * Expected keccak256 hash of the private artifact file.
   * Used by deliverFile to verify the live file has not been tampered with.
   * Comes from REPORTS[networkKey].artifactHash.
   */
  artifactHash: `0x${string}`
  /** Nonce TTL in ms (default 5 min) */
  nonceTtlMs?: number
  /** Token TTL in ms (default 10 min) */
  tokenTtlMs?: number
}

export interface ChallengeResult {
  message: string
  nonce: string
}

export interface SessionResult {
  token: string
}

export type DeliveryError =
  | { code: 400; reason: string }
  | { code: 401; reason: string }
  | { code: 403; reason: string }
  | { code: 409; reason: string }
  | { code: 422; reason: string }
  | { code: 429; reason: string }
  | { code: 500; reason: string }
  | { code: 503; reason: string }

export type DeliveryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DeliveryError }

// ─── DeliveryCore ──────────────────────────────────────────────────────────

export class DeliveryCore {
  private readonly nonces = new Map<string, NonceRecord>()
  private readonly nonceTtlMs: number
  private readonly tokenTtlMs: number

  constructor(
    private readonly config: DeliveryConfig,
    private readonly chain: ChainAdapter,
    private readonly clock: ClockAdapter,
    private readonly random: RandomAdapter,
    private readonly file: FileAdapter,
    private readonly hmac: HmacAdapter,
  ) {
    this.nonceTtlMs = config.nonceTtlMs ?? 5 * 60 * 1000
    this.tokenTtlMs = config.tokenTtlMs ?? 10 * 60 * 1000
  }

  // ── /api/report/commitment ──────────────────────────────────────────────

  async getCommitment(): Promise<DeliveryResult<{ artifactHash: string; size: number; termsHash: string; network: string; chainId: number }>> {
    let artifactBytes: Uint8Array
    let termsBytes: Uint8Array
    try {
      artifactBytes = await this.file.readArtifact()
    } catch {
      return { ok: false, error: { code: 500, reason: 'File read error' } }
    }
    try {
      termsBytes = await this.file.readTerms()
    } catch {
      return { ok: false, error: { code: 500, reason: 'Terms file read error' } }
    }
    const artifactHash = keccak256(artifactBytes)
    const termsHash = keccak256(termsBytes)
    return {
      ok: true,
      value: {
        artifactHash,
        size: artifactBytes.length,
        termsHash,
        network: this.config.networkKey,
        chainId: this.config.chainId,
      },
    }
  }

  // ── /api/delivery/challenge ─────────────────────────────────────────────

  challenge(address: string, poolId: string): DeliveryResult<ChallengeResult> {
    // Prune expired and used nonces on every challenge call to bound map growth
    this.pruneNonces()

    if (!isAddress(address)) {
      return { ok: false, error: { code: 400, reason: 'Invalid address' } }
    }
    const addr = address.toLowerCase() as `0x${string}`

    if (poolId !== this.config.poolId) {
      return { ok: false, error: { code: 400, reason: 'Unknown pool' } }
    }

    const nonce = this.random.randomHex()
    const nowMs = this.clock.nowMs()
    const expiresAtMs = nowMs + this.nonceTtlMs
    const issuedAt = new Date(nowMs).toISOString()
    const expiresAt = new Date(expiresAtMs).toISOString()

    const message = buildMessage({
      domain: this.config.domain,
      uri: this.config.uri,
      chainId: this.config.chainId,
      poolId: this.config.poolId,
      contract: this.config.contractAddress,
      address: addr,
      nonce,
      issuedAt,
      expiresAt,
    })

    const record: NonceRecord = {
      address: addr,
      poolId,
      message,
      issuedAtMs: nowMs,
      expiresAtMs,
      used: false,
    }
    this.nonces.set(nonce, record)

    return { ok: true, value: { message, nonce } }
  }

  // ── /api/delivery/session ───────────────────────────────────────────────

  async session(
    address: string,
    poolId: string,
    message: string,
    signature: string,
  ): Promise<DeliveryResult<SessionResult>> {
    if (!isAddress(address)) {
      return { ok: false, error: { code: 400, reason: 'Invalid address' } }
    }
    const addr = address.toLowerCase() as `0x${string}`

    if (poolId !== this.config.poolId) {
      return { ok: false, error: { code: 400, reason: 'Unknown pool' } }
    }

    // Extract nonce from message BEFORE any await
    const nonce = extractNonce(message)
    if (!nonce) {
      return { ok: false, error: { code: 400, reason: 'Nonce not found in message' } }
    }

    // Synchronously consume the nonce before any await — prevents replay and races
    const record = this.nonces.get(nonce)
    if (!record) {
      return { ok: false, error: { code: 400, reason: 'Unknown or expired nonce' } }
    }
    if (record.used) {
      return { ok: false, error: { code: 409, reason: 'Nonce already used' } }
    }
    if (this.clock.nowMs() > record.expiresAtMs) {
      this.nonces.delete(nonce)
      return { ok: false, error: { code: 400, reason: 'Nonce expired' } }
    }
    if (record.address !== addr) {
      return { ok: false, error: { code: 400, reason: 'Address mismatch' } }
    }
    if (record.poolId !== poolId) {
      return { ok: false, error: { code: 400, reason: 'Pool mismatch' } }
    }
    // Byte-identical message check
    if (message !== record.message) {
      return { ok: false, error: { code: 400, reason: 'Message mismatch' } }
    }

    // Mark used synchronously (before any await)
    record.used = true

    // --- Everything below is async; nonce is already consumed ---

    // Verify EOA signature
    let valid: boolean
    try {
      valid = await verifyMessage({ address: addr, message, signature: signature as `0x${string}` })
    } catch {
      return { ok: false, error: { code: 422, reason: 'Signature verification failed. Note: smart-contract wallets and EIP-1271 are not supported; only EOA signatures are accepted.' } }
    }
    if (!valid) {
      return { ok: false, error: { code: 403, reason: 'Signature does not match address. Note: smart-contract wallets and EIP-1271 are not supported; only EOA signatures are accepted.' } }
    }

    // Chain membership checks
    const memberCheck = await this._checkMembership(addr, BigInt(poolId))
    if (!memberCheck.ok) {
      return { ok: false, error: memberCheck.error }
    }

    // Issue token
    const nowMs = this.clock.nowMs()
    const expiresAtMs = nowMs + this.tokenTtlMs
    const token = this._issueToken(addr, poolId, expiresAtMs)

    return { ok: true, value: { token } }
  }

  // ── /api/delivery/file ──────────────────────────────────────────────────

  async deliverFile(authHeader: string | null): Promise<
    DeliveryResult<{
      bytes: Uint8Array
      artifactHash: string
    }>
  > {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { ok: false, error: { code: 401, reason: 'Missing or malformed Authorization header' } }
    }
    const token = authHeader.slice('Bearer '.length).trim()

    const parsed = this._verifyToken(token)
    if (!parsed) {
      return { ok: false, error: { code: 403, reason: 'Invalid or expired token' } }
    }

    // Re-check membership on chain at delivery time
    const memberCheck = await this._checkMembership(parsed.address, BigInt(parsed.poolId))
    if (!memberCheck.ok) {
      return { ok: false, error: memberCheck.error }
    }

    // Stream the file
    let bytes: Uint8Array
    try {
      bytes = await this.file.readArtifact()
    } catch {
      return { ok: false, error: { code: 500, reason: 'File read error' } }
    }

    // Verify live file hash matches the committed artifact hash for this network (fail-closed)
    const liveHash = keccak256(bytes)
    if (liveHash.toLowerCase() !== this.config.artifactHash.toLowerCase()) {
      return { ok: false, error: { code: 503, reason: 'File integrity check failed' } }
    }

    return { ok: true, value: { bytes, artifactHash: liveHash } }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async _checkMembership(
    address: `0x${string}`,
    poolId: bigint,
  ): Promise<{ ok: true } | { ok: false; error: DeliveryError }> {
    // RPC chain check
    let chainId: number
    try {
      chainId = await this.chain.getChainId()
    } catch {
      return { ok: false, error: { code: 503, reason: 'RPC error: could not read chain id' } }
    }
    if (chainId !== this.config.chainId) {
      return { ok: false, error: { code: 503, reason: 'Wrong chain' } }
    }

    // Bytecode check
    let hasCode: boolean
    try {
      hasCode = await this.chain.hasCode(this.config.contractAddress)
    } catch {
      return { ok: false, error: { code: 503, reason: 'RPC error: could not check contract code' } }
    }
    if (!hasCode) {
      return { ok: false, error: { code: 503, reason: 'Contract not found at configured address' } }
    }

    // Pool existence + artifactHash check
    let pool: { provider: `0x${string}`; artifactHash: `0x${string}`; termsHash: `0x${string}` } | null
    try {
      pool = await this.chain.getPool(this.config.contractAddress, poolId)
    } catch {
      return { ok: false, error: { code: 503, reason: 'RPC error: could not read pool' } }
    }
    if (!pool) {
      return { ok: false, error: { code: 503, reason: 'Pool not found' } }
    }

    // On-chain artifactHash must match the server's computed hash
    let fileBytes: Uint8Array
    try {
      fileBytes = await this.file.readArtifact()
    } catch {
      return { ok: false, error: { code: 503, reason: 'File read error during membership check' } }
    }
    const serverHash = keccak256(fileBytes)
    if (serverHash.toLowerCase() !== pool.artifactHash.toLowerCase()) {
      return { ok: false, error: { code: 503, reason: 'On-chain artifactHash does not match server file; delivery suspended' } }
    }

    // Membership check — provider is never a member
    let member: { isMember: boolean }
    try {
      member = await this.chain.getMember(this.config.contractAddress, poolId, address)
    } catch {
      return { ok: false, error: { code: 503, reason: 'RPC error: could not read membership' } }
    }
    if (!member.isMember) {
      return { ok: false, error: { code: 403, reason: 'Not a member of this pool' } }
    }

    return { ok: true }
  }

  private _issueToken(address: `0x${string}`, poolId: string, expiresAtMs: number): string {
    const payload = `${address.toLowerCase()}:${poolId}:${expiresAtMs}`
    const digest = this.hmac.sign(payload)
    // Encode as base64url: payload|digest
    const raw = `${payload}|${digest}`
    return Buffer.from(raw).toString('base64url')
  }

  private _verifyToken(token: string): { address: `0x${string}`; poolId: string } | null {
    let raw: string
    try {
      raw = Buffer.from(token, 'base64url').toString('utf8')
    } catch {
      return null
    }
    const pipeIdx = raw.lastIndexOf('|')
    if (pipeIdx === -1) return null
    const payload = raw.slice(0, pipeIdx)
    const digest = raw.slice(pipeIdx + 1)

    if (!this.hmac.verify(payload, digest)) return null

    const parts = payload.split(':')
    if (parts.length !== 3) return null
    const [address, poolId, expiryStr] = parts
    if (!isAddress(address)) return null
    if (poolId !== this.config.poolId) return null

    const expiresAtMs = parseInt(expiryStr, 10)
    if (isNaN(expiresAtMs) || this.clock.nowMs() > expiresAtMs) return null

    return { address: address as `0x${string}`, poolId }
  }

  /** Expose nonce map size for testing */
  get nonceCount(): number {
    return this.nonces.size
  }

  /**
   * Remove expired and used nonces from the map.
   * Called on every challenge() to prevent unbounded map growth.
   * Exposed for testing.
   */
  pruneNonces(): void {
    const nowMs = this.clock.nowMs()
    for (const [nonce, record] of this.nonces) {
      if (record.used || nowMs > record.expiresAtMs) {
        this.nonces.delete(nonce)
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s)
}

function extractNonce(message: string): string | null {
  const m = message.match(/^Nonce: (.+)$/m)
  return m ? m[1].trim() : null
}

interface MessageParams {
  domain: string
  uri: string
  chainId: number
  poolId: string
  contract: `0x${string}`
  address: `0x${string}`
  nonce: string
  issuedAt: string
  expiresAt: string
}

function buildMessage(p: MessageParams): string {
  return [
    `${p.domain} wants you to sign in with your Ethereum account:`,
    p.address,
    '',
    'Sign to prove you control this wallet and receive the Reflow report. This does not authorise any payment.',
    '',
    `URI: ${p.uri}`,
    `Version: 1`,
    `Chain ID: ${p.chainId}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
    `Expiration Time: ${p.expiresAt}`,
    `Pool ID: ${p.poolId}`,
    `Contract: ${p.contract}`,
  ].join('\n')
}
