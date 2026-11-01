/**
 * DeliveryController — framework-free unlock flow core.
 *
 * Implements the challenge → sign → session → download → verify flow,
 * driving the SAME logic the React hook uses. Adapters are injected for
 * deterministic testing.
 *
 * States (sequential, never skip):
 *   idle → checking-membership → requesting-challenge → awaiting-signature
 *        → starting-session → downloading → verified | error
 *
 * A synchronous latch (_busy) prevents double-invocations.
 * A failed or rejected attempt resets to idle so the user can retry.
 * The token and bytes are NEVER persisted beyond this object's memory.
 * The controller is thrown away when the page unloads.
 *
 * EOA signatures only. Smart-contract wallets / EIP-1271 are NOT supported.
 */

import { decodeFunctionResult } from 'viem'
import { hashBytes, REPORTS } from './reportManifest'
import { REFLOW_POOLS_ABI } from './reflowAbi'
import { NETWORK } from './network'

// ── Adapters ──────────────────────────────────────────────────────────────────

export interface MembershipAdapter {
  /** Return true when address is a member of poolId on the configured contract. */
  isMember(address: `0x${string}`, poolId: bigint): Promise<boolean>
}

export interface SignerAdapter {
  /** Sign a plain-text message with the connected wallet (wagmi useSignMessage). */
  signMessage(message: string): Promise<`0x${string}`>
}

export interface DeliveryFetchAdapter {
  /**
   * Fetch /api/report/commitment and verify it matches the client network + chainId.
   * Returns { ok: true } on success, { ok: false; message } on mismatch or fetch failure.
   */
  commitmentCheck(): Promise<{ ok: true } | { ok: false; message: string }>
  challenge(body: { address: string; poolId: string }): Promise<{ message: string; nonce: string }>
  session(body: { address: string; poolId: string; message: string; signature: string }): Promise<{ token: string }>
  file(token: string): Promise<{ bytes: Uint8Array; headerHash: string | null }>
}

export interface DeliveryHasherAdapter {
  keccak256(bytes: Uint8Array): `0x${string}`
}

export interface DeliveryAdapters {
  membership: MembershipAdapter
  signer:     SignerAdapter
  fetcher:    DeliveryFetchAdapter
  hasher:     DeliveryHasherAdapter
}

// ── Live-chain membership adapter factory ─────────────────────────────────────

/**
 * Minimal read-contract call shape that both viem's public client and synthetic
 * test stubs satisfy.  We only need eth_call with encoded calldata; passing the
 * full wagmi/viem overload shape is not required here.
 */
export interface ReadContractFn {
  (args: {
    address:      `0x${string}`
    abi:          readonly unknown[]
    functionName: string
    args:         readonly unknown[]
  }): Promise<unknown>
}

/**
 * Build a MembershipAdapter that calls getMember on the contract at call-time
 * (never from a captured React state snapshot).
 *
 * Decodes the result by field name via decodeFunctionResult so the byte ordering
 * is verified against the ABI rather than assumed.
 *
 * @param readContract  viem publicClient.readContract or a compatible test stub
 * @param contractAddress  deployed ReflowPools address
 */
