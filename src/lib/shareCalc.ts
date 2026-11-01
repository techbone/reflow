/**
 * Pure share arithmetic matching the contract formula exactly.
 * shareOf(C, n, i) = floor(C/n) + (i < C%n ? 1 : 0)
 *
 * All values are bigint micro-USDC (6 decimals). No floating-point arithmetic
 * on money paths. Formatting helpers for display only.
 */

import { USDC_DECIMALS } from '@/onchain-facts'

/** Participant i's target net contribution when there are n members and price is C (micro-USDC). */
export function shareOf(C: bigint, n: bigint, i: bigint): bigint {
  if (n === 0n) throw new RangeError('shareOf: n must be > 0')
  const q = C / n
  const r = C % n
  return i < r ? q + 1n : q
}

/**
 * The contribution a new participant pays when joining as member n (0-based index = n-1).
 * i.e. the arriving payment when the count grows from currentCount to currentCount+1.
 * newCount = currentCount + 1; arriving index = currentCount (0-based).
 */
export function arrivalShare(C: bigint, newCount: bigint): bigint {
  return shareOf(C, newCount, newCount - 1n)
}

/** Credit allocated to existing member i when count grows from oldCount to newCount. */
export function rebateDelta(C: bigint, oldCount: bigint, newCount: bigint, i: bigint): bigint {
  return shareOf(C, oldCount, i) - shareOf(C, newCount, i)
}

/** All per-member credits issued when a new participant joins (sum == arriving payment). */
export function allRebateDeltas(C: bigint, oldCount: bigint): bigint[] {
  const newCount = oldCount + 1n
  const result: bigint[] = []
  for (let i = 0n; i < oldCount; i++) {
    result.push(rebateDelta(C, oldCount, newCount, i))
  }
  return result
}

/** USDC_DECIMALS = 6 */
const DEC = USDC_DECIMALS

/** Format micro-USDC bigint to a display string with exactly `places` decimal digits. */
export function fmtUsdc(raw: bigint, places = 2): string {
  const abs = raw < 0n ? -raw : raw
  const sign = raw < 0n ? '-' : ''
  const str = abs.toString().padStart(DEC + 1, '0')
  const whole    = str.slice(0, str.length - DEC)
  const fraction = str.slice(str.length - DEC)
  const trimmed  = places === 0 ? '' : '.' + fraction.slice(0, places)
  return `${sign}${whole}${trimmed}`
}

/** Format as "$X.XX USDC" */
export function fmtUsdcDisplay(raw: bigint): string {
  return `$${fmtUsdc(raw, 2)} USDC`
}

/**
 * Parse a display string like "1.20" to micro-USDC bigint.
 * Delegates to parseUsdc from onchain-money which rejects over-precision
 * (more than 6 decimal places) rather than silently truncating.
 */
export { parseUsdc as parseUsdcStr } from '@/onchain-money'

/** Snapshot of the share table for up to n participants. */
export interface ShareTableRow {
  index: number
  label: string
  grossPaid: bigint
  targetNetCost: bigint
  totalRebate: bigint
}

export function buildShareTable(C: bigint, n: number): ShareTableRow[] {
  const rows: ShareTableRow[] = []
  for (let i = 0; i < n; i++) {
    const grossPaid = i === 0
      ? C
      : arrivalShare(C, BigInt(i + 1))
    const targetNetCost = shareOf(C, BigInt(n), BigInt(i))
    rows.push({
      index: i,
      label: `Participant ${i + 1}`,
      grossPaid,
      targetNetCost,
      totalRebate: grossPaid - targetNetCost,
    })
  }
  return rows
}
