/**
 * Derived pool lifecycle state from on-chain data.
 * These are view-layer derivations; contract predicates take precedence.
 */

export type PoolStatus =
  | 'not-configured'   // contract/pool not set up
  | 'loading'          // fetching from chain
  | 'rpc-error'        // RPC unavailable
  | 'not-found'        // pool does not exist
  | 'available'        // exists, count==0, deadline not reached
  | 'active'           // count>=1, open, below cap
  | 'full'             // count==cap (claims still possible)
  | 'closed'           // deadline passed with >=1 member (claims still possible)
  | 'expired'          // deadline passed, count==0 (no funds held)

export interface PoolData {
  provider:     `0x${string}`
  price:        bigint
  artifactHash: `0x${string}`
  termsHash:    `0x${string}`
  deadline:     bigint
  cap:          number
  count:        number
  exists:       boolean
}

export interface MemberData {
  joinOrder:        bigint
  grossPaid:        bigint
  rebatesAllocated: bigint
  rebatesClaimed:   bigint
  isMember:         boolean
}

export function derivePoolStatus(
  pool: PoolData | undefined,
  nowSec: number,
): PoolStatus {
  if (!pool) return 'not-found'
  if (!pool.exists) return 'not-found'

  const deadlinePassed = nowSec >= Number(pool.deadline)
  const isFull = pool.count >= pool.cap
  const hasMembers = pool.count > 0

  if (deadlinePassed && !hasMembers) return 'expired'
  if (deadlinePassed && hasMembers)  return 'closed'
  if (isFull)                        return 'full'
  if (hasMembers)                    return 'active'
  return 'available'
}

export function canJoin(status: PoolStatus): boolean {
  return status === 'active'
}

export function canPurchaseFirst(status: PoolStatus): boolean {
  return status === 'available'
}

export function canClaim(status: PoolStatus): boolean {
  // Claims remain accessible after deadline and after pool fills
  return status === 'active' || status === 'full' || status === 'closed'
}

export function statusLabel(status: PoolStatus): string {
  switch (status) {
    case 'not-configured': return 'Setup pending'
    case 'loading':        return 'Loading'
    case 'rpc-error':      return 'RPC unavailable'
    case 'not-found':      return 'Not found'
    case 'available':      return 'Awaiting first purchase'
    case 'active':         return 'Open'
    case 'full':           return 'Full'
    case 'closed':         return 'Closed'
    case 'expired':        return 'Expired'
  }
}

export function statusColor(status: PoolStatus): string {
  switch (status) {
    case 'active':    return 'var(--success)'
    case 'available': return 'var(--accent)'
    case 'full':
    case 'closed':    return 'var(--mint)'
    case 'expired':
    case 'not-found':
    case 'rpc-error': return 'var(--danger)'
    default:          return 'var(--muted)'
  }
}

export function formatDeadline(deadlineSec: bigint): string {
  const d = new Date(Number(deadlineSec) * 1000)
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  })
}

export function formatAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
