/**
 * Reflow — M2 application shell.
 * Hash-based navigation: explore | purchases | receipts | how
 *
 * Architecture:
 *   TxControllerProvider is mounted above all routes so it is never unmounted
 *   by navigation. The shared latch it holds is therefore never reset by a
 *   route switch while a wallet request is in flight.
 *
 *   ReflowPoolProvider provides pool data to all routes and to TxController.
 *
 * Routes:
 *   (default) Explore — pool + purchase room + illustrative example
 *   #purchases — My purchases (requires wallet connection)
 *   #receipts  — Receipt & reconciliation (public, no wallet required)
 *   #how       — How it works
 */

import { useState, useEffect, createContext, useContext } from 'react'
import { useAccount } from 'wagmi'
import { NETWORK } from './lib/network'
import { ConnectKitButton } from 'connectkit'
import { Header } from './components/Header'
import { ResourceCard } from './components/ResourceCard'
import { PurchaseRoom } from './components/PurchaseRoom'
import { ShareExample } from './components/ShareExample'
import { ReceiptView } from './components/ReceiptView'
import { HowItWorks } from './components/HowItWorks'
import { AdminView } from './components/AdminView'
import { ReflowWordmark } from './components/ReflowMark'
import { TxControllerProvider } from './lib/TxController'
import { useReflowPool, type ReflowPoolResult } from './hooks/useReflowPool'

type View = 'explore' | 'purchases' | 'receipts' | 'how' | 'admin'

function hashToView(hash: string): View {
  if (hash === '#purchases') return 'purchases'
  if (hash === '#receipts')  return 'receipts'
  if (hash === '#how')       return 'how'
  if (hash === '#admin')     return 'admin'
  return 'explore'
}

function viewToHash(v: View): string {
  if (v === 'purchases') return '#purchases'
  if (v === 'receipts')  return '#receipts'
  if (v === 'how')       return '#how'
  if (v === 'admin')     return '#admin'
  return ''
}

/** Returns the current Unix timestamp in seconds, updated every second. */
function useNowSec(): number {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000))
    }, 1_000)
    return () => clearInterval(id)
  }, [])
  return nowSec
}

// ── Pool context — shared between routes and TxController ─────────────────────

const PoolCtx = createContext<ReflowPoolResult | null>(null)

export function usePoolContext(): ReflowPoolResult {
  const ctx = useContext(PoolCtx)
  if (!ctx) throw new Error('usePoolContext must be used inside App')
  return ctx
}

/**
 * PoolProvider lifts useReflowPool above the routes so:
 *   1. Pool data is not re-fetched when navigating between tabs.
 *   2. TxControllerProvider can receive a stable refetch callback.
 */
