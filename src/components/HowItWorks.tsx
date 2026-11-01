/**
 * HowItWorks — a plain, accurate explanation of the Reflow mechanic.
 * No emojis, no generic feature lists, no invented traction.
 */

import { ArrowRight } from 'lucide-react'
import { NETWORK } from '@/lib/reflowConfig'

interface StepProps {
  number: number
  title:  string
  body:   string
}

function Step({ number, title, body }: StepProps) {
  return (
    <div className="flex gap-4">
      <div
        className="flex size-8 flex-shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white"
        style={{ background: 'var(--accent)' }}
      >
        {number}
      </div>
      <div>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{title}</h3>
        <p className="mt-0.5 text-sm leading-relaxed" style={{ color: 'var(--muted)', maxWidth: '50ch' }}>{body}</p>
      </div>
    </div>
  )
}

export function HowItWorks() {
  return (
    <div className="space-y-6">
      <div>
        <h2
          className="display mb-2 text-2xl font-semibold"
          style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}
        >
          How Reflow works
        </h2>
        <p className="text-sm" style={{ color: 'var(--muted)', maxWidth: '54ch' }}>
          A fixed-price report shared by a cohort. Each person converges to an equal net cost as the cohort fills.
        </p>
      </div>

      {/* Steps */}
      <div
        className="rounded-3xl p-5"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <div className="space-y-6">
          <Step
            number={1}
            title="Provider sets a fixed price"
            body="The provider deploys an immutable pool: a fixed price, a maximum number of participants, and a joining deadline. Terms cannot change after creation."
          />
          <Step
            number={2}
            title="First buyer pays the full price"
            body="The first participant pays the full provider price. The payment goes directly to the provider. The contract records membership and the price paid."
          />
          <Step
            number={3}
            title="Later buyers pay their fair share"
            body="Each new participant pays only their equal share of the total at the current count. The arriving payment is distributed as rebate credits to all earlier members."
          />
          <Step
            number={4}
            title="Rebate credits are claimable, not automatic"
            body="Credits accumulate as new members join. Any participant — or anyone acting on their behalf — can call claimFor to transfer the outstanding credit to the recorded member wallet."
          />
          <Step
            number={5}
            title="Claims remain open after the deadline"
            body="Joining closes at the deadline or when the cap is reached. Outstanding rebate credits remain claimable indefinitely. The contract holds USDC equal to total outstanding credits."
          />
        </div>
      </div>

      {/* Accounting table */}
      <div
        className="rounded-3xl p-5"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--ink)' }}>
          How amounts are tracked per member
        </h3>
        <div className="overflow-x-auto">
          <table className="text-sm w-full" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead>
              <tr>
                {['Field', 'Meaning'].map(h => (
                  <th key={h} className="pb-2 text-left text-xs font-medium pr-6" style={{ color: 'var(--muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody style={{ color: 'var(--ink-2)' }}>
              {[
                ['Gross paid',        'What you paid when you purchased or joined.'],
                ['Rebate allocated',  'Total rebate credits earned, including any already claimed. Gross paid minus this equals your economic net cost.'],
                ['Rebate claimed',    'Amount actually transferred to your wallet via claimFor.'],
                ['Claimable',         'Allocated minus claimed — ready to withdraw now.'],
                ['Net cost (entitlement)', 'Gross paid minus rebate allocated — your economic cost if fully claimed.'],
                ['Net cost (cash)',   'Gross paid minus rebate claimed — your actual cash outflow so far.'],
              ].map(([field, meaning], idx) => (
                <tr key={idx} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="py-2.5 pr-6 font-medium text-xs mono whitespace-nowrap" style={{ color: 'var(--ink)' }}>{field}</td>
                  <td className="py-2.5 text-xs" style={{ color: 'var(--muted)', maxWidth: '34ch' }}>{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* V1 constraints */}
      <div
        className="rounded-3xl p-5"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink)' }}>
          V1 scope
        </h3>
        <ul className="space-y-1.5 text-sm" style={{ color: 'var(--muted)' }}>
          {[
            'Maximum 16 participants per pool.',
            `USDC only (6-decimal ERC-20 on ${NETWORK.name}).`,
            'No platform fee.',
            'Immutable terms: price, cap, deadline and hashes cannot change after creation.',
            'No membership exit or withdrawal of paid purchase price.',
            'Provider cannot participate in their own pool.',
            'Report delivery is a service responsibility; the contract does not guarantee content.',
            'Builder-controlled wallets are used for the demo; this will be disclosed.',
          ].map((item) => (
            <li key={item} className="flex items-start gap-2">
              <ArrowRight className="mt-0.5 size-3.5 flex-shrink-0" style={{ color: 'var(--subtle)' }} />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
