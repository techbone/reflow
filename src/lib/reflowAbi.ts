/**
 * ReflowPools ABI — extracted verbatim from the compiled Foundry artifact.
 * contracts/out/ReflowPools.sol/ReflowPools.json
 *
 * DO NOT edit to fix a frontend type error. The contract is the source of truth.
 * If a type error appears, fix the caller, not this file.
 */

export const REFLOW_POOLS_ABI = [
  // ── writes ────────────────────────────────────────────────────────────────
  {
    type: 'function', name: 'createPool', stateMutability: 'nonpayable',
    inputs: [
      { name: 'price',        type: 'uint256' },
      { name: 'artifactHash', type: 'bytes32' },
      { name: 'termsHash',    type: 'bytes32' },
      { name: 'deadline',     type: 'uint64'  },
      { name: 'cap',          type: 'uint8'   },
    ],
    outputs: [{ name: 'poolId', type: 'uint256' }],
  },
  {
    type: 'function', name: 'purchaseFirst', stateMutability: 'nonpayable',
    inputs: [
      { name: 'poolId',    type: 'uint256' },
      { name: 'maxAmount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'join', stateMutability: 'nonpayable',
    inputs: [
      { name: 'poolId',          type: 'uint256' },
      { name: 'expectedCount',   type: 'uint256' },
      { name: 'maxContribution', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'claimFor', stateMutability: 'nonpayable',
    inputs: [
      { name: 'poolId',      type: 'uint256' },
      { name: 'beneficiary', type: 'address' },
    ],
    outputs: [],
  },
  // ── reads ─────────────────────────────────────────────────────────────────
  {
    type: 'function', name: 'quoteJoin', stateMutability: 'view',
    inputs: [
      { name: 'poolId',      type: 'uint256' },
      { name: 'participant', type: 'address' },
    ],
    outputs: [
      { name: 'contribution',  type: 'uint256' },
      { name: 'expectedCount', type: 'uint256' },
    ],
  },
  {
    type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'uint256' }],
    outputs: [{
      name: '', type: 'tuple',
      components: [
        { name: 'provider',     type: 'address' },
        { name: 'price',        type: 'uint256' },
        { name: 'artifactHash', type: 'bytes32' },
        { name: 'termsHash',    type: 'bytes32' },
        { name: 'deadline',     type: 'uint64'  },
        { name: 'cap',          type: 'uint8'   },
        { name: 'count',        type: 'uint8'   },
        { name: 'exists',       type: 'bool'    },
      ],
    }],
  },
  {
    type: 'function', name: 'getMember', stateMutability: 'view',
    inputs: [
      { name: 'poolId',      type: 'uint256' },
      { name: 'participant', type: 'address' },
    ],
    outputs: [{
      name: '', type: 'tuple',
      components: [
        { name: 'joinOrder',        type: 'uint256' },
        { name: 'grossPaid',        type: 'uint256' },
        { name: 'rebatesAllocated', type: 'uint256' },
        { name: 'rebatesClaimed',   type: 'uint256' },
        { name: 'isMember',         type: 'bool'    },
      ],
    }],
  },
  {
    type: 'function', name: 'outstandingCredit', stateMutability: 'view',
    inputs: [
      { name: 'poolId',      type: 'uint256' },
      { name: 'participant', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'totalLiability', stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'poolLiability', stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'usdc', stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function', name: 'nextPoolId', stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'shareOf', stateMutability: 'pure',
    inputs: [
      { name: 'C', type: 'uint256' },
      { name: 'n', type: 'uint256' },
      { name: 'i', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // ── events ────────────────────────────────────────────────────────────────
  {
    type: 'event', name: 'PoolCreated', anonymous: false,
    inputs: [
      { name: 'poolId',       type: 'uint256', indexed: true  },
      { name: 'provider',     type: 'address', indexed: true  },
      { name: 'price',        type: 'uint256', indexed: false },
      { name: 'artifactHash', type: 'bytes32', indexed: false },
      { name: 'termsHash',    type: 'bytes32', indexed: false },
      { name: 'deadline',     type: 'uint64',  indexed: false },
      { name: 'cap',          type: 'uint8',   indexed: false },
    ],
  },
  {
    type: 'event', name: 'FirstPurchased', anonymous: false,
    inputs: [
      { name: 'poolId',  type: 'uint256', indexed: true  },
      { name: 'buyer',   type: 'address', indexed: true  },
      { name: 'amount',  type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'Joined', anonymous: false,
    inputs: [
      { name: 'poolId',       type: 'uint256', indexed: true  },
      { name: 'participant',  type: 'address', indexed: true  },
      { name: 'joinOrder',    type: 'uint256', indexed: false },
      { name: 'contribution', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'RebateCredited', anonymous: false,
    inputs: [
      { name: 'poolId',      type: 'uint256', indexed: true  },
      { name: 'participant', type: 'address', indexed: true  },
      { name: 'amount',      type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'RebateClaimed', anonymous: false,
    inputs: [
      { name: 'poolId',      type: 'uint256', indexed: true  },
      { name: 'beneficiary', type: 'address', indexed: true  },
      { name: 'amount',      type: 'uint256', indexed: false },
    ],
  },
  // ── errors ────────────────────────────────────────────────────────────────
  { type: 'error', name: 'AlreadyMember',              inputs: [] },
  { type: 'error', name: 'CapReached',                 inputs: [] },
  { type: 'error', name: 'ContributionTooHigh',        inputs: [{ name: 'required', type: 'uint256' }, { name: 'max', type: 'uint256' }] },
  { type: 'error', name: 'CountMismatch',              inputs: [{ name: 'expected', type: 'uint256' }, { name: 'actual', type: 'uint256' }] },
  { type: 'error', name: 'DeadlinePassed',             inputs: [] },
  { type: 'error', name: 'FirstPurchaseRequired',      inputs: [] },
  { type: 'error', name: 'InvalidCap',                 inputs: [] },
  { type: 'error', name: 'InvalidDeadline',            inputs: [] },
  { type: 'error', name: 'InvalidHash',                inputs: [] },
  { type: 'error', name: 'InvalidPrice',               inputs: [] },
  { type: 'error', name: 'MembersAlreadyExist',        inputs: [] },
  { type: 'error', name: 'NotAMember',                 inputs: [] },
  { type: 'error', name: 'NothingToClaim',             inputs: [] },
  { type: 'error', name: 'PoolDoesNotExist',           inputs: [] },
  { type: 'error', name: 'PriceTooLow',                inputs: [] },
  { type: 'error', name: 'ProviderCannotParticipate',  inputs: [] },
  { type: 'error', name: 'ReentrancyGuardReentrantCall', inputs: [] },
  { type: 'error', name: 'SafeERC20FailedOperation',   inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'SelfParticipant',            inputs: [] },
  { type: 'error', name: 'TokenDecimalsNot6',          inputs: [{ name: 'actual', type: 'uint8' }] },
  { type: 'error', name: 'TokenMissingDecimalsInterface', inputs: [] },
  { type: 'error', name: 'TokenNotContract',           inputs: [] },
  { type: 'error', name: 'ZeroAddress',                inputs: [] },
  { type: 'error', name: 'ZeroParticipant',            inputs: [] },
] as const
