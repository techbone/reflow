/**
 * Local adapter replacing the unavailable @circlefin/compass-chains package.
 *
 * compass-deploy.ts calls getChain(compassChain) where compassChain is a
 * Compass chain key like "Arc_Testnet" or "Base_Sepolia".
 *
 * This adapter resolves Compass keys against the onchain-facts registry
 * (imported via relative path — scripts/ has no @/ alias at bun runtime).
 * It fails on unknown keys rather than silently returning stale guesses.
 *
 * Fields returned match what compass-deploy.ts actually reads:
 *   chainDef.explorerUrl             → explorerBase
 *   chainDef.name                    → name
 *   chainDef.nativeCurrency.symbol   → nativeCurrency.symbol
 */

import { requireChain } from '../src/onchain-facts'

export interface CompassChainDef {
  name: string
  explorerUrl: string
  nativeCurrency: { symbol: string }
}

function entry(chainId: number, compassKey: string): [string, CompassChainDef] | null {
  try {
    const c = requireChain(chainId)
    return [compassKey, {
      name:           c.name,
      explorerUrl:    c.explorerBase,
      nativeCurrency: { symbol: c.nativeCurrency.symbol },
    }]
  } catch {
    // Chain not present in registry — skip rather than crash at module load
    return null
  }
}

// Compass key → chainId from the onchain-facts registry.
// Never duplicate chain metadata here; requireChain is the single source.
// To add a chain: add it to onchain-facts.ts first, then add an entry here.
const ENTRIES = [
  entry(5042002, 'Arc_Testnet'),
  entry(5042,    'Arc'),
  entry(11155111,'ETH_Sepolia'),
  entry(84532,   'Base_Sepolia'),
  entry(421614,  'Arbitrum_Sepolia'),
  entry(11155420,'OP_Sepolia'),
  entry(43113,   'AVAX_Fuji'),
  entry(80002,   'MATIC_Amoy'),
  entry(1301,    'UNI_Sepolia'),
  entry(10143,   'Monad_Testnet'),
]

const CHAIN_MAP: Record<string, CompassChainDef> = Object.fromEntries(
  ENTRIES.filter((e): e is [string, CompassChainDef] => e !== null)
)

/**
 * Map a Compass chain key to a chain definition.
 * Throws on unknown keys — never silently returns stale data.
 */
export function getChain(compassChain: string): CompassChainDef {
  const def = CHAIN_MAP[compassChain]
  if (!def) {
    throw new Error(
      `compass-chains-shim: unknown Compass chain key "${compassChain}". ` +
      `Known keys: ${Object.keys(CHAIN_MAP).join(', ')}. ` +
      `Add the chain to onchain-facts.ts then add its Compass key here.`
    )
  }
  return def
}
