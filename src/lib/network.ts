/**
 * network.ts — single source of truth for the active Arc network.
 *
 * Client:  reads VITE_REFLOW_NETWORK only (import.meta.env).
 * Server:  reads REFLOW_NETWORK first; falls back to VITE_REFLOW_NETWORK.
 *          If both are set and differ, resolveNetwork throws.
 *
 * Valid values (after trim + lowercase): '', 'testnet', 'mainnet'.
 * Any other value throws with a message naming the bad value.
 *
 * Guards (server startup, preflight):
 *   assertNotKnownTestnetContract — refuses known testnet contracts on mainnet.
 *   assertNotTestnetHashes        — refuses testnet/test hashes on mainnet.
 *   checkChainIdMatchesNetwork    — returns error string when RPC chain id disagrees.
 */

// ── Chain IDs ─────────────────────────────────────────────────────────────────

/** Arc Testnet chain ID. Also re-exported from reflowConfig for legacy imports. */
export const ARC_TESTNET_CHAIN_ID = 5042002
/** Arc Mainnet chain ID. */
export const ARC_MAINNET_CHAIN_ID = 5042

// ── Known testnet contracts ───────────────────────────────────────────────────

/**
 * Contract addresses known to be deployed on Arc Testnet only.
 * Any of these, when passed as a mainnet contract config, are refused.
 */
export const KNOWN_TESTNET_CONTRACTS: ReadonlySet<string> = new Set([
  '0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9', // ReflowPools on Arc Testnet (block 68201692)
])

// ── Network key ───────────────────────────────────────────────────────────────

export type NetworkKey = 'testnet' | 'mainnet'

// ── NetworkConfig ─────────────────────────────────────────────────────────────

export interface NetworkConfig {
  /** 'testnet' | 'mainnet' */
  key:        NetworkKey
  /** Human-readable name shown in the UI. */
  name:       string
  chainId:    number
  /** Canonical USDC ERC-20 address for this network (6 decimals on Arc). */
  usdc:       `0x${string}`
  isMainnet:  boolean
  isTestnet:  boolean
  /** Public RPC endpoint(s) for this network (from chain registry). */
  rpcUrls:    readonly string[]
  /** Circle SCP / RPC proxy chain key (e.g. 'Arc_Testnet'). */
  compassKey: string
}

// ── Known USDC addresses ──────────────────────────────────────────────────────

const TESTNET_USDC = '0x3600000000000000000000000000000000000000' as const
const MAINNET_USDC = '0x3600000000000000000000000000000000000000' as const // same slot on Arc Mainnet

// ── resolveNetwork ────────────────────────────────────────────────────────────

/**
 * Resolve the active network from an environment map.
 *
 * For the CLIENT, pass import.meta.env (only VITE_REFLOW_NETWORK is read).
 * For the SERVER, pass process.env (REFLOW_NETWORK preferred; falls back to
 * VITE_REFLOW_NETWORK; both present and differing is a fatal error).
 *
 * Throws on:
 *   - An unrecognised value (not '', 'testnet', or 'mainnet').
 *   - Both REFLOW_NETWORK and VITE_REFLOW_NETWORK set to different non-empty values.
 */
export function resolveNetwork(env: Record<string, string | undefined>): NetworkConfig {
  const serverKey = (env['REFLOW_NETWORK'] ?? '').trim().toLowerCase()
  const clientKey = (env['VITE_REFLOW_NETWORK'] ?? '').trim().toLowerCase()

  // Validate each independently before comparing
  const VALID = new Set(['', 'testnet', 'mainnet'])
  if (!VALID.has(serverKey)) {
    throw new Error(
      `[network] Invalid REFLOW_NETWORK value: "${env['REFLOW_NETWORK']}". ` +
      `Accepted values: "testnet", "mainnet", or unset.`,
    )
  }
  if (!VALID.has(clientKey)) {
    throw new Error(
      `[network] Invalid VITE_REFLOW_NETWORK value: "${env['VITE_REFLOW_NETWORK']}". ` +
      `Accepted values: "testnet", "mainnet", or unset.`,
    )
  }

  // Both set to non-empty differing values is a fatal misconfiguration
  if (serverKey !== '' && clientKey !== '' && serverKey !== clientKey) {
    throw new Error(
      `[network] REFLOW_NETWORK="${env['REFLOW_NETWORK']}" and ` +
      `VITE_REFLOW_NETWORK="${env['VITE_REFLOW_NETWORK']}" are both set but disagree. ` +
      `Set only one, or make them the same value.`,
    )
  }

  // Server key wins; fall back to client key; fall back to '' (testnet)
  const resolved = serverKey !== '' ? serverKey : clientKey

  if (resolved === 'mainnet') {
    return {
      key:        'mainnet',
      name:       'Arc Mainnet',
      chainId:    ARC_MAINNET_CHAIN_ID,
      usdc:       MAINNET_USDC,
      isMainnet:  true,
      isTestnet:  false,
      rpcUrls:    ['https://rpc.mainnet.arc.io'] as const,
      compassKey: 'Arc',
    }
  }

  // '' or 'testnet'
  return {
    key:        'testnet',
    name:       'Arc Testnet',
    chainId:    ARC_TESTNET_CHAIN_ID,
    usdc:       TESTNET_USDC,
    isMainnet:  false,
    isTestnet:  true,
    rpcUrls:    ['https://rpc.testnet.arc.io'] as const,
    compassKey: 'Arc_Testnet',
  }
}

