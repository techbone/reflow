import { ConnectKitButton } from 'connectkit'
import { ReflowWordmark } from './ReflowMark'
import { NETWORK } from '@/lib/network'

type View = 'explore' | 'purchases' | 'receipts' | 'how' | 'admin'

interface HeaderProps {
  view: View
  onNav: (v: View) => void
}

const NAV_ITEMS: { id: View; label: string }[] = [
  { id: 'explore',   label: 'Explore' },
  { id: 'purchases', label: 'My purchases' },
  { id: 'receipts',  label: 'Receipts' },
  { id: 'how',       label: 'How it works' },
]

export function Header({ view, onNav }: HeaderProps) {
  return (
    <header
      className="sticky top-0 z-40 border-b"
      style={{
        background: 'rgba(250, 248, 245, 0.88)',
        backdropFilter: 'blur(16px) saturate(180%)',
        WebkitBackdropFilter: 'blur(16px) saturate(180%)',
        borderColor: 'var(--border)',
      }}
    >
      <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
        {/* Wordmark */}
        <button
          onClick={() => onNav('explore')}
          className="flex-shrink-0 focus-visible:rounded-md"
          aria-label="Go to Explore"
        >
          <ReflowWordmark size="md" />
        </button>

        {/* Nav links — desktop */}
        <nav className="hidden items-center gap-1 sm:flex" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => onNav(item.id)}
              className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-offset-0"
              style={{
                color: view === item.id ? 'var(--ink)' : 'var(--muted)',
                background: view === item.id ? 'var(--surface-muted)' : 'transparent',
              }}
              aria-current={view === item.id ? 'page' : undefined}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Network badge — shows resolved network name */}
        <span
          className="hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium sm:flex"
          style={{
            color: NETWORK.isMainnet ? 'var(--warn)' : 'var(--muted)',
            borderColor: NETWORK.isMainnet ? 'var(--warn)' : 'var(--border)',
          }}
        >
          <span
            className="inline-block size-1.5 rounded-full"
            style={{ background: NETWORK.isMainnet ? 'var(--warn)' : 'var(--success)' }}
            aria-hidden="true"
          />
          {NETWORK.name}
        </span>

        {/* Wallet connect */}
        <ConnectKitButton />
      </div>

      {/* Mobile nav — horizontal scroll with snap and edge fade; no page-level overflow */}
      <div
        className="relative sm:hidden"
        style={{
          maskImage: 'linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)',
        }}
      >
        <nav
          className="flex items-center gap-1 overflow-x-auto scroll-smooth px-4 pb-2"
          style={{ scrollSnapType: 'x mandatory', overscrollBehaviorX: 'contain' }}
          aria-label="Mobile navigation"
        >
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => onNav(item.id)}
              className="flex-shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium"
              style={{
                scrollSnapAlign: 'start',
                color: view === item.id ? 'var(--ink)' : 'var(--muted)',
                background: view === item.id ? 'var(--surface-muted)' : 'transparent',
              }}
              aria-current={view === item.id ? 'page' : undefined}
            >
              {item.label}
            </button>
          ))}
          {/* Trailing spacer so the last tab isn't hidden under the right fade */}
          <span className="flex-shrink-0 w-4" aria-hidden="true" />
        </nav>
      </div>
    </header>
  )
}
