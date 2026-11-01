/**
 * AdminView — route #admin
 *
 * A builder-only screen for creating a TEST pool on the deployed ReflowPools
 * contract. Not linked in the main navigation; reachable by URL only.
 *
 * The caller's browser wallet becomes the pool provider. Studio does NOT
 * create the pool on the user's behalf.
 *
 * Flow:
 *   1. Preflight: chain, bytecode, usdc(), hash verification, simulation,
 *      gas estimate, native-balance solvency.
 *   2. Send createPool with the exact args shown on screen.
 *   3. Wait for receipt. Require status === 'success'.
 *   4. Decode PoolCreated event and verify all fields.
 *   5. Show poolId + tx hash + "set VITE_REFLOW_POOL_ID" instruction.
 *
 * A synchronous ref latch prevents double-clicks.
 * No interaction with TxOrchestrator — this is an admin utility, not a
 * purchase transaction.
 */

import { useRef, useState, useCallback } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  decodeEventLog,
  toEventSelector,
  type TransactionReceipt,
} from 'viem'
import { ConnectKitButton } from 'connectkit'
import { ExternalLink, AlertTriangle, CheckCircle, Loader2, ShieldAlert } from 'lucide-react'
import { REFLOW_POOLS_ABI } from '../lib/reflowAbi'
import { NETWORK } from '../lib/network'
import {
  TEST_POOL_ARTIFACT_HASH,
  TEST_POOL_TERMS_HASH,
  TEST_POOL_PRICE,
  TEST_POOL_CAP,
  TEST_POOL_DEADLINE_SECS,
  computeAndVerifyTestHashes,
} from '../lib/testPoolConstants'
import {
  hashBytes,
  REPORTS,
  KNOWN_TESTNET_HASHES,
  type ReportConfig,
} from '../lib/reportManifest'
import { assertNotTestnetHashes } from '../lib/network'
import { buildTxExplorerUrl, requireChain } from '../onchain-facts'

// ── Constants ─────────────────────────────────────────────────────────────────

const ACTIVE_CHAIN = requireChain(NETWORK.chainId)
const CONTRACT_ADDRESS  = import.meta.env.VITE_REFLOW_CONTRACT as `0x${string}` | undefined

/** Approximate deadline display date (now + 30 days at module load). Not the real tx deadline. */
const DEADLINE_DISPLAY_DATE = new Date(
  (Math.floor(Date.now() / 1000) + TEST_POOL_DEADLINE_SECS) * 1000,
).toISOString().slice(0, 10)

// ── Mode ──────────────────────────────────────────────────────────────────────

type PoolMode = 'test' | 'real'

/** Price, cap and deadline seconds are the same for both modes. */
const REAL_POOL_PRICE         = 1_200_000n
const REAL_POOL_CAP           = 4
const REAL_POOL_DEADLINE_SECS = 30 * 24 * 60 * 60  // 30 days

/**
 * Fetch the real report hashes at create-time and verify them against:
 *  1. The committed constants in REPORTS[NETWORK.key].
 *  2. The server's /api/report/commitment (which now also returns network + chainId).
 *  3. The public manifest and public terms file.
 *
 * Also refuses if the server's network or chainId disagrees with the client's NETWORK,
 * and refuses testnet/placeholder hashes in mainnet mode.
 *
 * @param reportConfig  REPORTS[NETWORK.key] — must be non-null (caller checks).
 * @param fetcher       Injected fetch for testing (defaults to window.fetch).
 */
