/**
 * PurchaseRoom — purchase/join/claim UI for a ReflowPools pool.
 *
 * This component is purely presentational + invocation. All transaction
 * state lives in TxControllerProvider (mounted above the router, never
 * unmounted by navigation). This component holds NO write hooks, NO reducer,
 * NO busy ref — it calls controller.execute() and reads controller.txState.
 *
 * The shared controller's latch (a useRef) is acquired synchronously before
 * any await — two calls from any number of mounted PurchaseRoom instances
 * cannot both pass the guard.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useAccount, useSwitchChain, useSignMessage, usePublicClient } from 'wagmi'
import { Loader2, ExternalLink, AlertCircle, CheckCircle2, RefreshCw, ArrowRight, ShieldCheck, Download, ChevronDown, ChevronUp } from 'lucide-react'
import { useReflowPool } from '@/hooks/useReflowPool'
import { useContractVerification } from '@/hooks/useContractVerification'
import { REFLOW_CONFIG, NETWORK } from '@/lib/reflowConfig'
import { fmtUsdc } from '@/lib/shareCalc'
import {
  derivePoolStatus, canPurchaseFirst, canJoin, canClaim,
  statusLabel, statusColor, formatDeadline, formatAddress,
} from '@/lib/poolState'
import { useTxController } from '@/lib/TxController'
import { buildTxExplorerUrl } from '@/onchain-facts'
import { CostBar, CostBarLegend } from './CostBar'
import { StatGrid, StatTile } from './StatTiles'
import { DEMO_RESOURCE } from '@/lib/reflowConfig'
import type { TxPhase, TxAction } from '@/lib/txLifecycle'
import {
  verifyTerms, termsAllowBuy, browserFetcher, browserHasher,
  type TermsState,
} from '@/lib/TermsController'
import {
  DeliveryController, makeMembershipAdapter,
  makeBrowserDeliveryFetcher, browserDeliveryHasher,
  type DeliveryPhase,
} from '@/lib/DeliveryController'
import { classifyArtifact } from '@/lib/reportManifest'


const CHAIN = NETWORK.chainId

interface PurchaseRoomProps { nowSec?: number }

export function PurchaseRoom({ nowSec: nowSecProp }: PurchaseRoomProps = {}) {
  const cfg = REFLOW_CONFIG
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending: isSwitching } = useSwitchChain()

  const isRightChain = chainId === CHAIN
  const nowSec = nowSecProp ?? 0

  const { pool, member, outstandingCredit, usdcBalance, quote, quoteError, isLoading, isError, refetch } = useReflowPool()
  const verification = useContractVerification()

  // Controller — lives above the router, survives navigation
  const controller = useTxController()
  const { txState, execute, dispatch, reconcileHash } = controller

  const phase = txState.phase
  // isBusy() reads the ref synchronously — never stale
  const busyNow = controller.isBusy()

  // ── Terms verification ──────────────────────────────────────────────────────
  const [termsStateRaw, setTermsStateRaw] = useState<TermsState>({ status: 'idle' })
  // When the pool changes to one without a termsHash, show idle without a setState.
  // When there IS a termsHash, run the async verifier.
  const termsHash = pool?.termsHash ?? null
  useEffect(() => {
    if (!termsHash) return
    // verifyTerms immediately emits { status: 'loading' } before any async work
    void verifyTerms(termsHash, { fetcher: browserFetcher, hasher: browserHasher }, setTermsStateRaw, NETWORK.key)
  }, [termsHash])
  // Derive the displayed state: idle when no termsHash, otherwise stored state
  const termsState: TermsState = termsHash ? termsStateRaw : { status: 'idle' }

  const termsOk = termsAllowBuy(termsState)

  // ── Delivery controller (unlock report) ────────────────────────────────────
  //
  // ONE persistent DeliveryController per pool (keyed on artifactHash) so its
  // latch survives re-renders.  Adapters hold refs to the current wagmi hooks so
  // they always read the LIVE values at call-time — never a stale closure.
  // This means we can list every dependency honestly without any eslint-disable.
  const [deliveryState, setDeliveryState] = useState<DeliveryPhase>({ status: 'idle' })
  const { signMessageAsync } = useSignMessage()
  const publicClient = usePublicClient()

  // Mutable refs — updated in an effect so adapter closures always see the
  // current value without triggering controller reconstruction.
  const signMessageRef   = useRef(signMessageAsync)
  const publicClientRef  = useRef(publicClient)
  useEffect(() => { signMessageRef.current  = signMessageAsync }, [signMessageAsync])
  useEffect(() => { publicClientRef.current = publicClient },     [publicClient])

  const deliveryCtrlRef = useRef<DeliveryController | null>(null)
  useEffect(() => {
    if (!pool?.artifactHash || !cfg.contractAddress) return
    const contractAddress = cfg.contractAddress
    const artifactHash    = pool.artifactHash
    deliveryCtrlRef.current = new DeliveryController(
      {
        membership: makeMembershipAdapter(
          // Delegate to the ref so we always call the current publicClient,
          // even if wagmi reconnects between construction and the first unlock.
          (args) => {
            const client = publicClientRef.current
            if (!client) return Promise.reject(new Error('No RPC client'))
            return client.readContract(args)
          },
          contractAddress,
        ),
        signer: {
          signMessage: (msg) => signMessageRef.current({ message: msg }),
        },
        fetcher: makeBrowserDeliveryFetcher(),
        hasher:  browserDeliveryHasher,
      },
      setDeliveryState,
      artifactHash,
    )
  }, [pool?.artifactHash, cfg.contractAddress])

  const handleUnlock = useCallback(() => {
    if (!address || !cfg.poolId || !deliveryCtrlRef.current) return
    void deliveryCtrlRef.current.unlock(address, cfg.poolId)
  }, [address, cfg.poolId])

  const handleDeliveryReset = useCallback(() => {
    deliveryCtrlRef.current?.reset()
  }, [])

  // Wallet change: dispatch WALLET_CHANGED when address changes
  const prevAddressRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (prevAddressRef.current !== undefined && prevAddressRef.current !== address) {
      dispatch({ type: 'WALLET_CHANGED' })
    }
    prevAddressRef.current = address
  }, [address, dispatch])

  // Restore context on mount (once per provider lifetime — guard in controller)
  // The controller's own restoration runs in its own effect; nothing to do here.

  const handlePurchaseFirst = () => {
    if (!pool || !address) return
    void execute({
      action: 'purchaseFirst',
      price: pool.price,
    })
  }

  const handleJoin = () => {
    if (!pool || !address || !quote) return
    void execute({
      action: 'join',
      contribution: quote.contribution,
      expectedCount: quote.expectedCount,
    })
  }

  const handleClaim = () => {
    if (!address) return
    void execute({
      action: 'claimFor',
      minClaim: outstandingCredit ?? 0n,
    })
  }

  const handleRefresh = () => {
    dispatch({ type: 'REFRESH' })
    refetch()
  }

  // ── Derived display values ──────────────────────────────────────────────────
  const status = pool
    ? derivePoolStatus(pool, nowSec)
    : (isLoading ? 'loading' : isError ? 'rpc-error' : 'not-configured')

  const isMember     = member?.isMember ?? false
  const claimable    = outstandingCredit ?? 0n
  const hasClaimable = claimable > 0n
  const artifactKind = pool ? classifyArtifact(pool.artifactHash, NETWORK.key) : null

  const canActPurchase = canPurchaseFirst(status) && !isMember
  const canActJoin     = canJoin(status) && !isMember
  const canActClaim    = canClaim(status) && isMember && hasClaimable
  // Terms must be verified before buy/join (claim is unaffected — member already agreed)
  const termsBlockBuy  = !termsOk && (canActPurchase || canActJoin)

  const txUrl = txState.confirmedHash
    ? buildTxExplorerUrl(CHAIN, txState.confirmedHash)
    : txState.pending?.hash
      ? buildTxExplorerUrl(CHAIN, txState.pending.hash)
      : undefined

  // ── Setup-pending ───────────────────────────────────────────────────────────
  if (!cfg.isConfigured) {
    return <SetupPending reason={cfg.pendingReason} />
  }

  // ── Contract verification failed ────────────────────────────────────────────
  if (!verification.checking && !verification.ok && cfg.isConfigured) {
    return (
      <div className="rounded-3xl p-6" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <AlertCircle className="mb-2 size-5" style={{ color: 'var(--danger)' }} />
        <p className="text-sm font-medium" style={{ color: 'var(--ink)' }}>Contract verification failed</p>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>{verification.reason}</p>
        <button onClick={handleRefresh} className="mt-3 flex items-center gap-1.5 text-sm font-medium" style={{ color: 'var(--accent)' }}>
          <RefreshCw className="size-3.5" /> Retry
        </button>
      </div>
    )
  }

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (isLoading || status === 'loading' || verification.checking) {
    return (
      <div className="rounded-3xl p-8 text-center" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <Loader2 className="mx-auto mb-3 size-6 animate-spin" style={{ color: 'var(--muted)' }} />
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading pool from {NETWORK.name}…</p>
      </div>
    )
  }

  // ── RPC error ───────────────────────────────────────────────────────────────
  if (isError || status === 'rpc-error') {
    return (
      <div className="rounded-3xl p-6" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <AlertCircle className="mb-2 size-5" style={{ color: 'var(--danger)' }} />
        <p className="text-sm font-medium" style={{ color: 'var(--ink)' }}>RPC unavailable</p>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          Could not reach {NETWORK.name}. If you have a pending transaction hash, keep it safe — reconcile before retrying.
        </p>
        {txState.pending?.hash && (
          <a href={buildTxExplorerUrl(CHAIN, txState.pending.hash)} target="_blank" rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--warn)' }}>
            Check pending tx <ExternalLink className="size-3" />
          </a>
        )}
        <button onClick={handleRefresh} className="mt-3 flex items-center gap-1.5 text-sm font-medium" style={{ color: 'var(--accent)' }}>
          <RefreshCw className="size-3.5" /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Pool header ── */}
      <div className="rounded-3xl p-5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="mb-4 flex flex-wrap items-start gap-3">
          <div className="flex-1">
            <h2 className="display text-xl font-semibold" style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}>
              {DEMO_RESOURCE.title}
            </h2>
            <p className="mt-0.5 text-sm" style={{ color: 'var(--muted)' }}>{DEMO_RESOURCE.version}</p>
          </div>
          {pool && (
            <span className="flex-shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold"
              style={{ background: 'var(--surface-muted)', color: statusColor(status) }}>
              {statusLabel(status)}
            </span>
          )}
        </div>

        {pool && (
          <>
            <CostBar price={pool.price} count={pool.count} cap={pool.cap} className="mb-2" />
            <CostBarLegend price={pool.price} count={pool.count} cap={pool.cap} />
            <StatGrid className="mt-4">
              <StatTile label="Provider price" value={`$${fmtUsdc(pool.price, 2)} USDC`} />
              <StatTile label="Members"        value={`${pool.count} / ${pool.cap}`} />
              <StatTile label="Deadline"       value={formatDeadline(pool.deadline)} />
              <StatTile label="Pool ID"        value={cfg.poolId?.toString() ?? '—'} />
            </StatGrid>
          </>
        )}
      </div>

      {/* ── Terms panel (shown when pool is loaded) ── */}
      {pool && (
        <TermsPanel state={termsState} />
      )}

      {/* ── My membership ── */}
      {isConnected && isMember && member && (
        <div className="rounded-3xl p-5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--ink)' }}>My membership</h3>
          <StatGrid>
            <StatTile label="Gross paid"       value={`$${fmtUsdc(member.grossPaid, 6)}`} />
            <StatTile label="Rebate allocated" value={`$${fmtUsdc(member.rebatesAllocated, 6)}`} />
            <StatTile label="Rebate claimed"   value={`$${fmtUsdc(member.rebatesClaimed, 6)}`} />
            <StatTile label="Claimable now"    value={`$${fmtUsdc(claimable, 6)}`} highlight={hasClaimable} />
          </StatGrid>
          <p className="mt-3 text-xs" style={{ color: 'var(--subtle)' }}>
            Net cost including all rebate entitlements:{' '}
            <strong className="tabular-nums">${fmtUsdc(member.grossPaid - member.rebatesAllocated, 6)}</strong>.{' '}
            Rebate allocated is the total credits earned (including already claimed). Claimable is the unclaimed portion.
          </p>

          {/* Delivery panel — gated by artifact classification */}
          <div className="mt-4 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
            {artifactKind === 'real' && (
              <DeliveryPanel
                state={deliveryState}
                onUnlock={handleUnlock}
                onReset={handleDeliveryReset}
              />
            )}
            {artifactKind === 'test' && (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                This is a placeholder test pool. There is no report to unlock.
              </p>
            )}
            {artifactKind === 'unknown' && (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                No delivery is configured for this resource.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Action panel ── */}
      <div className="rounded-3xl p-5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--ink)' }}>
          {canActClaim ? 'Claim your rebate' : isMember ? 'Membership active' : 'Purchase access'}
        </h3>

        {/* Not connected */}
        {!isConnected && (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Connect your wallet above to purchase access or claim rebates.
          </p>
        )}

        {/* Wrong chain */}
        {isConnected && !isRightChain && (
          <div>
            <p className="mb-3 text-sm" style={{ color: 'var(--muted)' }}>Switch to {NETWORK.name} to continue.</p>
            <ActionButton
              label={isSwitching ? 'Switching…' : `Switch to ${NETWORK.name}`}
              phase="idle"
              disabled={isSwitching}
              onClick={() => switchChain({ chainId: CHAIN })}
            />
          </div>
        )}

        {/* Approval done — explicit review gate */}
        {isConnected && isRightChain && phase === 'approval-done' && (
          <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--mint-bg)', border: '1px solid var(--mint-border)' }}>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 flex-shrink-0" style={{ color: 'var(--mint)' }} />
              <p className="text-sm font-medium" style={{ color: 'var(--mint)' }}>USDC approved. Review and confirm your purchase below.</p>
            </div>
            <button onClick={() => dispatch({ type: 'REFRESH' })}
              className="mt-1 flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--mint)' }}>
              <ArrowRight className="size-3" /> Continue to purchase
            </button>
          </div>
        )}

        {/* Wrong wallet — no clear-pending escape; writes blocked */}
        {phase === 'wrong-wallet' && txState.pending && (
          <div className="mb-3 rounded-xl p-3"
            style={{ background: 'rgba(184,106,16,0.07)', border: '1px solid rgba(184,106,16,0.22)' }}>
            <p className="text-sm font-medium" style={{ color: 'var(--warn)' }}>
              A transaction was submitted from a different wallet.
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              Switch back to{' '}
              <span className="font-medium mono">{formatAddress(txState.pending.walletAddress)}</span>{' '}
              to check the result. All writes are blocked until reconciled.
            </p>
            {txUrl && (
              <a href={txUrl} target="_blank" rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--warn)' }}>
                Check on explorer <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        )}

        {/* Right chain — action area */}
        {isConnected && isRightChain && phase !== 'wrong-wallet' && (
          <div className="space-y-3">
            {/* USDC balance */}
            {usdcBalance !== undefined && (
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                USDC balance:{' '}
                <span className="tabular-nums font-medium" style={{ color: 'var(--ink)' }}>${fmtUsdc(usdcBalance, 6)}</span>
              </p>
            )}

            {/* Join quote */}
            {canActJoin && quote && phase !== 'approval-done' && (
              <div className="rounded-xl p-3" style={{ background: 'var(--surface-muted)' }}>
                <p className="text-xs" style={{ color: 'var(--muted)' }}>Your contribution (live quote)</p>
                <p className="mt-0.5 text-2xl font-semibold tabular-nums display"
                  style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}>
                  ${fmtUsdc(quote.contribution, 6)}{' '}
                  <span className="text-base font-normal" style={{ color: 'var(--subtle)' }}>USDC</span>
                </p>
                <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
                  Joining as member {Number(quote.expectedCount) + 1} of {pool?.cap}.
                </p>
              </div>
            )}

            {canActJoin && quoteError && (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>{quoteError}</p>
            )}

            {/* Purchase first */}
            {canActPurchase && pool && phase !== 'approval-done' && (
              <div>
                <div className="mb-3 rounded-xl p-3" style={{ background: 'var(--surface-muted)' }}>
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>First purchase — full price</p>
                  <p className="mt-0.5 text-2xl font-semibold tabular-nums display"
                    style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}>
                    ${fmtUsdc(pool.price, 6)}{' '}
                    <span className="text-base font-normal" style={{ color: 'var(--subtle)' }}>USDC</span>
                  </p>
                  <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
                    Paid directly to the provider. Rebates accrue as others join.
                  </p>
                </div>
                <ActionButton
                  label={NETWORK.isMainnet ? 'Buy access — real USDC' : 'Buy access — first purchase'}
                  phase={phase}
                  disabled={busyNow || termsBlockBuy || (usdcBalance !== undefined && usdcBalance < pool.price)}
                  insufficientBalance={usdcBalance !== undefined && usdcBalance < pool.price}
                  onClick={handlePurchaseFirst}
                />
              </div>
            )}

            {/* Join */}
            {canActJoin && quote && phase !== 'approval-done' && (
              <ActionButton
                label={NETWORK.isMainnet ? 'Join pool — real USDC' : 'Join pool'}
                phase={phase}
                disabled={busyNow || termsBlockBuy || !quote || (usdcBalance !== undefined && usdcBalance < quote.contribution)}
                insufficientBalance={usdcBalance !== undefined && usdcBalance < quote.contribution}
                onClick={handleJoin}
              />
            )}

            {/* Claim */}
            {canActClaim && (
              <ActionButton
                label={`Claim $${fmtUsdc(claimable, 6)} USDC`}
                phase={phase}
                disabled={busyNow}
                onClick={handleClaim}
                variant="mint"
              />
            )}

            {/* Member — no action */}
            {isMember && !hasClaimable && !busyNow && phase === 'idle' && (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                You are a member. Rebates appear here as others join.
              </p>
            )}

            {/* Pool closed/full */}
            {(status === 'full' || status === 'closed') && !isMember && phase === 'idle' && (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                {status === 'full' ? 'This pool is full.' : 'The joining deadline has passed.'}{' '}
                Claims remain available for members.
              </p>
            )}

            {/* Phase feedback */}
            <PhaseFeedback
              txState={txState}
              txUrl={txUrl}
              onRefresh={handleRefresh}
              onReconcile={reconcileHash}
            />
          </div>
        )}
      </div>

      {/* Provider note — network and classification-based */}
      <p className="px-1 text-xs" style={{ color: 'var(--subtle)' }}>
        {poolFootnoteText(NETWORK.isMainnet, NETWORK.name, artifactKind)}{' '}
        {pool && cfg.contractAddress && (
          <>Contract: <span className="mono">{formatAddress(cfg.contractAddress)}</span></>
        )}
      </p>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

/**
 * Pure function returning the provider-note footnote text for a given network
 * and artifact classification. Exported so tests can verify copy without
 * rendering the full component.
 */
export function poolFootnoteText(
  networkIsMainnet: boolean,
  networkName: string,
  artifactKind: string | null,
): string {
  if (networkIsMainnet) {
    return artifactKind === 'real'
      ? `Report is delivered to members after a wallet signature, checked against the chain. Real USDC required on ${networkName}.`
      : `${networkName}: transactions spend real USDC. Membership is recorded onchain.`
  }
  return artifactKind === 'real'
    ? 'Report is delivered to members after a wallet signature, checked against the chain.'
    : artifactKind === 'test'
      ? 'Test pool: no report is attached.'
      : `${networkName}: testnet only, no real funds. Membership is recorded onchain.`
}

function SetupPending({ reason }: { reason: string | null }) {
  return (
    <div className="rounded-3xl p-8 text-center" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl" style={{ background: 'var(--surface-muted)' }}>
        <AlertCircle className="size-5" style={{ color: 'var(--muted)' }} />
      </div>
      <p className="text-base font-semibold" style={{ color: 'var(--ink)' }}>
        {NETWORK.isMainnet ? 'Mainnet setup pending' : 'Testnet setup pending'}
      </p>
      <p className="mt-1 text-sm" style={{ color: 'var(--muted)', maxWidth: '38ch', margin: '4px auto 0' }}>
        {reason ?? 'Contract deployment configuration not yet set.'}
      </p>
      <p className="mt-3 text-xs" style={{ color: 'var(--subtle)' }}>
        The interactive example below still works.
      </p>
    </div>
  )
}

interface ActionButtonProps {
  label:                string
  phase:                TxPhase
  disabled:             boolean
  onClick:              () => void
  insufficientBalance?: boolean
  variant?:             'cobalt' | 'mint'
}

function ActionButton({ label, phase, disabled, onClick, insufficientBalance, variant = 'cobalt' }: ActionButtonProps) {
  const bg = variant === 'mint' ? 'var(--mint)' : 'var(--accent)'

  const content = (() => {
    if (phase === 'preflight')  return <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Checking…</span>
    if (phase === 'approving')  return <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Approving USDC…</span>
    if (phase === 'signing')    return <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Confirm in wallet…</span>
    if (phase === 'confirming') return <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Confirming on chain…</span>
    if (insufficientBalance)    return 'Insufficient USDC balance'
    return label
  })()

  return (
    <button
      disabled={disabled}
      className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-offset-2"
      style={{ background: bg }}
      aria-busy={phase === 'signing' || phase === 'confirming' || phase === 'approving' || phase === 'preflight'}
      onClick={onClick}
    >
      {content}
    </button>
  )
}

interface PhaseFeedbackProps {
  txState:     { phase: TxPhase; errorMsg: string; confirmedHash: `0x${string}` | null; confirmedAction: TxAction | null; confirmedAmount: string | null; pending: import('@/lib/txLifecycle').PendingContext | null }
  txUrl:       string | undefined
  onRefresh:   () => void
  onReconcile: (hash: `0x${string}`) => Promise<void>
}

function PhaseFeedback({ txState, txUrl, onRefresh, onReconcile }: PhaseFeedbackProps) {
  const { phase, errorMsg, confirmedHash, confirmedAction, confirmedAmount } = txState

  if (phase === 'idle' || phase === 'preflight' || phase === 'signing' || phase === 'confirming' || phase === 'approving') {
    return null
  }

  if (phase === 'success') {
    const actionLabel = confirmedAction === 'purchaseFirst' ? 'Purchase confirmed'
      : confirmedAction === 'join' ? 'Joined successfully'
      : 'Rebate claimed'
    const amountLabel = confirmedAmount && confirmedAction !== 'approve'
      ? ` — $${fmtUsdc(BigInt(confirmedAmount), 6)} USDC`
      : ''
    return (
      <div className="rounded-xl p-3" style={{ background: 'var(--mint-bg)', border: '1px solid var(--mint-border)' }}>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 flex-shrink-0" style={{ color: 'var(--mint)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--mint)' }}>
            {actionLabel}{amountLabel}
          </span>
        </div>
        {confirmedHash && (
          <a href={buildTxExplorerUrl(CHAIN, confirmedHash)} target="_blank" rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs" style={{ color: 'var(--mint)' }}>
            View receipt <ExternalLink className="size-3" />
          </a>
        )}
      </div>
    )
  }

  if (phase === 'stale-quote') {
    return (
      <div className="rounded-xl p-3" style={{ background: 'rgba(184,106,16,0.07)', border: '1px solid rgba(184,106,16,0.22)' }}>
        <p className="text-sm font-medium" style={{ color: 'var(--warn)' }}>{errorMsg}</p>
        <button onClick={onRefresh} className="mt-1 flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--warn)' }}>
          <RefreshCw className="size-3" /> Refresh quote
        </button>
      </div>
    )
  }

  if (phase === 'rpc-recovery') {
    return (
      <div className="rounded-xl p-3" style={{ background: 'rgba(184,106,16,0.07)', border: '1px solid rgba(184,106,16,0.22)' }}>
        <p className="text-sm font-medium" style={{ color: 'var(--warn)' }}>{errorMsg || 'Network issue — reconcile before retrying.'}</p>
        {txState.pending?.hash && (
          <a href={buildTxExplorerUrl(CHAIN, txState.pending.hash)} target="_blank" rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs" style={{ color: 'var(--warn)' }}>
            Check tx status <ExternalLink className="size-3" />
          </a>
        )}
        {/* Manual hash reconciliation path */}
        {!txState.pending?.hash && (
          <ReconcileInput onReconcile={onReconcile} />
        )}
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
          Do not submit a new transaction until you have confirmed this one did not land on the explorer.
        </p>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="rounded-xl p-3" style={{ background: 'rgba(184,43,58,0.07)', border: '1px solid rgba(184,43,58,0.22)' }}>
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 size-4 flex-shrink-0" style={{ color: 'var(--danger)' }} />
          <p className="text-sm" style={{ color: 'var(--danger)' }}>{errorMsg}</p>
        </div>
        {txUrl && (
          <a href={txUrl} target="_blank" rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs" style={{ color: 'var(--danger)' }}>
            View on explorer <ExternalLink className="size-3" />
          </a>
        )}
        <button onClick={onRefresh} className="mt-1 flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--danger)' }}>
          <RefreshCw className="size-3" /> Try again
        </button>
      </div>
    )
  }

  return null
}

// ── TermsPanel ─────────────────────────────────────────────────────────────────

function TermsPanel({ state }: { state: TermsState }) {
  const [expanded, setExpanded] = useState(false)

  if (state.status === 'idle') return null

  if (state.status === 'loading') {
    return (
      <div className="rounded-2xl p-3 flex items-center gap-2 text-sm" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
        <Loader2 className="size-4 animate-spin flex-shrink-0" style={{ color: 'var(--muted)' }} />
        <span style={{ color: 'var(--muted)' }}>Verifying terms against chain…</span>
      </div>
    )
  }

  if (state.status === 'verified') {
    return (
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--mint-border)', background: 'var(--mint-bg)' }}>
        <button
          className="w-full flex items-center justify-between gap-2 px-4 py-3 text-sm font-medium"
          style={{ color: 'var(--mint)', background: 'transparent', border: 'none', cursor: 'pointer' }}
          onClick={() => setExpanded(e => !e)}
        >
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4 flex-shrink-0" />
            Terms verified against chain
          </span>
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        {expanded && (
          <pre
            className="px-4 pb-4 text-xs whitespace-pre-wrap break-words leading-relaxed"
            style={{ color: 'var(--ink-2)', fontFamily: 'inherit', margin: 0 }}
          >
            {state.text}
          </pre>
        )}
      </div>
    )
  }

  if (state.status === 'unknown-hash') {
    return (
      <div className="rounded-2xl p-3" style={{ background: 'rgba(184,43,58,0.07)', border: '1px solid rgba(184,43,58,0.22)' }}>
        <p className="text-sm font-medium" style={{ color: 'var(--danger)' }}>
          No verified terms text is available for this pool.
        </p>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Buy and join are disabled until terms can be verified.
        </p>
      </div>
    )
  }

  if (state.status === 'mismatch') {
    return (
      <div className="rounded-2xl p-3" style={{ background: 'rgba(184,43,58,0.07)', border: '1px solid rgba(184,43,58,0.22)' }}>
        <p className="text-sm font-medium" style={{ color: 'var(--danger)' }}>
          Terms hash mismatch — downloaded text does not match on-chain hash.
        </p>
        <p className="mt-1 text-xs font-mono break-all" style={{ color: 'var(--muted)' }}>
          expected {state.expected}<br />got {state.computed}
        </p>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Buy and join are disabled. Do not proceed.
        </p>
      </div>
    )
  }

  // fetch-error
  return (
    <div className="rounded-2xl p-3" style={{ background: 'rgba(184,106,16,0.07)', border: '1px solid rgba(184,106,16,0.22)' }}>
      <p className="text-sm font-medium" style={{ color: 'var(--warn)' }}>
        Could not load terms: {state.status === 'fetch-error' ? state.message : 'Unknown error'}
      </p>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        Buy and join are disabled until terms load successfully.
      </p>
    </div>
  )
}

