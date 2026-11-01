/**
 * server/validateConfig.ts — pure server startup configuration validator.
 *
 * validateServerConfig({ env, rpcChainId }) collects ALL fatal errors before
 * any side-effects (no file reads, no port binding, no process.exit) so that:
 *   - Tests can drive it directly with synthetic env maps and chain ids.
 *   - server/index.ts calls it once, BEFORE Bun.serve, and exits on any error.
 *
 * Cases covered:
 *   A. mainnet + known-testnet contract         → fatal
 *   B. mainnet + REPORTS.mainnet === null        → fatal
 *   C. RPC chain id ≠ configured chain id        → fatal
 *   D. invalid REFLOW_NETWORK value              → resolveNetwork already throws;
 *      we wrap it and surface it as a fatal error
 *   E. normal testnet                            → empty array (OK)
 *   + missing VITE_REFLOW_CONTRACT               → fatal
 *   + missing REFLOW_POOL_ID                     → fatal
 *   + both-set-and-differ                        → resolveNetwork throws → fatal
 */

import {
  resolveNetwork,
  assertNotKnownTestnetContract,
  assertNotTestnetHashes as _assertNotTestnetHashes,
  checkChainIdMatchesNetwork,
  type NetworkConfig,
} from '../src/lib/network.js'
import {
  REPORTS,
  type ReportConfig,
  KNOWN_TESTNET_HASHES,
} from '../src/lib/reportManifest.js'

export interface ValidateServerConfigInput {
  /** process.env (or a test substitute). */
  env: Record<string, string | undefined>
  /**
   * Chain id returned by `await viemClient.getChainId()`.
   * Pass undefined to skip the chain-id check (e.g. when the RPC is unreachable
   * at validation time — the caller must then run the check separately).
   * The production server always resolves this BEFORE calling validateServerConfig.
   */
  rpcChainId: number | undefined
}

export interface ValidateServerConfigResult {
  /** Resolved network (may be used by the caller to avoid resolving twice). */
  network: NetworkConfig
  /** Fatal errors. Empty array means configuration is valid. */
  errors: string[]
}

/**
 * Validate server configuration.
 * Returns { network, errors }.
 * errors is empty when configuration is fully valid.
 * Errors is non-empty and should cause process.exit(1).
 */
export function validateServerConfig(
  input: ValidateServerConfigInput,
): ValidateServerConfigResult {
  const errors: string[] = []
  let network: NetworkConfig

  // Step 1 — resolve network (throws on invalid / conflicting values)
  try {
    network = resolveNetwork(input.env)
  } catch (e) {
    // resolveNetwork throws Error with a descriptive message
    errors.push((e as Error).message)
    // We cannot continue validation without a resolved network, so return early.
    // Use testnet as a placeholder to satisfy the return type; caller must exit.
    return {
      network: resolveNetwork({}),
      errors,
    }
  }

  // Step 2 — required env vars
  const contract = (input.env['VITE_REFLOW_CONTRACT'] ?? '').trim()
  if (!contract) {
    errors.push('VITE_REFLOW_CONTRACT is required.')
  }

  const poolId = (input.env['REFLOW_POOL_ID'] ?? '').trim()
  if (!poolId) {
    errors.push('REFLOW_POOL_ID is required.')
  }

  // Step 3 — mainnet-specific checks
  if (network.isMainnet && contract) {
    // 3a. Known testnet contract on mainnet
    try {
      assertNotKnownTestnetContract(contract, network)
    } catch (e) {
      errors.push((e as Error).message)
    }

    // 3b. REPORTS[network.key] must be configured (not null)
    const reportConfig: ReportConfig | null = REPORTS[network.key]
    if (reportConfig === null) {
      errors.push(
        `[network] Report is not configured for ${network.name}. ` +
        `REPORTS['${network.key}'] is null. ` +
        `Publish a ${network.key} report and update REPORTS before running the server.`,
      )
    } else {
      // 3c. Hashes must not be known testnet/test hashes
      try {
        _assertNotTestnetHashes(
          [reportConfig.artifactHash, reportConfig.termsHash],
          network,
          KNOWN_TESTNET_HASHES,
        )
      } catch (e) {
        errors.push((e as Error).message)
      }
    }
  }

  // Step 4 — RPC chain id check (skipped when rpcChainId is undefined)
  if (input.rpcChainId !== undefined) {
    const mismatch = checkChainIdMatchesNetwork(input.rpcChainId, network)
    if (mismatch) {
      errors.push(mismatch)
    }
  }

  return { network, errors }
}
