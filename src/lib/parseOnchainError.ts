/**
 * Parse onchain / wagmi errors into user-readable messages.
 * No raw error message surfaces to the user.
 */

import { NETWORK } from './reflowConfig'

export type ErrorKind =
  | 'user-rejected'
  | 'wrong-chain'
  | 'insufficient-balance'
  | 'stale-quote'
  | 'rpc-timeout'
  | 'contract-revert'
  | 'unknown'

export interface ParsedError {
  kind: ErrorKind
  message: string
  /** True when the user should be returned to a review state rather than an error state. */
  isUserAction: boolean
}

export function parseOnchainError(error: unknown, networkName?: string): ParsedError {
  const msg = (
    (error instanceof Error ? error.message : String(error)) ?? ''
  ).toLowerCase()

  // User rejection — not an error, return to review state
  if (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('rejected the request') ||
    (error as { code?: number })?.code === 4001
  ) {
    return { kind: 'user-rejected', message: 'Transaction cancelled.', isUserAction: true }
  }

  // Wrong chain
  if (msg.includes('chain') && (msg.includes('switch') || msg.includes('wrong'))) {
    const name = networkName ?? NETWORK.name
    return { kind: 'wrong-chain', message: `Switch to ${name} to continue.`, isUserAction: false }
  }

  // Insufficient balance
  if (msg.includes('insufficient') || msg.includes('exceeds balance')) {
    return { kind: 'insufficient-balance', message: 'Insufficient USDC balance. Add funds and try again.', isUserAction: false }
  }

  // RPC timeout / network
  if (msg.includes('timeout') || msg.includes('network error') || msg.includes('fetch failed')) {
    return { kind: 'rpc-timeout', message: 'Network issue. Reconcile any known transaction hash before retrying.', isUserAction: false }
  }

  // Specific contract errors
  if (msg.includes('countmismatch') || msg.includes('count mismatch')) {
    return { kind: 'stale-quote', message: 'The pool count changed since your quote. Refresh to see the updated cost.', isUserAction: false }
  }
  if (msg.includes('contributiontoohigh')) {
    return { kind: 'stale-quote', message: 'Contribution limit exceeded. Refresh the quote and review the updated amount.', isUserAction: false }
  }
  if (msg.includes('deadlinepassed')) {
    return { kind: 'contract-revert', message: 'The joining deadline has passed. Claims are still available.', isUserAction: false }
  }
  if (msg.includes('capreached')) {
    return { kind: 'contract-revert', message: 'The pool is full. Claims are still available.', isUserAction: false }
  }
  if (msg.includes('alreadymember')) {
    return { kind: 'contract-revert', message: 'This address is already a member of the pool.', isUserAction: false }
  }
  if (msg.includes('nothingtoclaim')) {
    return { kind: 'contract-revert', message: 'No claimable rebate at this time.', isUserAction: false }
  }
  if (msg.includes('notamember')) {
    return { kind: 'contract-revert', message: 'This address is not a pool member.', isUserAction: false }
  }
  if (msg.includes('membersalreadyexist')) {
    return { kind: 'contract-revert', message: 'The first purchase has already been made. Use Join instead.', isUserAction: false }
  }
  if (msg.includes('firstpurchaserequired')) {
    return { kind: 'contract-revert', message: 'No one has purchased yet. The first purchase is required before joining.', isUserAction: false }
  }
  if (msg.includes('revert') || msg.includes('execution reverted')) {
    return { kind: 'contract-revert', message: 'Transaction was rejected by the contract. Check your eligibility and try again.', isUserAction: false }
  }

  return { kind: 'unknown', message: 'Something went wrong. Check your wallet and try again.', isUserAction: false }
}