function PoolProvider({ children }: { children: React.ReactNode }) {
  const poolResult = useReflowPool()
  return <PoolCtx.Provider value={poolResult}>{children}</PoolCtx.Provider>
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<View>(() => hashToView(window.location.hash))
  const { isConnected } = useAccount()
  const nowSec = useNowSec()

  // Keep hash in sync with view
  useEffect(() => {
    const target = viewToHash(view)
    if (window.location.hash !== target) {
      window.history.replaceState(null, '', target || window.location.pathname)
    }
  }, [view])

  // Respond to browser back/forward
  useEffect(() => {
    const handler = () => setView(hashToView(window.location.hash))
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  const handleNav = (v: View) => {
    const hash = viewToHash(v)
    window.history.pushState(null, '', hash || window.location.pathname)
    setView(v)
  }

  return (
    <PoolProvider>
      <TxControllerInner isConnected={isConnected} view={view} nowSec={nowSec} onNav={handleNav} />
    </PoolProvider>
  )
}

/**
 * TxControllerInner sits inside PoolProvider so it can pass pool.refetch
 * to TxControllerProvider as a stable callback.
 */
function TxControllerInner({
  isConnected, view, nowSec, onNav,
}: {
  isConnected: boolean
  view: View
  nowSec: number
  onNav: (v: View) => void
}) {
  const poolResult = useContext(PoolCtx)
  const refetch = poolResult?.refetch ?? (() => { /* noop when pool not yet loaded */ })

  return (
    <TxControllerProvider onRefetch={refetch}>
      <AppShell isConnected={isConnected} view={view} nowSec={nowSec} onNav={onNav} />
    </TxControllerProvider>
  )
}

function AppShell({
  isConnected, view, nowSec, onNav,
}: {
  isConnected: boolean
  view: View
  nowSec: number
  onNav: (v: View) => void
}) {
  // Admin route renders standalone (no shared header/footer)
  if (view === 'admin') return <AdminView />

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      <Header view={view} onNav={onNav} />

      {/* Mainnet amber banner — shown on every route when VITE_REFLOW_NETWORK=mainnet */}
      {NETWORK.isMainnet && (
        <div
          className="sticky top-[57px] z-30 w-full px-4 py-2 text-center text-sm font-medium"
          style={{ background: 'rgba(184,106,16,0.12)', borderBottom: '1px solid rgba(184,106,16,0.3)', color: 'var(--warn)' }}
        >
          Arc Mainnet: transactions spend <strong>real USDC</strong>.
        </div>
      )}

      <main className="mx-auto max-w-5xl px-4 py-8">
        {view === 'explore'   && <ExploreView nowSec={nowSec} />}
        {view === 'purchases' && <PurchasesView isConnected={isConnected} nowSec={nowSec} />}
        {view === 'receipts'  && <ReceiptView />}
        {view === 'how'       && <HowItWorks />}
      </main>

      <footer
        className="border-t mt-16 px-4 py-8 text-center text-xs"
        style={{ borderColor: 'var(--border)', color: 'var(--subtle)' }}
      >
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <ReflowWordmark size="sm" color="var(--subtle)" />
          <span>
            {NETWORK.isMainnet
              ? `${NETWORK.name}: transactions spend real USDC. Membership is recorded onchain.`
              : `${NETWORK.name}: testnet only, no real funds. Membership is recorded onchain.`
            }
          </span>
        </div>
      </footer>
    </div>
  )
}

// ── View: Explore ─────────────────────────────────────────────────────────────

function ExploreView({ nowSec }: { nowSec: number }) {
  return (
    <div className="space-y-6">
      {/* Editorial headline */}
      <div>
        <h1
          className="display mb-2 text-4xl font-bold text-balance"
          style={{ color: 'var(--ink)', letterSpacing: '-0.04em', maxWidth: '18ch' }}
        >
          One report.<br />A fairer share.
        </h1>
        <p className="text-base" style={{ color: 'var(--muted)', maxWidth: '46ch' }}>
          The first buyer pays once. Later buyers reimburse earlier ones. Everyone converges to the same net cost.
        </p>
      </div>

      {/* Resource card + purchase room side by side on desktop */}
      <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
        <ResourceCard nowSec={nowSec} />
        <PurchaseRoom nowSec={nowSec} />
      </div>

      {/* Share example */}
      <ShareExample />
    </div>
  )
}

// ── View: My Purchases ────────────────────────────────────────────────────────

function PurchasesView({ isConnected, nowSec }: { isConnected: boolean; nowSec: number }) {
  if (!isConnected) {
    return (
      <div
        className="rounded-3xl p-10 text-center"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <p className="text-base font-semibold" style={{ color: 'var(--ink)' }}>
          Connect your wallet to view your purchases
        </p>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          Membership is read directly from the contract.
        </p>
        <div className="mt-4 flex justify-center">
          <ConnectKitButton />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2
          className="display mb-1 text-2xl font-semibold"
          style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}
        >
          My purchases
        </h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Membership and rebate status read from {NETWORK.name}.
        </p>
      </div>
      <PurchaseRoom nowSec={nowSec} />
      <ReceiptView />
    </div>
  )
}