// ── DeliveryPanel ──────────────────────────────────────────────────────────────

function DeliveryPanel({
  state,
  onUnlock,
  onReset,
}: {
  state:    DeliveryPhase
  onUnlock: () => void
  onReset:  () => void
}) {
  const isWorking = state.status !== 'idle' && state.status !== 'verified' && state.status !== 'error'

  const phaseLabel: Record<string, string> = {
    'checking-membership':  'Checking membership…',
    'requesting-challenge': 'Requesting challenge…',
    'awaiting-signature':   'Waiting for wallet signature…',
    'starting-session':     'Starting session…',
    'downloading':          'Downloading report…',
  }

  return (
    <div>
      <h4 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink)' }}>
        Unlock report
      </h4>
      <p className="mb-3 text-xs" style={{ color: 'var(--muted)' }}>
        Members can download the verified report file. Requires a wallet signature (EOA only; smart-contract wallets not yet supported).
      </p>

      {state.status === 'idle' && (
        <button
          onClick={onUnlock}
          className="flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-semibold"
          style={{ background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', cursor: 'pointer' }}
        >
          <Download className="size-4" />
          Unlock report
        </button>
      )}

      {isWorking && (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
          <Loader2 className="size-4 animate-spin flex-shrink-0" />
          {phaseLabel[state.status] ?? 'Working…'}
        </div>
      )}

      {state.status === 'verified' && (
        <div className="rounded-2xl p-3 space-y-2" style={{ background: 'var(--mint-bg)', border: '1px solid var(--mint-border)' }}>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-4 flex-shrink-0" style={{ color: 'var(--mint)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--mint)' }}>
              File verified — hash matches on-chain artifactHash
            </span>
          </div>
          <a
            href={state.blobUrl}
            download={state.filename}
            className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold"
            style={{ background: 'var(--mint)', color: '#fff', textDecoration: 'none' }}
          >
            <Download className="size-3.5" />
            Download {state.filename}
          </a>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Hash: <span className="font-mono break-all">{state.artifactHash}</span>
          </p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="rounded-2xl p-3 space-y-2" style={{ background: 'rgba(184,43,58,0.07)', border: '1px solid rgba(184,43,58,0.22)' }}>
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 size-4 flex-shrink-0" style={{ color: 'var(--danger)' }} />
            <p className="text-sm" style={{ color: 'var(--danger)' }}>{state.message}</p>
          </div>
          {state.retryable && (
            <button
              onClick={onReset}
              className="flex items-center gap-1 text-xs font-medium"
              style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              <RefreshCw className="size-3" /> Try again
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ReconcileInput({ onReconcile }: { onReconcile: (hash: `0x${string}`) => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const handleSubmit = () => {
    const val = inputRef.current?.value.trim() ?? ''
    if (/^0x[0-9a-fA-F]{64}$/.test(val)) {
      void onReconcile(val as `0x${string}`)
    }
  }
  return (
    <div className="mt-2 flex gap-2">
      <input
        ref={inputRef}
        type="text"
        placeholder="0x… (your wallet transaction hash)"
        className="flex-1 rounded-lg border px-2 py-1 text-xs font-mono"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--ink)' }}
      />
      <button
        onClick={handleSubmit}
        className="rounded-lg px-2 py-1 text-xs font-semibold"
        style={{ background: 'var(--warn)', color: 'white' }}
      >
        Verify
      </button>
    </div>
  )
}
