/**
 * ResourceCard — featured resource summary for the Explore view.
 *
 * Badge logic (based on pool.artifactHash):
 *   'real'    → show headline preview numbers + manifest facts
 *   'test'    → show red TEST badge (placeholder content)
 *   'unknown' → show neutral "Unrecognised resource" note
 *   no pool   → show pending state
 *
 * NEVER show real preview data next to a test-pool artifactHash.
 */

import { useState, useEffect } from 'react'
import { FileText, Lock, Users, Calendar, AlertCircle, FlaskConical, HelpCircle } from 'lucide-react'
import { DEMO_RESOURCE, REFLOW_CONFIG, NETWORK } from '@/lib/reflowConfig'
import { fmtUsdc } from '@/lib/shareCalc'
import { statusLabel, statusColor, formatDeadline, derivePoolStatus } from '@/lib/poolState'
import { useReflowPool } from '@/hooks/useReflowPool'
import {
  classifyArtifact,
  REPORTS,
  type ReportManifest,
  type ReportPreview,
} from '@/lib/reportManifest'

interface ResourceCardProps { nowSec: number }

export function ResourceCard({ nowSec }: ResourceCardProps) {
  const { pool, isLoading } = useReflowPool()
  const status = pool
    ? derivePoolStatus(pool, nowSec)
    : (isLoading ? 'loading' : 'not-configured')

  const artifactKind = pool ? classifyArtifact(pool.artifactHash, NETWORK.key) : null

  // Load manifest + preview only for the real report
  const [manifest, setManifest] = useState<ReportManifest | null>(null)
  const [preview,  setPreview]  = useState<ReportPreview | null>(null)

  useEffect(() => {
    if (artifactKind !== 'real') return
    // Fire-and-forget; if these fail we just don't show the extra data
    let active = true
    const report = REPORTS[NETWORK.key]
    if (!report) return
    void fetch(report.manifestPath).then(r => r.ok ? r.json() : null).then(d => { if (active) setManifest(d as ReportManifest | null) })
    void fetch(report.previewPath).then(r => r.ok ? r.json() : null).then(d => { if (active) setPreview(d as ReportPreview | null) })
    return () => { active = false }
  }, [artifactKind])

  return (
    <div
      className="overflow-hidden rounded-3xl"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      {/* ── Top badge ── */}
      {artifactKind === 'test' && (
        <div
          className="flex items-center gap-2 border-b px-5 py-3"
          style={{ borderColor: '#fca5a5', background: '#fee2e2' }}
        >
          <FlaskConical className="size-3.5 shrink-0" style={{ color: '#dc2626' }} />
          <span className="text-xs font-semibold" style={{ color: '#991b1b' }}>
            Test pool — placeholder content, not the real report
          </span>
        </div>
      )}

      {artifactKind === 'real' && preview && (
        <div
          className="border-b px-5 py-3"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
        >
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)', letterSpacing: '0.06em' }}>
            Free preview
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {preview.headline.map((h: { label: string; value: string }) => (
              <div key={h.label} className="text-xs">
                <span style={{ color: 'var(--muted)' }}>{h.label}: </span>
                <span className="tabular-nums font-semibold" style={{ color: 'var(--ink)' }}>{h.value}</span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-xs" style={{ color: 'var(--subtle)' }}>{preview.notice}</p>
        </div>
      )}

      {artifactKind === 'real' && !preview && (
        <div
          className="flex items-center gap-2 border-b px-5 py-3"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
        >
          <FileText className="size-3.5" style={{ color: 'var(--muted)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
            Real report — loading preview…
          </span>
        </div>
      )}

      {artifactKind === 'unknown' && (
        <div
          className="flex items-center gap-2 border-b px-5 py-3"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
        >
          <HelpCircle className="size-3.5" style={{ color: 'var(--muted)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
            Unrecognised resource — artifact hash does not match any known report
          </span>
        </div>
      )}

      {!pool && (
        <div
          className="flex items-center gap-2 border-b px-5 py-3"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
        >
          <AlertCircle className="size-3.5" style={{ color: 'var(--muted)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
            {isLoading ? `Loading pool from ${NETWORK.name}…` : `No pool is configured on ${NETWORK.name} yet`}
          </span>
        </div>
      )}

      <div className="p-5">
        {/* Title row */}
        <div className="mb-4 flex items-start gap-3">
          <div
            className="flex size-11 flex-shrink-0 items-center justify-center rounded-2xl"
            style={{ background: 'rgba(26,80,200,0.08)' }}
          >
            <FileText className="size-5" style={{ color: 'var(--accent)' }} />
          </div>
          <div>
            <h2
              className="display text-xl font-semibold"
              style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}
            >
              {DEMO_RESOURCE.title}
            </h2>
            <span className="text-sm" style={{ color: 'var(--muted)' }}>
              {DEMO_RESOURCE.version}
            </span>
          </div>
        </div>

        {/* Description — classification-driven */}
        <p className="mb-5 text-sm leading-relaxed" style={{ color: 'var(--ink-2)', maxWidth: '60ch' }}>
          {artifactKind === 'real'
            ? (manifest?.description ?? DEMO_RESOURCE.description)
            : artifactKind === 'test'
              ? `Placeholder content for testing the Reflow flow on ${NETWORK.name}. Not the Arc activity report.`
              : artifactKind === 'unknown'
                ? 'Resource details are not available for this pool.'
                : DEMO_RESOURCE.description
          }
        </p>

        {/* Manifest facts (real pool only) */}
        {artifactKind === 'real' && manifest && (
          <div
            className="mb-4 rounded-2xl p-3 text-xs"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
          >
            <p className="mb-2 font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)', letterSpacing: '0.06em' }}>
              Report facts
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <span style={{ color: 'var(--muted)' }}>Block range</span>
              <span className="tabular-nums" style={{ color: 'var(--ink)' }}>
                {manifest.source?.fromBlock?.toLocaleString() ?? '?'}–{manifest.source?.toBlock?.toLocaleString() ?? '?'}
              </span>
              <span style={{ color: 'var(--muted)' }}>Version</span>
              <span style={{ color: 'var(--ink)' }}>{manifest.version}</span>
              <span style={{ color: 'var(--muted)' }}>Artifact size</span>
              <span className="tabular-nums" style={{ color: 'var(--ink)' }}>
                {(manifest.artifact?.bytes ?? manifest.artifact?.size ?? 0).toLocaleString()} bytes
              </span>
              <span style={{ color: 'var(--muted)' }}>Period</span>
              <span style={{ color: 'var(--ink)' }}>
                {manifest.source?.fromUtc?.slice(0, 10) ?? '?'} → {manifest.source?.toUtc?.slice(0, 10) ?? '?'}
              </span>
            </div>
          </div>
        )}

        {/* Metadata grid */}
        <dl className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <MetaItem
            icon={<Lock className="size-3.5" />}
            label="Provider price"
            value={pool ? `$${fmtUsdc(pool.price, 2)} USDC` : isLoading ? '…' : '—'}
          />
          <MetaItem
            icon={<Users className="size-3.5" />}
            label="Cohort"
            value={
              pool
                ? `${pool.count} joined, ${pool.cap - pool.count} open (max ${pool.cap})`
                : isLoading ? '…' : 'Pending deployment'
            }
          />
          <MetaItem
            icon={<Calendar className="size-3.5" />}
            label="Joining deadline"
            value={pool ? formatDeadline(pool.deadline) : isLoading ? '…' : '—'}
          />
          <MetaItem
            icon={<FileText className="size-3.5" />}
            label="Pool status"
            value={statusLabel(status)}
            valueColor={statusColor(status)}
          />
        </dl>

        {/* License terms section — shown for real and test pools only */}
        {(artifactKind === 'real' || artifactKind === 'test') && (
          <div
            className="rounded-2xl p-4"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
          >
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)', letterSpacing: '0.07em' }}>
              License &amp; sharing terms
            </h4>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-2)', maxWidth: '58ch' }}>
              {artifactKind === 'real'
                ? 'Single-cohort license: each pool member may use the report for personal or internal review. Redistribution outside the cohort is not permitted under V1 terms. Terms are verified onchain before purchase.'
                : `Placeholder test terms for ${NETWORK.name} flow testing. Verified against the test-pool termsHash onchain before purchase.`
              }
            </p>
          </div>
        )}

        {/* Contract reference */}
        {REFLOW_CONFIG.isConfigured && REFLOW_CONFIG.contractAddress && (
          <p className="mt-3 text-xs" style={{ color: 'var(--subtle)' }}>
            Pool {REFLOW_CONFIG.poolId?.toString()} on ReflowPools contract{' '}
            <span className="mono">{REFLOW_CONFIG.contractAddress.slice(0, 8)}…</span> ({NETWORK.name})
          </p>
        )}
        {!REFLOW_CONFIG.isConfigured && (
          <p className="mt-3 text-xs" style={{ color: 'var(--subtle)' }}>
            Contract not yet deployed. Pool terms will be immutable once set.
          </p>
        )}
      </div>
    </div>
  )
}

interface MetaItemProps {
  icon:        React.ReactNode
  label:       string
  value:       string
  valueColor?: string
}

function MetaItem({ icon, label, value, valueColor }: MetaItemProps) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 flex-shrink-0" style={{ color: 'var(--muted)' }}>{icon}</span>
      <div>
        <dt className="text-xs" style={{ color: 'var(--muted)' }}>{label}</dt>
        <dd className="text-sm font-medium tabular-nums" style={{ color: valueColor ?? 'var(--ink)' }}>{value}</dd>
      </div>
    </div>
  )
}