// ── Client-only singleton ─────────────────────────────────────────────────────

/**
 * Resolved once at module load from the Vite / vitest env.
 * Client code imports this constant; server code calls resolveNetwork(process.env).
 *
 * To avoid `Property 'env' does not exist on type 'ImportMeta'` under the server
 * tsconfig (which has no Vite types), we access import.meta.env through a helper
 * that is typed as returning Record<string,string|undefined>.  The cast is confined
 * to this one place and does not propagate to callers.
 */
function _readViteEnv(): Record<string, string | undefined> {
  // Cast through unknown so server/tsconfig.json (no Vite types) accepts this.
  // IMPORTANT: do NOT guard with `'env' in import.meta` or any typeof check on
  // import.meta.  Vite statically replaces `import.meta.env` at build time; a
  // runtime guard prevents that replacement, leaving the expression unevaluated
  // in the production bundle so the env reads as {} and resolveNetwork always
  // falls back to testnet.  In a plain Node process (server) import.meta.env is
  // undefined; the `?? {}` handles that case.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  return env ?? {}
}

const _viteEnv = _readViteEnv()
export const NETWORK: NetworkConfig = resolveNetwork(
  Object.keys(_viteEnv).length > 0 ? _viteEnv : (
    typeof process !== 'undefined'
      ? process.env
      : {}
  ),
)

// ── Guards ────────────────────────────────────────────────────────────────────

/**
 * Throw if `address` is a known testnet-only contract and we are on mainnet.
 * Silent on testnet.
 */
export function assertNotKnownTestnetContract(
  address: string,
  network: NetworkConfig,
): void {
  if (!network.isMainnet) return
  if (KNOWN_TESTNET_CONTRACTS.has(address.toLowerCase())) {
    throw new Error(
      `[network] Contract ${address} is a known testnet-only contract and must not be ` +
      `used on ${network.name}. Set VITE_REFLOW_CONTRACT to a mainnet deployment address.`,
    )
  }
}

/**
 * Throw if any of the provided hashes are known test/testnet-report hashes
 * and we are running on mainnet. Silent on testnet.
 *
 * @param hashes            — list of keccak256 hashes to check.
 * @param network           — active network.
 * @param knownTestnetHashes — set of known testnet/test hashes (from reportManifest).
 */
export function assertNotTestnetHashes(
  hashes: readonly string[],
  network: NetworkConfig,
  knownTestnetHashes: ReadonlySet<string>,
): void {
  if (!network.isMainnet) return
  for (const h of hashes) {
    if (knownTestnetHashes.has(h.toLowerCase())) {
      throw new Error(
        `[network] Hash ${h} is a known testnet/test hash and must not be used on ` +
        `${network.name}. Publish a mainnet report and set the correct hashes.`,
      )
    }
  }
}

/**
 * Return an error string when the RPC chain id disagrees with the configured
 * network, or undefined when they match.  Used by validateServerConfig.
 */
export function checkChainIdMatchesNetwork(
  rpcChainId: number,
  network: NetworkConfig,
): string | undefined {
  if (rpcChainId !== network.chainId) {
    return (
      `RPC chain id ${rpcChainId} does not match configured network ` +
      `${network.name} (chain id ${network.chainId}). ` +
      `Set REFLOW_NETWORK correctly or update RPC_URL to point at the right network.`
    )
  }
  return undefined
}
