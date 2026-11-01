/**
 * ReceiptView — public receipt and reconciliation.
 *
 * Fetches actual on-chain events when a contract is configured and fromBlock is set.
 * Displays: FirstPurchased, Joined, RebateCredited, RebateClaimed with real tx links.
 * Shows poolLiability for the selected pool separately from totalLiability.
 *
 * An explicitly labelled illustrative example shows the $1.20/$0.60/$0.40/$0.30
 * progression and is never presented as live activity.
 *
 * Rules:
 *  - No fake explorer links
 *  - RPC failure shows incomplete/error state, never empty fake history
 *  - Does not fetch USDC Transfer logs (would double-count native + ERC-20)
 *  - VITE_REFLOW_FROM_BLOCK missing disables the indexer, not defaulted to 0
 */

import { AlertCircle, ExternalLink, RefreshCw, Loader2 } from 'lucide-react'
import { StatGrid, StatTile } from './StatTiles'
import { fmtUsdc } from '@/lib/shareCalc'
import { REFLOW_CONFIG, NETWORK } from '@/lib/reflowConfig'
import { buildAddressExplorerUrl, buildTxExplorerUrl } from '@/onchain-facts'
import { useReflowPool } from '@/hooks/useReflowPool'
import { useEventIndexer, type ReflowEvent } from '@/hooks/useEventIndexer'
import { formatAddress } from '@/lib/poolState'

// The illustrative progression — exact integer arithmetic, never presented as live data
const ILLUSTRATIVE_STEPS = [
  { event: 'First purchase', participant: 'A', grossPaid: 1_200_000n, aNetSoFar: 1_200_000n, note: 'A pays the full $1.20 to the provider. Pool starts.' },
  { event: 'B joins',        participant: 'B', grossPaid:   600_000n, aNetSoFar:   600_000n, note: 'B pays $0.60. A is credited $0.60.' },
  { event: 'C joins',        participant: 'C', grossPaid:   400_000n, aNetSoFar:   400_000n, note: 'C pays $0.40. A and B each credited $0.20.' },
  { event: 'D joins',        participant: 'D', grossPaid:   300_000n, aNetSoFar:   300_000n, note: 'D pays $0.30. All credited. Net: A=B=C=D=$0.30.' },
]
const PARTICIPANT_COLORS = ['#1a50c8','#2d6ad4','#5496e4','#1a7a58']