export async function buildRealPoolArgs(
  reportConfig: ReportConfig,
  fetcher: typeof fetch = fetch,
): Promise<{
  artifactHash: `0x${string}`
  termsHash:    `0x${string}`
}> {
  const { artifactHash: expectedArtifactHash, termsHash: expectedTermsHash } = reportConfig

  // 0. Guard: refuse testnet/placeholder hashes on mainnet
  assertNotTestnetHashes(
    [expectedArtifactHash, expectedTermsHash],
    NETWORK,
    KNOWN_TESTNET_HASHES,
  )

  // 1. Fetch server commitment (includes network + chainId)
  const commitRes = await fetcher('/api/report/commitment')
  if (!commitRes.ok) {
    throw new Error(`Failed to fetch /api/report/commitment: ${commitRes.status} ${commitRes.statusText}`)
  }
  const commit = await commitRes.json() as {
    artifactHash: string
    termsHash:    string
    network?:     string
    chainId?:     number
  }

  // 1a. Network/chainId mismatch: refuse if server is on a different network
  if (commit.network !== undefined && commit.network !== NETWORK.key) {
    throw new Error(
      `Server network mismatch.\n` +
      `  Server: ${commit.network}\n` +
      `  Client: ${NETWORK.key}\n` +
      `Ensure the delivery server is configured for ${NETWORK.name}.`,
    )
  }
  if (commit.chainId !== undefined && commit.chainId !== NETWORK.chainId) {
    throw new Error(
      `Server chain ID mismatch.\n` +
      `  Server: ${commit.chainId}\n` +
      `  Client: ${NETWORK.chainId}\n` +
      `Ensure the delivery server is running on ${NETWORK.name}.`,
    )
  }

  // 2. Verify server's artifactHash against committed constant
  if (commit.artifactHash.toLowerCase() !== expectedArtifactHash.toLowerCase()) {
    throw new Error(
      `Server commitment artifactHash mismatch.\n` +
      `  Expected: ${expectedArtifactHash}\n` +
      `  Got:      ${commit.artifactHash}\n` +
      `Do not proceed.`,
    )
  }

  // 3. Fetch manifest to cross-check (public file, network-specific path)
  const manifestRes = await fetcher(reportConfig.manifestPath)
  if (!manifestRes.ok) {
    throw new Error(`Failed to fetch ${reportConfig.manifestPath}: ${manifestRes.status}`)
  }
  const manifest = await manifestRes.json() as { artifact?: { keccak256?: string }; terms?: { keccak256?: string } }
  if (manifest.artifact?.keccak256?.toLowerCase() !== expectedArtifactHash.toLowerCase()) {
    throw new Error(
      `Manifest artifactHash mismatch.\n` +
      `  Expected: ${expectedArtifactHash}\n` +
      `  Got:      ${manifest.artifact?.keccak256}\n` +
      `Do not proceed.`,
    )
  }

  // 4. Fetch public terms file and hash it in the browser
  const termsRes = await fetcher(reportConfig.termsPath)
  if (!termsRes.ok) {
    throw new Error(`Failed to fetch ${reportConfig.termsPath}: ${termsRes.status}`)
  }
  const termsBytes       = new Uint8Array(await termsRes.arrayBuffer())
  const browserTermsHash = hashBytes(termsBytes)

  // 5. Verify browser hash against committed constant
  if (browserTermsHash.toLowerCase() !== expectedTermsHash.toLowerCase()) {
    throw new Error(
      `Terms hash mismatch (browser hash vs committed constant).\n` +
      `  Expected: ${expectedTermsHash}\n` +
      `  Got:      ${browserTermsHash}\n` +
      `Do not proceed.`,
    )
  }

  // 6. Verify browser hash against server commitment
  if (browserTermsHash.toLowerCase() !== commit.termsHash.toLowerCase()) {
    throw new Error(
      `Terms hash mismatch (browser hash vs server commitment).\n` +
      `  Server says: ${commit.termsHash}\n` +
      `  Browser got: ${browserTermsHash}\n` +
      `Do not proceed.`,
    )
  }

  return {
    artifactHash: expectedArtifactHash,
    termsHash:    browserTermsHash,
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase =
  | { status: 'idle' }
  | { status: 'preflight'; message: string }
  | { status: 'signing' }
  | { status: 'confirming'; hash: `0x${string}` }
  | { status: 'success'; hash: `0x${string}`; poolId: bigint }
  | { status: 'error'; message: string; hash?: `0x${string}` }

// ── PoolCreated event verification ────────────────────────────────────────────

const POOL_CREATED_SELECTOR = toEventSelector(
  REFLOW_POOLS_ABI.find(
    (e): e is Extract<typeof REFLOW_POOLS_ABI[number], { type: 'event'; name: 'PoolCreated' }> =>
      e.type === 'event' && e.name === 'PoolCreated',
  )!,
)

interface VerifiedPoolCreated {
  poolId:       bigint
  provider:     `0x${string}`
  price:        bigint
  artifactHash: `0x${string}`
  termsHash:    `0x${string}`
  deadline:     bigint
  cap:          number
}

/**
 * Decode and verify a PoolCreated event from a receipt.
 *
 * Exported so the unit test can drive it directly with synthetic log data.
 *
 * @param receipt        - Transaction receipt to search.
 * @param contractAddress - Must be the emitter.
 * @param expectedProvider - Connected wallet address.
 * @param expectedPrice
 * @param expectedArtifactHash
 * @param expectedTermsHash
 * @param expectedDeadline
 * @param expectedCap
 * @throws if no matching event found or any field mismatches.
 */
export function verifyPoolCreatedEvent(
  receipt: TransactionReceipt,
  contractAddress: `0x${string}`,
  expectedProvider: `0x${string}`,
  expectedPrice: bigint,
  expectedArtifactHash: `0x${string}`,
  expectedTermsHash: `0x${string}`,
  expectedDeadline: bigint,
  expectedCap: number,
): VerifiedPoolCreated {
  const matchingLogs = receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === contractAddress.toLowerCase() &&
      log.topics[0]?.toLowerCase() === POOL_CREATED_SELECTOR.toLowerCase(),
  )

  if (matchingLogs.length === 0) {
    throw new Error('PoolCreated event not found in receipt — transaction succeeded but event is missing.')
  }

  // Take the first matching log (there should be exactly one per createPool call)
  const log = matchingLogs[0]

  const decoded = decodeEventLog({
    abi: REFLOW_POOLS_ABI,
    eventName: 'PoolCreated',
    topics: log.topics,
    data: log.data,
  })

  const { poolId, provider, price, artifactHash, termsHash, deadline, cap } =
    decoded.args

  // Field verification
  if (provider.toLowerCase() !== expectedProvider.toLowerCase()) {
    throw new Error(
      `PoolCreated.provider mismatch: expected ${expectedProvider}, got ${provider}`,
    )
  }
  if (price !== expectedPrice) {
    throw new Error(`PoolCreated.price mismatch: expected ${expectedPrice}, got ${price}`)
  }
  if (artifactHash.toLowerCase() !== expectedArtifactHash.toLowerCase()) {
    throw new Error(
      `PoolCreated.artifactHash mismatch: expected ${expectedArtifactHash}, got ${artifactHash}`,
    )
  }
  if (termsHash.toLowerCase() !== expectedTermsHash.toLowerCase()) {
    throw new Error(
      `PoolCreated.termsHash mismatch: expected ${expectedTermsHash}, got ${termsHash}`,
    )
  }
  if (deadline !== expectedDeadline) {
    throw new Error(
      `PoolCreated.deadline mismatch: expected ${expectedDeadline}, got ${deadline}`,
    )
  }
  if (Number(cap) !== expectedCap) {
    throw new Error(`PoolCreated.cap mismatch: expected ${expectedCap}, got ${cap}`)
  }
  if (poolId <= 0n) {
    throw new Error(`PoolCreated.poolId must be > 0, got ${poolId}`)
  }

  return { poolId, provider, price, artifactHash, termsHash, deadline, cap: Number(cap) }
}

// ── AdminView component ───────────────────────────────────────────────────────

export function AdminView() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })
  // Mainnet mode: default to 'real'; test-pool mode is only allowed on testnet.
  const [mode, setMode]   = useState<PoolMode>(NETWORK.isMainnet ? 'real' : 'test')
  const latchRef = useRef(false)
  // Typed phrase gate for mainnet confirmation
  const [mainnetPhrase, setMainnetPhrase] = useState('')
  const MAINNET_CONFIRMATION_PHRASE = 'CREATE MAINNET POOL'
  const mainnetConfirmed = !NETWORK.isMainnet || mainnetPhrase.trim() === MAINNET_CONFIRMATION_PHRASE

  const isWrongChain = isConnected && chainId !== NETWORK.chainId

  // Deadline display is the module-level constant (not reactive — just for display).
  const deadlineDate = DEADLINE_DISPLAY_DATE

  const handleCreate = useCallback(async () => {
    if (latchRef.current) return
    latchRef.current = true

    try {
      // ── Preflight: wallet ────────────────────────────────────────────────
      if (!isConnected || !address) {
        setPhase({ status: 'error', message: 'Wallet not connected.' })
        return
      }

      if (!CONTRACT_ADDRESS) {
        setPhase({ status: 'error', message: 'VITE_REFLOW_CONTRACT not configured.' })
        return
      }

      setPhase({ status: 'preflight', message: 'Checking chain...' })

      // Use window.ethereum directly via viem walletClient so we can call
      // eth_chainId, eth_call, eth_estimateGas, eth_sendTransaction.
      type EthereumProvider = { request: (...args: unknown[]) => Promise<unknown> }
      // window.ethereum has no standardized TS type — cast via unknown to avoid unsafe-assignment.
      const provider = ((window as Window & { ethereum?: unknown }).ethereum as EthereumProvider | undefined)
      if (!provider) {
        setPhase({ status: 'error', message: 'No injected provider found (MetaMask or similar required).' })
        return
      }

      const walletClient = createWalletClient({
        transport: custom(provider),
      })

      const publicClient = createPublicClient({
        chain: {
          id: NETWORK.chainId,
          name: ACTIVE_CHAIN.name,
          nativeCurrency: {
            name: 'USDC',
            symbol: 'USDC',
            decimals: 18,
          },
          rpcUrls: { default: { http: ACTIVE_CHAIN.rpcUrls } },
        },
        transport: http(ACTIVE_CHAIN.rpcUrls[0]),
      })

      // ── Preflight: chain ─────────────────────────────────────────────────
      const walletChainId = await walletClient.getChainId()
      if (walletChainId !== NETWORK.chainId) {
        setPhase({ status: 'error', message: `Wrong chain (${walletChainId}). Switch to ${NETWORK.name} (${NETWORK.chainId}).` })
        return
      }

      // ── Preflight: bytecode ──────────────────────────────────────────────
      setPhase({ status: 'preflight', message: 'Verifying contract...' })
      const code = await publicClient.getBytecode({ address: CONTRACT_ADDRESS })
      if (!code || code === '0x') {
        setPhase({ status: 'error', message: `No bytecode at ${CONTRACT_ADDRESS} — contract not deployed on ${NETWORK.name}.` })
        return
      }

      // ── Preflight: usdc() ────────────────────────────────────────────────
      const usdcAddr = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: REFLOW_POOLS_ABI,
        functionName: 'usdc',
      })

      if (usdcAddr.toLowerCase() !== NETWORK.usdc.toLowerCase()) {
        setPhase({ status: 'error', message: `Contract usdc() = ${usdcAddr}, expected ${NETWORK.usdc}.` })
        return
      }

      // ── Preflight: resolve pool args based on mode ────────────────────────
      setPhase({ status: 'preflight', message: mode === 'real' ? 'Fetching and verifying report hashes...' : 'Hashing committed files...' })
      let resolvedArtifactHash: `0x${string}`
      let resolvedTermsHash:    `0x${string}`
      let resolvedPrice:        bigint
      let resolvedCap:          number
      let resolvedDeadlineSecs: number

      if (mode === 'real') {
        const reportConfig = REPORTS[NETWORK.key]
        if (!reportConfig) {
          setPhase({ status: 'error', message: `Mainnet report not configured. Cannot create a real pool on ${NETWORK.name} until REPORTS['${NETWORK.key}'] is set.` })
          return
        }
        try {
          const args = await buildRealPoolArgs(reportConfig)
          resolvedArtifactHash = args.artifactHash
          resolvedTermsHash    = args.termsHash
        } catch (e) {
          setPhase({ status: 'error', message: `Hash verification failed: ${e instanceof Error ? e.message : String(e)}` })
          return
        }
        resolvedPrice        = REAL_POOL_PRICE
        resolvedCap          = REAL_POOL_CAP
        resolvedDeadlineSecs = REAL_POOL_DEADLINE_SECS
      } else {
        try {
          await computeAndVerifyTestHashes()
        } catch (e) {
          setPhase({ status: 'error', message: `File hash mismatch: ${e instanceof Error ? e.message : String(e)}` })
          return
        }
        resolvedArtifactHash = TEST_POOL_ARTIFACT_HASH
        resolvedTermsHash    = TEST_POOL_TERMS_HASH
        resolvedPrice        = TEST_POOL_PRICE
        resolvedCap          = TEST_POOL_CAP
        resolvedDeadlineSecs = TEST_POOL_DEADLINE_SECS
      }

      // ── Compute deadline (fresh, at signing time) ─────────────────────────
      const nowSec       = BigInt(Math.floor(Date.now() / 1000))
      const deadlineArg  = nowSec + BigInt(resolvedDeadlineSecs)

      // ── Preflight: simulate ──────────────────────────────────────────────
      setPhase({ status: 'preflight', message: 'Simulating transaction...' })
      try {
        await publicClient.simulateContract({
          address: CONTRACT_ADDRESS,
          abi: REFLOW_POOLS_ABI,
          functionName: 'createPool',
          args: [
            resolvedPrice,
            resolvedArtifactHash,
            resolvedTermsHash,
            deadlineArg,
            resolvedCap,
          ],
          account: address,
        })
      } catch (e) {
        setPhase({ status: 'error', message: `Simulation failed: ${e instanceof Error ? e.message : String(e)}` })
        return
      }

      // ── Preflight: gas estimate ──────────────────────────────────────────
      setPhase({ status: 'preflight', message: 'Estimating gas...' })
      let gasEstimate: bigint
      try {
        gasEstimate = await publicClient.estimateContractGas({
          address: CONTRACT_ADDRESS,
          abi: REFLOW_POOLS_ABI,
          functionName: 'createPool',
          args: [
            resolvedPrice,
            resolvedArtifactHash,
            resolvedTermsHash,
            deadlineArg,
            resolvedCap,
          ],
          account: address,
        })
      } catch (e) {
        setPhase({ status: 'error', message: `Gas estimation failed: ${e instanceof Error ? e.message : String(e)}` })
        return
      }

      // ── Preflight: native balance ────────────────────────────────────────
      setPhase({ status: 'preflight', message: 'Checking balance...' })
      const nativeBalance = await publicClient.getBalance({ address })

      // Get gas price for solvency check
      let gasPrice: bigint
      try {
        gasPrice = await publicClient.getGasPrice()
      } catch (e) {
        setPhase({ status: 'error', message: `Gas price fetch failed: ${e instanceof Error ? e.message : String(e)}` })
        return
      }

      // createPool does NOT transfer USDC — provider receives payment later.
      // Only gas fee required; check native balance >= gasEstimate * gasPrice.
      const gasCost = gasEstimate * gasPrice
      if (nativeBalance < gasCost) {
        setPhase({
          status: 'error',
          message: `Insufficient balance for gas. Need ≥ ${gasCost} wei native, have ${nativeBalance}.`,
        })
        return
      }

      // ── Sign and send ────────────────────────────────────────────────────
      setPhase({ status: 'signing' })

      // Re-check chain immediately before wallet call
      const chainCheck = await walletClient.getChainId()
      if (chainCheck !== NETWORK.chainId) {
        setPhase({ status: 'error', message: 'Chain changed before signing. Please retry.' })
        return
      }

      let txHash: `0x${string}`
      try {
        txHash = await walletClient.writeContract({
          address: CONTRACT_ADDRESS,
          abi: REFLOW_POOLS_ABI,
          functionName: 'createPool',
          args: [
            resolvedPrice,
            resolvedArtifactHash,
            resolvedTermsHash,
            deadlineArg,
            resolvedCap,
          ],
          account: address,
          chain: {
            id: NETWORK.chainId,
            name: ACTIVE_CHAIN.name,
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
            rpcUrls: { default: { http: ACTIVE_CHAIN.rpcUrls } },
          },
          gas: (gasEstimate * 12n) / 10n, // 20% buffer
        })
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
        if (msg.includes('user rejected') || msg.includes('user denied')) {
          // User cancelled — not an error state, just reset
          setPhase({ status: 'idle' })
          return
        }
        setPhase({ status: 'error', message: `Transaction rejected: ${e instanceof Error ? e.message : String(e)}` })
        return
      }

      setPhase({ status: 'confirming', hash: txHash })

      // ── Wait for receipt ─────────────────────────────────────────────────
      let receipt: TransactionReceipt
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
      } catch (e) {
        setPhase({ status: 'error', hash: txHash, message: `Receipt fetch failed: ${e instanceof Error ? e.message : String(e)}` })
        return
      }

      if (receipt.status !== 'success') {
        setPhase({ status: 'error', hash: txHash, message: 'Transaction reverted on chain.' })
        return
      }

      // ── Verify PoolCreated event ─────────────────────────────────────────
      let verified: VerifiedPoolCreated
      try {
        verified = verifyPoolCreatedEvent(
          receipt,
          CONTRACT_ADDRESS,
          address,
          resolvedPrice,
          resolvedArtifactHash,
          resolvedTermsHash,
          deadlineArg,
          resolvedCap,
        )
      } catch (e) {
        setPhase({
          status: 'error',
          hash: txHash,
          message: `Receipt status is success but event verification failed: ${e instanceof Error ? e.message : String(e)}`,
        })
        return
      }

      setPhase({ status: 'success', hash: txHash, poolId: verified.poolId })
    } finally {
      latchRef.current = false
    }
  }, [isConnected, address, mode, mainnetPhrase])

  return (
    <div
      className="min-h-dvh px-4 py-12"
      style={{ background: 'var(--bg-gradient)' }}
    >
      <div className="mx-auto max-w-xl space-y-6">

        {/* Warning banner */}
        <div
          className="flex items-start gap-3 rounded-2xl px-4 py-3"
          style={{ background: '#fef9c3', border: '1.5px solid #fde047', color: '#713f12' }}
        >
          <ShieldAlert size={18} className="mt-0.5 shrink-0" />
          <div className="text-sm font-medium">
            Admin — builder access only. This page is not linked in the main navigation.
          </div>
        </div>

        {/* Title */}
        <div>
          <h1
            className="display text-3xl font-bold"
            style={{ color: 'var(--ink)', letterSpacing: '-0.04em' }}
          >
            {NETWORK.isMainnet
              ? (mode === 'real' ? 'Create mainnet report pool' : 'Create pool')
              : (mode === 'real' ? 'Create real report pool' : 'Create test pool')}
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
            {mode === 'real'
              ? `Creates the production pool with the verified artifact and terms hashes on ${NETWORK.name}. Your connected wallet becomes the pool provider.`
              : 'Deploys a clearly labelled TEST pool on the deployed ReflowPools contract. Your connected wallet becomes the pool provider.'}
          </p>
        </div>

        {/* Contract info card */}
        <div
          className="rounded-2xl p-4 space-y-2 text-sm"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <Row label="Contract"  value={CONTRACT_ADDRESS ?? '(not configured)'} mono />
          <Row label="Chain"     value={`${NETWORK.name} (${NETWORK.chainId})`} />
          <Row label="Wallet"    value={address ?? 'Not connected'} mono />
        </div>

        {/* Mode toggle — test mode hidden on mainnet */}
        {!NETWORK.isMainnet && (
          <div
            className="flex rounded-2xl overflow-hidden text-sm font-semibold"
            style={{ border: '1px solid var(--border)' }}
          >
            <button
              onClick={() => { setMode('test'); setPhase({ status: 'idle' }) }}
              className="flex-1 py-2.5 transition-colors"
              style={{
                background: mode === 'test' ? 'var(--accent)' : 'var(--surface)',
                color:      mode === 'test' ? 'var(--accent-fg)' : 'var(--muted)',
                border: 'none', cursor: 'pointer',
              }}
            >
              Test pool
            </button>
            <button
              onClick={() => { setMode('real'); setPhase({ status: 'idle' }) }}
              className="flex-1 py-2.5 transition-colors"
              style={{
                background: mode === 'real' ? '#166534' : 'var(--surface)',
                color:      mode === 'real' ? '#fff' : 'var(--muted)',
                border: 'none', cursor: 'pointer',
              }}
            >
              Real report pool
            </button>
          </div>
        )}

        {/* Mode banner */}
        {mode === 'test' ? (
          <div
            className="rounded-2xl px-4 py-3 text-center"
            style={{ background: '#fee2e2', border: '1.5px solid #fca5a5', color: '#991b1b' }}
          >
            <p className="text-base font-bold tracking-wide uppercase" style={{ letterSpacing: '0.06em' }}>
              TEST POOL — placeholder content
            </p>
            <p className="mt-0.5 text-xs">
              Not the real Arc activity report. No deliverable attached.
            </p>
          </div>
        ) : (
          <div
            className="rounded-2xl px-4 py-3"
            style={{ background: '#f0fdf4', border: '1.5px solid #86efac', color: '#166534' }}
          >
            <p className="text-sm font-bold">REAL REPORT POOL</p>
            <p className="mt-0.5 text-xs">
              Creates the production pool with the real artifact hash and terms hash.
              The server's commitment is fetched and verified before sending.
            </p>
          </div>
        )}

        {/* createPool args card */}
        <div
          className="rounded-2xl p-4 space-y-2 text-sm"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <p className="text-xs font-semibold uppercase mb-3" style={{ color: 'var(--muted)', letterSpacing: '0.06em' }}>
            createPool arguments
          </p>
          <Row label="price"        value={`${(mode === 'real' ? REAL_POOL_PRICE : TEST_POOL_PRICE).toString()} (1.20 USDC)`} mono />
          <Row label="artifactHash" value={mode === 'real' ? (REPORTS[NETWORK.key]?.artifactHash ?? '(not configured)') : TEST_POOL_ARTIFACT_HASH} mono />
          <Row label="termsHash"    value={mode === 'real' ? (REPORTS[NETWORK.key]?.termsHash ?? '(not configured)') : TEST_POOL_TERMS_HASH} mono />
          <Row label="deadline"     value={`now + 30 days (≈ ${deadlineDate})`} />
          <Row label="cap"          value={String(TEST_POOL_CAP)} />
        </div>

        {/* File hashes note — content depends on mode */}
        {mode === 'test' ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Hashes are keccak256 of{' '}
            <code className="rounded px-1 py-0.5 text-xs" style={{ background: 'var(--surface-muted)' }}>
              /test-pool/artifact.txt
            </code>{' '}
            and{' '}
            <code className="rounded px-1 py-0.5 text-xs" style={{ background: 'var(--surface-muted)' }}>
              /test-pool/terms.txt
            </code>
            . Both files are fetched and re-hashed before sending.
          </p>
        ) : REPORTS[NETWORK.key] ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Hashes come from the server's verified commitment (<code className="rounded px-1 py-0.5 text-xs" style={{ background: 'var(--surface-muted)' }}>/api/report/commitment</code>)
            and the public terms file. Both are fetched and re-verified in the browser before sending. The server's network and chain ID are checked against this client's configuration.
          </p>
        ) : (
          <p className="text-xs" style={{ color: '#991b1b' }}>
            No report is configured for {NETWORK.name}. Set <code className="rounded px-1 py-0.5 text-xs" style={{ background: 'var(--surface-muted)' }}>REPORTS['{NETWORK.key}']</code> before creating a pool on this network.
          </p>
        )}

        {/* Chain-switch / connect / create button */}
        {!isConnected ? (
          <div className="flex justify-center">
            <ConnectKitButton />
          </div>
        ) : isWrongChain ? (
          <button
            onClick={() => switchChain({ chainId: NETWORK.chainId })}
            disabled={isSwitching}
            className="w-full rounded-2xl py-3 text-sm font-semibold"
            style={{ background: '#f97316', color: '#fff', border: 'none', cursor: isSwitching ? 'not-allowed' : 'pointer' }}
          >
            {isSwitching ? 'Switching...' : `Switch to ${NETWORK.name}`}
          </button>
        ) : (
          <>
            {/* Mainnet typed-phrase gate */}
            {NETWORK.isMainnet && (
              <div className="space-y-2">
                <p className="text-sm font-medium" style={{ color: 'var(--warn)' }}>
                  This will create a pool on <strong>Arc Mainnet</strong> using real USDC.
                  Type <code className="rounded px-1 text-xs" style={{ background: 'var(--surface-muted)' }}>CREATE MAINNET POOL</code> to confirm.
                </p>
                <input
                  type="text"
                  value={mainnetPhrase}
                  onChange={(e) => setMainnetPhrase(e.target.value)}
                  placeholder="CREATE MAINNET POOL"
                  className="w-full rounded-xl border px-3 py-2 text-sm font-mono focus:outline-none"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--ink)' }}
                />
              </div>
            )}
            {mode === 'real' && REPORTS[NETWORK.key] === null && (
              <div className="rounded-2xl px-4 py-3 mb-2"
                style={{ background: '#fef2f2', border: '1.5px solid #fca5a5', color: '#991b1b', fontSize: '0.85rem' }}>
                Mainnet report not configured — create is disabled until REPORTS['{NETWORK.key}'] is set.
              </div>
            )}
            <button
              onClick={() => { void handleCreate() }}
              disabled={phase.status !== 'idle' || !CONTRACT_ADDRESS || !mainnetConfirmed || (mode === 'real' && REPORTS[NETWORK.key] === null)}
              className="w-full rounded-2xl py-3 text-sm font-semibold"
              style={{
                background: NETWORK.isMainnet ? '#b45309' : 'var(--accent)',
                color: '#fff',
                border: 'none',
                opacity: phase.status !== 'idle' || !CONTRACT_ADDRESS || !mainnetConfirmed || (mode === 'real' && REPORTS[NETWORK.key] === null) ? 0.5 : 1,
                cursor: (phase.status === 'idle' && CONTRACT_ADDRESS && mainnetConfirmed && !(mode === 'real' && REPORTS[NETWORK.key] === null)) ? 'pointer' : 'not-allowed',
              }}
            >
              {phase.status === 'idle'
                ? (mode === 'real'
                    ? `Create real report pool on ${NETWORK.name}`
                    : `Create test pool on ${NETWORK.name}`)
                : phase.status === 'preflight' ? 'Running preflight checks…'
                : phase.status === 'signing'   ? 'Waiting for signature…'
                : phase.status === 'confirming' ? 'Confirming…'
                : (mode === 'real'
                    ? `Create real report pool on ${NETWORK.name}`
                    : `Create test pool on ${NETWORK.name}`)}
            </button>
          </>
        )}

        {/* Phase feedback */}
        {phase.status === 'preflight' && (
          <StatusRow icon={<Loader2 size={16} className="animate-spin" />} color="var(--muted)">
            {phase.message}
          </StatusRow>
        )}

        {phase.status === 'signing' && (
          <StatusRow icon={<Loader2 size={16} className="animate-spin" />} color="var(--muted)">
            Waiting for wallet signature...
          </StatusRow>
        )}

        {phase.status === 'confirming' && (
          <StatusRow icon={<Loader2 size={16} className="animate-spin" />} color="var(--muted)">
            Confirming on chain...{' '}
            <a
              href={buildTxExplorerUrl(NETWORK.chainId, phase.hash)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1"
              style={{ color: 'var(--accent)' }}
            >
              view tx <ExternalLink size={12} />
            </a>
          </StatusRow>
        )}

        {phase.status === 'success' && (
          <div
            className="rounded-2xl p-4 space-y-3"
            style={{ background: '#f0fdf4', border: '1.5px solid #86efac' }}
          >
            <div className="flex items-center gap-2 font-semibold" style={{ color: '#166534' }}>
              <CheckCircle size={18} />
              Pool created — pool ID {phase.poolId.toString()}
            </div>
            <p className="text-sm" style={{ color: '#15803d' }}>
              Transaction:{' '}
              <a
                href={buildTxExplorerUrl(NETWORK.chainId, phase.hash)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline"
              >
                {phase.hash.slice(0, 18)}… <ExternalLink size={12} />
              </a>
            </p>
            <div
              className="rounded-xl px-3 py-2 font-mono text-xs"
              style={{ background: '#dcfce7', color: '#14532d' }}
            >
              {mode === 'real' ? (
                <>
                  Set in .env and restart BOTH servers:
                  <br />
                  VITE_REFLOW_POOL_ID={phase.poolId.toString()}
                  <br />
                  REFLOW_POOL_ID={phase.poolId.toString()}
                </>
              ) : (
                <>
                  Set in .env and restart dev server:
                  <br />
                  VITE_REFLOW_POOL_ID={phase.poolId.toString()}
                </>
              )}
            </div>
          </div>
        )}

        {phase.status === 'error' && (
          <div
            className="rounded-2xl p-4 space-y-2"
            style={{ background: '#fef2f2', border: '1.5px solid #fca5a5' }}
          >
            <div className="flex items-center gap-2 font-semibold" style={{ color: '#991b1b' }}>
              <AlertTriangle size={18} />
              Error
            </div>
            <p className="text-sm" style={{ color: '#7f1d1d' }}>{phase.message}</p>
            {phase.hash && (
              <a
                href={buildTxExplorerUrl(NETWORK.chainId, phase.hash)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm underline"
                style={{ color: '#b91c1c' }}
              >
                Tx on explorer <ExternalLink size={12} />
              </a>
            )}
            <button
              onClick={() => setPhase({ status: 'idle' })}
              className="mt-1 text-xs underline"
              style={{ color: '#7f1d1d', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              Dismiss
            </button>
          </div>
        )}

      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 text-xs">
      <span className="shrink-0 font-medium" style={{ color: 'var(--muted)', minWidth: '7rem' }}>
        {label}
      </span>
      <span
        className={`break-all text-right ${mono ? 'font-mono' : ''}`}
        style={{ color: 'var(--ink)' }}
      >
        {value}
      </span>
    </div>
  )
}

function StatusRow({
  icon, color, children,
}: {
  icon: React.ReactNode
  color: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 text-sm" style={{ color }}>
      {icon}
      <span>{children}</span>
    </div>
  )
}
