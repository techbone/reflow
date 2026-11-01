/**
 * StatTiles — shared container-responsive stat-tile layout.
 *
 * Uses CSS intrinsic sizing (`repeat(auto-fit, minmax(min(100%, 10rem), 1fr))`)
 * so columns respond to the CONTAINER width, not the viewport breakpoint.
 * This prevents tiles from overflowing when the grid sits inside a narrow card.
 *
 * Each StatTile:
 *  - sets min-width: 0 so it can shrink below its content's natural width
 *  - sets overflow-wrap: anywhere so long values (e.g. "$0.600000") break
 *    within the tile instead of overflowing its right edge
 *  - preserves tabular-nums for aligned digits
 *
 * Usage:
 *   <StatGrid>
 *     <StatTile label="Gross paid" value="$0.600000" />
 *     <StatTile label="Claimable now" value="$0.200000" highlight />
 *   </StatGrid>
 */

import type { CSSProperties, ReactNode } from 'react'

// ── StatGrid ──────────────────────────────────────────────────────────────────

const GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 10rem), 1fr))',
  gap: '0.75rem', // gap-3
}

interface StatGridProps {
  children: ReactNode
  className?: string
  style?: CSSProperties
}

export function StatGrid({ children, className, style }: StatGridProps) {
  return (
    <dl
      className={className}
      style={{ ...GRID_STYLE, ...style }}
    >
      {children}
    </dl>
  )
}

// ── StatTile ──────────────────────────────────────────────────────────────────

interface StatTileProps {
  label:       string
  value:       string
  /** When true, renders with mint background/border and mint-coloured value. */
  highlight?:  boolean
  /** Override the value colour (ignored when highlight is true). */
  valueColor?: string
  /** Extra per-tile class names. */
  className?:  string
}

const TILE_BASE: CSSProperties = {
  minWidth: 0,
  overflowWrap: 'anywhere',
}

export function StatTile({ label, value, highlight, valueColor, className }: StatTileProps) {
  const bg     = highlight ? 'var(--mint-bg)'     : 'var(--surface-muted)'
  const border = highlight ? '1px solid var(--mint-border)' : '1px solid transparent'
  const color  = highlight ? 'var(--mint)'        : (valueColor ?? 'var(--ink)')

  return (
    <div
      className={`rounded-xl p-3 ${className ?? ''}`}
      style={{ ...TILE_BASE, background: bg, border }}
    >
      <dt className="text-xs" style={{ color: 'var(--muted)' }}>{label}</dt>
      <dd
        className="mt-0.5 text-sm font-semibold tabular-nums"
        style={{ color, minWidth: 0, overflowWrap: 'anywhere' }}
      >
        {value}
      </dd>
    </div>
  )
}