function EventRow({ ev }: { ev: ReflowEvent }) {
  const txUrl = buildTxExplorerUrl(NETWORK.chainId, ev.txHash)
  let typeLabel = ev.type as string
  let who = ''
  let amountRaw: bigint | undefined

  if (ev.type === 'FirstPurchased')   { typeLabel = 'First purchase';   who = formatAddress(ev.buyer ?? ''); amountRaw = ev.amount }
  else if (ev.type === 'Joined')      { typeLabel = 'Joined';           who = formatAddress(ev.participant ?? ''); amountRaw = ev.contribution }
  else if (ev.type === 'RebateCredited') { typeLabel = 'Rebate credited'; who = formatAddress(ev.creditParticipant ?? ''); amountRaw = ev.amount }
  else if (ev.type === 'RebateClaimed')  { typeLabel = 'Rebate claimed';  who = formatAddress(ev.beneficiary ?? ''); amountRaw = ev.amount }

  return (
    <tr style={{ borderTop: '1px solid var(--border)' }}>
      <td className="py-2.5 pr-4 text-xs font-medium" style={{ color: 'var(--ink)', whiteSpace: 'nowrap' }}>{typeLabel}</td>
      <td className="py-2.5 pr-4 text-xs mono" style={{ color: 'var(--muted)' }}>{who}</td>
      <td className="py-2.5 pr-4 text-xs tabular-nums" style={{ color: 'var(--ink)' }}>
        {amountRaw !== undefined ? `$${fmtUsdc(amountRaw, 6)}` : '—'}
      </td>
      <td className="py-2.5 text-xs">
        <a href={txUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1" style={{ color: 'var(--accent)' }}>
          {ev.txHash.slice(0, 10)}… <ExternalLink className="size-3" />
        </a>
      </td>
    </tr>
  )
}

export function ReceiptView() {
  const cfg = REFLOW_CONFIG
  const { pool, totalLiability, isLoading } = useReflowPool()
  const { status: idxStatus, events, scannedTo, chainHead, blocksRemaining, poolLiability, errorMsg, rescan } = useEventIndexer()

  const isConfigured = cfg.isConfigured

  return (
    <div className="space-y-6">
      <div>
        <h2 className="display mb-1 text-2xl font-semibold" style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}>
          Receipt &amp; reconciliation
        </h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          {`Public pool activity read from ${NETWORK.name}.`}
          {!isConfigured && ' Contract not yet configured — live data unavailable.'}
        </p>
      </div>

      {/* Live pool state */}
      {isConfigured ? (
        <div className="rounded-3xl p-5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--ink)' }}>Live pool state</h3>
          {isLoading && <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading from chain…</p>}
          {pool && !isLoading && (
            <>
              <StatGrid>
                <StatTile label="Members"                 value={`${pool.count} / ${pool.cap}`} />
                <StatTile label="Pool liability"          value={poolLiability != null ? `$${fmtUsdc(poolLiability, 2)} USDC` : (totalLiability != null ? `$${fmtUsdc(totalLiability, 2)} USDC` : '—')} />
                <StatTile label="Total contract liability" value={totalLiability != null ? `$${fmtUsdc(totalLiability, 2)} USDC` : '—'} />
              </StatGrid>
              <p className="mt-2 text-xs" style={{ color: 'var(--subtle)' }}>
                Pool liability = outstanding rebate credits for this pool.
                Total contract liability = all outstanding credits across all pools.
              </p>
            </>
          )}
          {cfg.contractAddress && (
            <a href={buildAddressExplorerUrl(NETWORK.chainId, cfg.contractAddress)} target="_blank" rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--accent)' }}>
              View contract on the Arc explorer <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      ) : (
        <div className="rounded-3xl p-5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 size-4 flex-shrink-0" style={{ color: 'var(--muted)' }} />
            <div>
              <p className="text-sm font-medium" style={{ color: 'var(--ink)' }}>Contract not yet deployed</p>
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                Live receipts will appear here once the contract and pool are configured.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Event history */}
      {isConfigured && (
        <div className="rounded-3xl p-5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              Pool event history
              {cfg.fromBlock == null && (
                <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>
                  (VITE_REFLOW_FROM_BLOCK not set — history disabled)
                </span>
              )}
            </h3>
            {cfg.fromBlock != null && (
              <button onClick={rescan} disabled={idxStatus === 'scanning'}
                className="flex items-center gap-1 text-xs font-medium disabled:opacity-40"
                style={{ color: 'var(--accent)' }}>
                <RefreshCw className={`size-3 ${idxStatus === 'scanning' ? 'animate-spin' : ''}`} />
                {idxStatus === 'scanning' ? 'Scanning…' : 'Rescan'}
              </button>
            )}
          </div>

          {/* Coverage bar */}
          {cfg.fromBlock != null && idxStatus !== 'idle' && (
            <div className="mb-3">
              {idxStatus === 'scanning' && (
                <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                  <Loader2 className="size-3 animate-spin" />
                  <span>
                    Scanning block {scannedTo?.toString() ?? '…'}
                    {chainHead ? ` of ${chainHead.toString()}` : ''}
                    {blocksRemaining !== null && blocksRemaining > 0n ? ` (${blocksRemaining.toString()} remaining)` : null}
                  </span>
                </div>
              )}
              {idxStatus === 'complete' && (
                <p className="text-xs" style={{ color: 'var(--subtle)' }}>
                  Scanned to block {scannedTo?.toString() ?? '?'} (chain head: {chainHead?.toString() ?? '?'}). {events.length} event{events.length !== 1 ? 's' : ''} found.
                </p>
              )}
              {idxStatus === 'error' && (
                <div className="flex items-start gap-2 rounded-xl p-3" style={{ background: 'rgba(184,43,58,0.07)', border: '1px solid rgba(184,43,58,0.22)' }}>
                  <AlertCircle className="mt-0.5 size-3.5 flex-shrink-0" style={{ color: 'var(--danger)' }} />
                  <p className="text-xs" style={{ color: 'var(--danger)' }}>
                    Event scan failed: {errorMsg ?? 'RPC error'}. History may be incomplete.
                  </p>
                </div>
              )}
            </div>
          )}

          {cfg.fromBlock != null && events.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
                <thead>
                  <tr style={{ color: 'var(--muted)' }}>
                    {['Event', 'Address', 'Amount', 'Transaction'].map((h, i) => (
                      <th key={h} className="pb-2 text-left text-xs font-medium" style={{ paddingRight: i < 3 ? '1rem' : 0, whiteSpace: 'nowrap' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {events.map(ev => (
                    <EventRow key={`${ev.txHash}:${ev.logIndex}`} ev={ev} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {cfg.fromBlock != null && events.length === 0 && idxStatus === 'complete' && (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>No events found in the scanned range.</p>
          )}

          {cfg.fromBlock == null && (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              Set <span className="mono">VITE_REFLOW_FROM_BLOCK</span> to the deployment block to enable live event history.
            </p>
          )}
        </div>
      )}

      {/* Illustrative example — explicitly labelled, never live data */}
      <div className="rounded-3xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2 border-b px-5 py-3" style={{ borderColor: 'var(--border)', background: 'rgba(26,80,200,0.04)' }}>
          <AlertCircle className="size-3.5" style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            Illustrative example — not real payments or customer activity
          </span>
        </div>
        <div className="p-5">
          <p className="mb-4 text-sm" style={{ color: 'var(--muted)', maxWidth: '52ch' }}>
            How the $1.20 price splits across four participants A, B, C, D. All figures use exact integer arithmetic.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr style={{ color: 'var(--muted)' }}>
                  {['Event', 'Participant', 'Gross paid', "A's net so far", 'Note'].map((h, i) => (
                    <th key={h} className="pb-2 text-left text-xs font-medium" style={{ paddingRight: i < 4 ? '1.5rem' : 0, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ILLUSTRATIVE_STEPS.map((step, idx) => (
                  <tr key={idx} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="py-2.5 pr-6 font-medium text-xs" style={{ color: 'var(--ink)' }}>{step.event}</td>
                    <td className="py-2.5 pr-6">
                      <span className="inline-flex size-6 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: PARTICIPANT_COLORS[idx] }}>
                        {step.participant}
                      </span>
                    </td>
                    <td className="py-2.5 pr-6 tabular-nums text-xs" style={{ color: 'var(--ink)' }}>${fmtUsdc(step.grossPaid, 2)}</td>
                    <td className="py-2.5 pr-6 tabular-nums text-xs font-medium" style={{ color: 'var(--mint)' }}>${fmtUsdc(step.aNetSoFar, 2)}</td>
                    <td className="py-2.5 text-xs" style={{ color: 'var(--muted)', maxWidth: '24ch' }}>{step.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs" style={{ color: 'var(--subtle)' }}>
            A&apos;s gross paid was $1.20. Rebate entitlements are not received cash until <code className="mono">claimFor</code> succeeds.
            These rows represent no actual wallets, transactions, or deployed pool.
          </p>
        </div>
      </div>
    </div>
  )
}