export function makeMembershipAdapter(
  readContract:    ReadContractFn,
  contractAddress: `0x${string}`,
): MembershipAdapter {
  return {
    async isMember(address: `0x${string}`, poolId: bigint): Promise<boolean> {
      const raw = await readContract({
        address:      contractAddress,
        abi:          REFLOW_POOLS_ABI,
        functionName: 'getMember',
        args:         [poolId, address],
      })

      // Decode by field name — works whether viem returns the decoded object
      // directly (publicClient.readContract) or returns raw bytes (test stub).
      // publicClient.readContract already returns the decoded struct, so we
      // accept both shapes: a plain object with isMember, or raw Uint8Array bytes.
      if (raw instanceof Uint8Array) {
        const decoded = decodeFunctionResult({
          abi:          REFLOW_POOLS_ABI,
          functionName: 'getMember',
          data:         ('0x' + Buffer.from(raw).toString('hex')) as `0x${string}`,
        }) as { isMember: boolean }
        return decoded.isMember === true
      }

      // viem's publicClient.readContract returns the fully-decoded struct
      return (raw as { isMember: boolean }).isMember === true
    },
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

export type DeliveryPhase =
  | { status: 'idle' }
  | { status: 'checking-membership' }
  | { status: 'requesting-challenge' }
  | { status: 'awaiting-signature' }
  | { status: 'starting-session' }
  | { status: 'downloading' }
  | { status: 'verified'; blobUrl: string; filename: string; artifactHash: `0x${string}` }
  | { status: 'error'; code: ErrorCode; message: string; retryable: boolean }

export type ErrorCode =
  | 'not-connected'
  | 'not-member'
  | 'user-rejected'
  | 'nonce-used'
  | 'service-refused'   // 403 or 503 from server
  | 'network-error'
  | 'hash-mismatch'
  | 'unknown'

// ── Controller class ──────────────────────────────────────────────────────────

export class DeliveryController {
  private _busy = false
  private _currentBlobUrl: string | null = null
  private readonly _onState: (s: DeliveryPhase) => void
  private readonly _adapters: DeliveryAdapters
  /** Pool's on-chain artifactHash — used to verify the downloaded bytes. */
  private readonly _artifactHash: `0x${string}`

  constructor(
    adapters: DeliveryAdapters,
    onState: (s: DeliveryPhase) => void,
    /** The pool's on-chain artifactHash — defaults to the network's configured hash. */
    artifactHash: `0x${string}` = (REPORTS[NETWORK.key]?.artifactHash ?? '0x0'),
  ) {
    this._adapters = adapters
    this._onState  = onState
    this._artifactHash = artifactHash
  }

  isLocked(): boolean { return this._busy }

  async unlock(address: `0x${string}`, poolId: bigint): Promise<void> {
    if (this._busy) return
    this._busy = true

    // Revoke any previous blob URL to avoid leaks
    if (this._currentBlobUrl) {
      URL.revokeObjectURL(this._currentBlobUrl)
      this._currentBlobUrl = null
    }

    try {
      // ── Step 0: commitment check (network + chainId) ───────────────────────
      const commitCheck = await this._adapters.fetcher.commitmentCheck()
      if (!commitCheck.ok) {
        this._error('service-refused', commitCheck.message, false)
        return
      }

      // ── Step 1: membership check ───────────────────────────────────────────
      this._onState({ status: 'checking-membership' })
      let member: boolean
      try {
        member = await this._adapters.membership.isMember(address, poolId)
      } catch (e) {
        this._error('network-error',
          `Membership check failed: ${e instanceof Error ? e.message : String(e)}`, true)
        return
      }
      if (!member) {
        this._error('not-member',
          'Your wallet is not a member of this pool. Purchase access first.', false)
        return
      }

      // ── Step 2: request challenge ──────────────────────────────────────────
      this._onState({ status: 'requesting-challenge' })
      let challengeResult: { message: string; nonce: string }
      try {
        challengeResult = await this._adapters.fetcher.challenge({
          address,
          poolId: poolId.toString(),
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this._serverError(msg, true)
        return
      }

      const { message } = challengeResult

      // ── Step 3: sign ───────────────────────────────────────────────────────
      this._onState({ status: 'awaiting-signature' })
      let signature: `0x${string}`
      try {
        signature = await this._adapters.signer.signMessage(message)
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
        // User rejection — retryable with a fresh challenge
        if (msg.includes('user rejected') || msg.includes('user denied') || msg.includes('rejected')) {
          this._error('user-rejected',
            'Signature rejected. You can try again with a new challenge.', true)
          return
        }
        this._error('unknown',
          `Signing failed: ${e instanceof Error ? e.message : String(e)}`, true)
        return
      }

      // ── Step 4: session ────────────────────────────────────────────────────
      this._onState({ status: 'starting-session' })
      let token: string
      try {
        const sessionResult = await this._adapters.fetcher.session({
          address,
          poolId: poolId.toString(),
          message,
          signature,
        })
        token = sessionResult.token
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this._serverError(msg, true)
        return
      }

      // ── Step 5: download ───────────────────────────────────────────────────
      this._onState({ status: 'downloading' })
      let fileBytes: Uint8Array
      try {
        const result = await this._adapters.fetcher.file(token)
        fileBytes = result.bytes
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this._serverError(msg, false)
        return
      }

      // ── Step 6: verify hash ────────────────────────────────────────────────
      // Compute keccak256 of the received bytes and compare to the pool's
      // ON-CHAIN artifactHash (the header is informational only).
      const computedHash = this._adapters.hasher.keccak256(fileBytes)
      if (computedHash.toLowerCase() !== this._artifactHash.toLowerCase()) {
        // Discard bytes — never offer a download on mismatch
        this._error('hash-mismatch',
          `Received file hash ${computedHash} does not match on-chain artifactHash ${this._artifactHash}. File discarded.`,
          true)
        return
      }

      // ── Step 7: offer download ─────────────────────────────────────────────
      // Cast to BlobPart: fileBytes comes from fetch().arrayBuffer() which is always a
      // plain ArrayBuffer (never SharedArrayBuffer), so this cast is safe at runtime.
      const blob = new Blob([fileBytes as unknown as BlobPart], { type: 'application/json' })
      const blobUrl = URL.createObjectURL(blob)
      this._currentBlobUrl = blobUrl

      const downloadFilename = REPORTS[NETWORK.key]?.downloadFilename ?? 'arc-activity-report.json'
      this._onState({
        status: 'verified',
        blobUrl,
        filename: downloadFilename,
        artifactHash: computedHash,
      })
    } finally {
      this._busy = false
    }
  }

  reset(): void {
    if (this._currentBlobUrl) {
      URL.revokeObjectURL(this._currentBlobUrl)
      this._currentBlobUrl = null
    }
    this._busy = false
    this._onState({ status: 'idle' })
  }

  private _error(code: ErrorCode, message: string, retryable: boolean): void {
    this._onState({ status: 'error', code, message, retryable })
  }

  private _serverError(rawMsg: string, retryable: boolean): void {
    // Match leading numeric HTTP status codes (e.g. "409 …", "401 …").
    // Anchored to the START of the message so a body that merely contains
    // "409" in unrelated text is never misclassified.
    const leadingStatus = /^(\d{3})\b/.exec(rawMsg)
    const status = leadingStatus ? leadingStatus[1] : null

    if (status === '409') {
      this._error('nonce-used',
        'This challenge was already used. Press Unlock again to request a new one.', true)
      return
    }
    if (status === '401') {
      this._error('service-refused',
        'Session invalid or expired. Press Unlock again to start a new session.', true)
      return
    }
    if (status === '429') {
      this._error('service-refused',
        'Too many attempts. Wait a minute and try again.', true)
      return
    }
    if (status === '403' || status === '503') {
      this._error('service-refused',
        `Service refused access. Your payment evidence and the contract still work.`, retryable)
      return
    }
    if (rawMsg.toLowerCase().includes('network') || rawMsg.toLowerCase().includes('fetch') || rawMsg.toLowerCase().includes('failed')) {
      this._error('network-error',
        `Service unreachable. Your payment evidence and the contract still work.`, true)
      return
    }
    this._error('unknown', rawMsg, retryable)
  }
}

// ── Browser fetch adapter factory ─────────────────────────────────────────────

export function makeBrowserDeliveryFetcher(): DeliveryFetchAdapter {
  return {
    async commitmentCheck() {
      try {
        const res = await fetch('/api/report/commitment')
        if (!res.ok) {
          return { ok: false, message: `Commitment check failed: server returned ${res.status}` }
        }
        const body = await res.json() as { network?: string; chainId?: number }
        if (body.network !== undefined && body.network !== NETWORK.key) {
          return {
            ok: false,
            message:
              `Delivery server is on network "${body.network}" but this client is configured for "${NETWORK.key}". ` +
              `Ensure the server and client use the same REFLOW_NETWORK / VITE_REFLOW_NETWORK setting.`,
          }
        }
        if (body.chainId !== undefined && body.chainId !== NETWORK.chainId) {
          return {
            ok: false,
            message:
              `Delivery server chain ID ${body.chainId} does not match client chain ID ${NETWORK.chainId}. ` +
              `Ensure the server and client are configured for the same network.`,
          }
        }
        return { ok: true }
      } catch (e) {
        return { ok: false, message: `Commitment check failed: ${e instanceof Error ? e.message : String(e)}` }
      }
    },

    async challenge(body) {
      const res = await fetch('/api/delivery/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => `${res.status}`)
        throw new Error(`${res.status} ${text}`)
      }
      return res.json() as Promise<{ message: string; nonce: string }>
    },

    async session(body) {
      const res = await fetch('/api/delivery/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => `${res.status}`)
        throw new Error(`${res.status} ${text}`)
      }
      return res.json() as Promise<{ token: string }>
    },

    async file(token) {
      const res = await fetch('/api/delivery/file', {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (!res.ok) {
        const text = await res.text().catch(() => `${res.status}`)
        throw new Error(`${res.status} ${text}`)
      }
      const headerHash = res.headers.get('X-Artifact-Keccak256')
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { bytes, headerHash }
    },
  }
}

export const browserDeliveryHasher: DeliveryHasherAdapter = { keccak256: hashBytes }
