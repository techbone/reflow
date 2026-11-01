/**
 * Interactive "See how sharing works" example.
 * Uses integer bigint arithmetic matching the contract formula exactly.
 * Named participants A/B/C/D. Explicitly labelled as an example throughout.
 * No transaction hashes, wallet addresses, or success notifications.
 * Example state is entirely separate from any live contract client.
 */

import { useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Info, ChevronRight } from 'lucide-react'
import { shareOf, fmtUsdc, arrivalShare } from '@/lib/shareCalc'
import { CostBar, CostBarLegend } from './CostBar'

/** Demo price: 1.20 USDC = 1_200_000 micro-USDC */
const DEMO_PRICE = 1_200_000n

const NAMES = ['A', 'B', 'C', 'D']
const COLORS = ['#1a50c8', '#2d6ad4', '#5496e4', '#1a7a58']

interface ParticipantRowProps {
  name:      string
  color:     string
  index:     number
  totalN:    number
  price:     bigint
  isNew?:    boolean
}

function ParticipantRow({ name, color, index, totalN, price, isNew }: ParticipantRowProps) {
  const prefersReducedMotion = useReducedMotion()

  const grossPaid = index === 0
    ? price
    : arrivalShare(price, BigInt(index + 1))
  const targetNet = shareOf(price, BigInt(totalN), BigInt(index))
  const rebate    = grossPaid - targetNet

  return (
    <motion.div
      layout
      initial={isNew && !prefersReducedMotion ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.25 }}
      className="grid items-center gap-2 rounded-xl px-3 py-2.5"
      style={{
        gridTemplateColumns: '2rem 1fr 1fr 1fr',
        background: isNew ? 'rgba(26,80,200,0.05)' : 'transparent',
        border: isNew ? '1px solid rgba(26,80,200,0.15)' : '1px solid transparent',
      }}
    >
      {/* Avatar */}
      <span
        className="flex size-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
        style={{ background: color }}
        aria-label={`Participant ${name}`}
      >
        {name}
      </span>

      {/* Gross paid */}
      <span className="text-right">
        <span className="block text-xs" style={{ color: 'var(--muted)' }}>Paid</span>
        <span className="tabular-nums text-sm font-semibold" style={{ color: 'var(--ink)' }}>
          ${fmtUsdc(grossPaid, 2)}
        </span>
      </span>

      {/* Rebate (if nonzero) */}
      <span className="text-right">
        <span className="block text-xs" style={{ color: 'var(--muted)' }}>Rebate</span>
        <span
          className="tabular-nums text-sm font-medium"
          style={{ color: rebate > 0n ? 'var(--mint)' : 'var(--subtle)' }}
        >
          {rebate > 0n ? `−$${fmtUsdc(rebate, 2)}` : '—'}
        </span>
      </span>

      {/* Net cost at current count */}
      <span className="text-right">
        <span className="block text-xs" style={{ color: 'var(--muted)' }}>Net after rebates</span>
        <span className="tabular-nums text-sm font-semibold" style={{ color: 'var(--ink)' }}>
          ${fmtUsdc(targetNet, 2)}
        </span>
      </span>
    </motion.div>
  )
}

export function ShareExample() {
  const [count, setCount] = useState(1)
  const [newIdx, setNewIdx] = useState<number | null>(0)

  function addParticipant() {
    if (count >= 4) return
    setNewIdx(count)
    setCount(c => c + 1)
  }

  function removeParticipant() {
    if (count <= 1) return
    setCount(c => c - 1)
    setNewIdx(null)
  }

  // Cost breakdown for current count
  const rows = Array.from({ length: count }, (_, i) => ({
    name:  NAMES[i],
    color: COLORS[i],
    index: i,
  }))

  // Next-participant preview
  const nextIdx  = count
  const nextCost = count < 4 ? arrivalShare(DEMO_PRICE, BigInt(count + 1)) : null

  return (
    <section
      className="rounded-3xl p-5"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
      }}
    >
      {/* Example label */}
      <div
        className="mb-4 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold tracking-wide"
        style={{
          color: 'var(--accent)',
          borderColor: 'rgba(26,80,200,0.2)',
          background: 'rgba(26,80,200,0.06)',
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
        }}
      >
        <Info className="size-3" aria-hidden />
        Illustrative example — not live activity
      </div>

      <h3
        className="display mb-1 text-xl font-semibold"
        style={{ color: 'var(--ink)', letterSpacing: '-0.025em' }}
      >
        See how sharing works
      </h3>
      <p className="mb-5 text-sm" style={{ color: 'var(--muted)', maxWidth: '44ch' }}>
        One fixed price, fairly split. Add participants A–D to watch how each person&apos;s net cost converges.
        Report price: <strong>$1.20 USDC</strong>.
      </p>

      {/* Participant table header */}
      <div
        className="mb-1 grid px-3 text-xs font-medium"
        style={{
          gridTemplateColumns: '2rem 1fr 1fr 1fr',
          color: 'var(--muted)',
          gap: '0.5rem',
        }}
      >
        <span />
        <span className="text-right">Paid</span>
        <span className="text-right">Rebate</span>
        <span className="text-right">Net after rebates</span>
      </div>

      {/* Participant rows */}
      <div className="mb-3 space-y-0.5">
        <AnimatePresence>
          {rows.map((r) => (
            <ParticipantRow
              key={r.name}
              {...r}
              totalN={count}
              price={DEMO_PRICE}
              isNew={newIdx === r.index}
            />
          ))}
        </AnimatePresence>
      </div>

      {/* Next participant preview */}
      {nextCost !== null && (
        <div
          className="mb-4 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm"
          style={{ borderColor: 'var(--border)', borderStyle: 'dashed', color: 'var(--muted)' }}
        >
          <span
            className="flex size-7 items-center justify-center rounded-full text-xs font-bold"
            style={{ background: 'var(--surface-muted)', color: 'var(--subtle)', border: '1px dashed var(--border)' }}
          >
            {NAMES[nextIdx]}
          </span>
          <span>
            {NAMES[nextIdx]} would pay{' '}
            <strong className="tabular-nums" style={{ color: 'var(--ink)' }}>
              ${fmtUsdc(nextCost, 2)} USDC
            </strong>
          </span>
          <ChevronRight className="ml-auto size-3.5 flex-shrink-0" aria-hidden />
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-2">
        <button
          onClick={addParticipant}
          disabled={count >= 4}
          className="rounded-xl px-4 py-2 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: 'var(--accent)' }}
        >
          Add {count < 4 ? NAMES[count] : '—'}
        </button>
        <button
          onClick={removeParticipant}
          disabled={count <= 1}
          className="rounded-xl border px-4 py-2 text-sm font-medium transition-all hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
        >
          Remove last
        </button>
        <span className="ml-auto text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
          {count} of 4 participant{count !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Cost bar — live visual of current share distribution */}
      <div className="mt-2 mb-1">
        <CostBar price={DEMO_PRICE} count={count} cap={4} highlightLast className="mb-1.5" />
        <CostBarLegend price={DEMO_PRICE} count={count} cap={4} />
      </div>

      {/* Maths note */}
      <p className="mt-4 text-xs" style={{ color: 'var(--subtle)', maxWidth: '56ch' }}>
        All amounts are exact integer arithmetic (micro-USDC, 6 decimal places). Rebate entitlements are not received cash until claimed from the contract. See <em>How it works</em> for the accounting definitions.
      </p>
    </section>
  )
}
