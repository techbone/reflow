/**
 * CostBar — the signature Reflow visual.
 * A horizontal bar divided into equal segments, one per participant.
 * Segments animate into view as the count grows (respects reduced motion).
 */

import { motion, useReducedMotion } from 'framer-motion'
import { shareOf, fmtUsdc } from '@/lib/shareCalc'

interface CostBarProps {
  price: bigint
  count: number     // current number of members
  cap:   number     // maximum members
  /** Highlight the newest segment (last joined) */
  highlightLast?: boolean
  className?: string
}

// Colour palette for each participant segment (index 0-15)
const SEGMENT_COLORS = [
  '#1a50c8', // cobalt — first buyer
  '#2d6ad4',
  '#4080dc',
  '#5496e4',
  '#68ace8',
  '#7cbcec',
  '#90c8ee',
  '#1a7a58', // mint shift for later members
  '#268a68',
  '#329a78',
  '#3eaa88',
  '#4aba98',
  '#56c8a8',
  '#62d0b4',
  '#6ed8be',
  '#7ae0c8',
]

export function CostBar({ price, count, cap, highlightLast = false, className }: CostBarProps) {
  const prefersReducedMotion = useReducedMotion()

  if (count === 0 || price === 0n) {
    // Empty state — show placeholder bar
    return (
      <div className={`overflow-hidden rounded-full ${className ?? ''}`} style={{ height: 12, background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
        <div className="h-full w-0" />
      </div>
    )
  }

  const segments = Array.from({ length: count }, (_, i) => {
    const raw = shareOf(price, BigInt(count), BigInt(i))
    const pct = Number((raw * 10000n) / price) / 100
    return { i, pct, raw, color: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }
  })

  // Open slots are shown as a separate slot alongside the member segments,
  // each slot getting an equal 1/cap share of the bar width. This ensures
  // member segments are never obscured by a cap-remainder overlay.
  const totalSlots = cap
  const slotPct = 100 / totalSlots

  return (
    <div className={`overflow-hidden rounded-full ${className ?? ''}`} style={{ height: 14, background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
      <div className="flex h-full w-full">
        {/* Filled member segments */}
        {segments.map(({ i, raw, color }, idx) => {
          const isLast = highlightLast && idx === segments.length - 1
          return (
            <motion.div
              key={i}
              title={`Participant ${i + 1}: $${fmtUsdc(raw, 2)} USDC net`}
              style={{
                transformOrigin: 'left',
                width: `${slotPct}%`,
                background: color,
                opacity: isLast ? 1 : 0.85,
                outline: isLast ? '2px solid rgba(255,255,255,0.8)' : 'none',
                outlineOffset: -2,
              }}
              initial={prefersReducedMotion ? { opacity: 0.85 } : { scaleX: 0 }}
              animate={prefersReducedMotion ? { opacity: isLast ? 1 : 0.85 } : { scaleX: 1 }}
              transition={prefersReducedMotion ? undefined : {
                duration: 0.4,
                delay: i * 0.06,
                ease: [0.25, 0.46, 0.45, 0.94],
              }}
              className="h-full"
            />
          )
        })}
        {/* Open slots — unfilled, shown as surface-muted gaps */}
        {Array.from({ length: cap - count }, (_, k) => (
          <div
            key={`open-${k}`}
            title="Open slot"
            style={{
              width: `${slotPct}%`,
              background: 'var(--surface-muted)',
              borderLeft: '1px solid var(--border)',
            }}
            className="h-full"
          />
        ))}
      </div>
    </div>
  )
}

interface CostBarLegendProps {
  price:  bigint
  count:  number
  cap:    number
}

export function CostBarLegend({ price, count, cap }: CostBarLegendProps) {
  if (count === 0) return null

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--muted)' }}>
      {Array.from({ length: count }, (_, i) => {
        const share = shareOf(price, BigInt(count), BigInt(i))
        return (
          <span key={i} className="flex items-center gap-1">
            <span
              className="inline-block size-2 rounded-sm flex-shrink-0"
              style={{ background: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }}
            />
            <span className="tabular-nums">
              {i === 0 ? 'First' : `+${i}`} — ${fmtUsdc(share, 2)}
            </span>
          </span>
        )
      })}
      {count < cap && (
        <span className="flex items-center gap-1" style={{ color: 'var(--subtle)' }}>
          <span className="inline-block size-2 rounded-sm flex-shrink-0" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }} />
          {cap - count} open slot{cap - count !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  )
}
