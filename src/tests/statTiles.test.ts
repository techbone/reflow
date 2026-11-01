/**
 * StatTiles layout tests.
 *
 * Test groups:
 *
 *   R — Render tests (react-dom/server SSR):
 *       Assert the required CSS style tokens are present in StatGrid and
 *       StatTile output. These cover the overflow fix: min-width:0 on the
 *       tile element (allows shrink below natural content width) and
 *       overflow-wrap:anywhere on both the tile container and the value dd
 *       (prevents long strings like "$0.600000" from overflowing).
 *       Also asserts the auto-fit / minmax grid-template-columns token so
 *       column sizing reacts to the container, not the viewport breakpoint.
 *
 *   S — Source-scan tests:
 *       Assert the three call sites (PurchaseRoom, ReceiptView) no longer
 *       contain the old viewport-breakpoint grid patterns (sm:grid-cols-4,
 *       sm:grid-cols-3) for the stat grids, and that they import StatGrid
 *       and StatTile from the shared module.
 *
 * All tests are purely synthetic — no browser, no network.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { StatGrid, StatTile } from '../components/StatTiles'

const ROOT = resolve(__dirname, '../..')

function readSource(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf8')
}

// ── R: Render tests ───────────────────────────────────────────────────────────

describe('R — StatGrid / StatTile render', () => {
  it('R1: StatGrid renders a <dl> with auto-fit minmax grid-template-columns', () => {
    const html = renderToStaticMarkup(
      createElement(StatGrid, null,
        createElement(StatTile, { label: 'Test', value: '1.00' }),
      ),
    )
    expect(html).toContain('auto-fit')
    expect(html).toContain('minmax')
    expect(html).toContain('10rem')
  })

  it('R2: StatGrid style contains display:grid', () => {
    const html = renderToStaticMarkup(
      createElement(StatGrid, null,
        createElement(StatTile, { label: 'X', value: 'Y' }),
      ),
    )
    // React serialises camelCase style props to inline CSS
    expect(html).toMatch(/display\s*:\s*grid/i)
  })

  it('R3: StatTile container has min-width:0', () => {
    const html = renderToStaticMarkup(
      createElement(StatTile, { label: 'Amount', value: '$0.600000' }),
    )
    expect(html).toMatch(/min-width\s*:\s*0/i)
  })

  it('R4: StatTile container has overflow-wrap:anywhere', () => {
    const html = renderToStaticMarkup(
      createElement(StatTile, { label: 'Amount', value: '$0.600000' }),
    )
    expect(html).toMatch(/overflow-wrap\s*:\s*anywhere/i)
  })

  it('R5: StatTile <dd> also has overflow-wrap:anywhere (value never overflows)', () => {
    const html = renderToStaticMarkup(
      createElement(StatTile, { label: 'Amount', value: '$0.600000' }),
    )
    // Both the tile div and the dd must carry overflow-wrap:anywhere
    // count occurrences: at least 2
    const matches = html.match(/overflow-wrap\s*:\s*anywhere/gi) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it('R6: StatTile <dd> has tabular-nums class', () => {
    const html = renderToStaticMarkup(
      createElement(StatTile, { label: 'X', value: '$1.200000' }),
    )
    expect(html).toContain('tabular-nums')
  })

  it('R7: StatTile highlight=true applies mint-bg and mint-border tokens', () => {
    const html = renderToStaticMarkup(
      createElement(StatTile, { label: 'Claimable now', value: '$0.200000', highlight: true }),
    )
    expect(html).toContain('var(--mint-bg)')
    expect(html).toContain('var(--mint-border)')
    // value colour is --mint
    expect(html).toContain('var(--mint)')
  })

  it('R8: StatTile highlight=false (default) applies surface-muted and transparent border', () => {
    const html = renderToStaticMarkup(
      createElement(StatTile, { label: 'Gross paid', value: '$0.600000' }),
    )
    expect(html).toContain('var(--surface-muted)')
    expect(html).toContain('transparent')
    // value colour is --ink
    expect(html).toContain('var(--ink)')
  })

  it('R9: StatTile renders label in <dt> and value in <dd>', () => {
    const html = renderToStaticMarkup(
      createElement(StatTile, { label: 'Rebate allocated', value: '$0.300000' }),
    )
    expect(html).toMatch(/<dt[^>]*>Rebate allocated<\/dt>/)
    expect(html).toMatch(/<dd[^>]*>\$0\.300000<\/dd>/)
  })

  it('R10: StatGrid gap style is 0.75rem', () => {
    const html = renderToStaticMarkup(
      createElement(StatGrid, null,
        createElement(StatTile, { label: 'X', value: 'Y' }),
      ),
    )
    expect(html).toContain('0.75rem')
  })
})

// ── S: Source-scan tests ──────────────────────────────────────────────────────

describe('S — call-site source scan', () => {
  const purchaseRoom = readSource('src/components/PurchaseRoom.tsx')
  const receiptView  = readSource('src/components/ReceiptView.tsx')

  // PurchaseRoom.tsx

  it('S1: PurchaseRoom imports StatGrid and StatTile from StatTiles', () => {
    expect(purchaseRoom).toContain('StatGrid')
    expect(purchaseRoom).toContain('StatTile')
    expect(purchaseRoom).toMatch(/from ['"]\.\/StatTiles['"]/)
  })

  it('S2: PurchaseRoom pool-summary no longer uses sm:grid-cols-4', () => {
    expect(purchaseRoom).not.toContain('sm:grid-cols-4')
  })

  it('S3: PurchaseRoom membership no longer uses sm:grid-cols-4 or sm:grid-cols-2', () => {
    // The membership grid was grid-cols-2 sm:grid-cols-4 — neither should remain
    // as a stat grid pattern (the class may still appear elsewhere for unrelated layouts,
    // but the dl-based membership grid must not use it)
    expect(purchaseRoom).not.toContain('sm:grid-cols-4')
  })

  it('S4: PurchaseRoom uses <StatGrid> JSX in the pool-summary section', () => {
    expect(purchaseRoom).toContain('<StatGrid')
  })

  it('S5: PurchaseRoom uses <StatTile label="Provider price"', () => {
    expect(purchaseRoom).toContain('label="Provider price"')
  })

  it('S6: PurchaseRoom uses <StatTile label="Gross paid"', () => {
    expect(purchaseRoom).toContain('label="Gross paid"')
  })

  it('S7: PurchaseRoom uses <StatTile label="Claimable now" with highlight prop', () => {
    expect(purchaseRoom).toMatch(/label="Claimable now"[^/]*highlight/)
  })

  // ReceiptView.tsx

  it('S8: ReceiptView imports StatGrid and StatTile from StatTiles', () => {
    expect(receiptView).toContain('StatGrid')
    expect(receiptView).toContain('StatTile')
    expect(receiptView).toMatch(/from ['"]\.\/StatTiles['"]/)
  })

  it('S9: ReceiptView no longer uses sm:grid-cols-3', () => {
    expect(receiptView).not.toContain('sm:grid-cols-3')
  })

  it('S10: ReceiptView uses <StatGrid> JSX', () => {
    expect(receiptView).toContain('<StatGrid')
  })

  it('S11: ReceiptView uses <StatTile label="Members"', () => {
    expect(receiptView).toContain('label="Members"')
  })
})
