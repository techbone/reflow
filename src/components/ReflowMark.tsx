/**
 * Reflow wordmark — code-native SVG mark.
 * The mark is a stylised "re" ligature: a circle (loop/rebate) feeding
 * back into a forward-slash arrow (flow), rendered in two weights.
 */

interface ReflowMarkProps {
  size?: number
  color?: string
  className?: string
}

export function ReflowMark({ size = 28, color = 'currentColor', className }: ReflowMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Reflow"
      className={className}
    >
      {/* Outer ring — rebate loop */}
      <circle cx="14" cy="14" r="12.5" stroke={color} strokeWidth="1.5" />
      {/* Inner circle — the cost pool */}
      <circle cx="14" cy="14" r="6" fill={color} fillOpacity="0.12" />
      {/* Forward arrow — flow */}
      <path
        d="M11 14h6M14 11l3 3-3 3"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Small split indicator — shares diverging */}
      <path
        d="M7 10.5 C7 10.5 9 10 9 14 C9 18 7 17.5 7 17.5"
        stroke={color}
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.5"
      />
    </svg>
  )
}

interface ReflowWordmarkProps {
  className?: string
  color?: string
  size?: 'sm' | 'md' | 'lg'
}

export function ReflowWordmark({ className, color, size = 'md' }: ReflowWordmarkProps) {
  const markSize = size === 'sm' ? 20 : size === 'lg' ? 36 : 26
  const textClass = size === 'sm'
    ? 'text-base font-semibold'
    : size === 'lg'
    ? 'text-2xl font-semibold'
    : 'text-lg font-semibold'

  const c = color ?? 'var(--ink)'

  return (
    <span
      className={`inline-flex items-center gap-2 font-display tracking-tight select-none ${textClass} ${className ?? ''}`}
      style={{ color: c, letterSpacing: '-0.03em' }}
    >
      <ReflowMark size={markSize} color={c} />
      Reflow
    </span>
  )
}
