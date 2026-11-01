/**
 * TermsController — framework-free terms verification core.
 *
 * Given a pool's on-chain termsHash, fetches the appropriate terms file,
 * hashes the bytes in the browser, and verifies equality with the chain value.
 *
 * Adapters are injected so tests can drive the same code the React hook uses.
 *
 * State machine:
 *   idle → loading → verified | mismatch | fetch-error | unknown-hash
 *
 * Only 'verified' allows buy/join. All other non-idle states block the buttons.
 */

import { selectTerms, hashBytes } from './reportManifest'
import type { NetworkKey } from './network'

// ── Adapters ──────────────────────────────────────────────────────────────────

export interface FetchAdapter {
  fetchBytes(url: string): Promise<Uint8Array>
}

export interface HasherAdapter {
  keccak256(bytes: Uint8Array): `0x${string}`
}

// ── State ─────────────────────────────────────────────────────────────────────

export type TermsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'verified'; text: string; hash: `0x${string}` }
  | { status: 'mismatch'; computed: `0x${string}`; expected: `0x${string}` }
  | { status: 'fetch-error'; message: string }
  | { status: 'unknown-hash' }

/**
 * Returns true when buy/join are permitted for this terms state.
 * Only 'verified' passes; every other state blocks.
 */
export function termsAllowBuy(state: TermsState): boolean {
  return state.status === 'verified'
}

// ── Core ──────────────────────────────────────────────────────────────────────

export interface TermsControllerAdapters {
  fetcher: FetchAdapter
  hasher:  HasherAdapter
}

/**
 * Verify terms for the given on-chain termsHash.
 * Calls onState with each transition — the React hook stores these in useState.
 * @param networkKey — pass the active network so testnet hashes are never
 *                     accepted on mainnet. Defaults to 'testnet' for backwards compat.
 */
export async function verifyTerms(
  termsHash: `0x${string}`,
  adapters: TermsControllerAdapters,
  onState: (s: TermsState) => void,
  networkKey: NetworkKey = 'testnet',
): Promise<void> {
  onState({ status: 'loading' })

  const { kind, path } = selectTerms(termsHash, networkKey)

  if (kind === 'unknown' || path === null) {
    onState({ status: 'unknown-hash' })
    return
  }

  let bytes: Uint8Array
  try {
    bytes = await adapters.fetcher.fetchBytes(path)
  } catch (e) {
    onState({
      status: 'fetch-error',
      message: `Could not fetch terms file: ${e instanceof Error ? e.message : String(e)}`,
    })
    return
  }

  const computed = adapters.hasher.keccak256(bytes)
  const expected = termsHash.toLowerCase() as `0x${string}`

  if (computed.toLowerCase() !== expected) {
    onState({ status: 'mismatch', computed, expected: termsHash })
    return
  }

  // Decode text. For terms.md / terms.txt this is always UTF-8.
  let text: string
  try {
    text = new TextDecoder('utf-8').decode(bytes)
  } catch {
    onState({ status: 'fetch-error', message: 'Terms file is not valid UTF-8.' })
    return
  }

  onState({ status: 'verified', text, hash: computed })
}

// ── Default browser adapters ──────────────────────────────────────────────────

export const browserFetcher: FetchAdapter = {
  async fetchBytes(url: string): Promise<Uint8Array> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return new Uint8Array(await res.arrayBuffer())
  },
}

export const browserHasher: HasherAdapter = {
  keccak256: hashBytes,
}
