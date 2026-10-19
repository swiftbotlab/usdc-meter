/**
 * UsdcMeter ABI — typed inline so wagmi can infer return types from getChannel.
 */
export const METER_ABI = [
  {
    type: 'constructor',
    inputs: [{ name: 'noticePeriod_', type: 'uint64' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'deposit',
    inputs: [{ name: 'provider', type: 'address' }],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'redeem',
    inputs: [
      { name: 'client', type: 'address' },
      { name: 'provider', type: 'address' },
      { name: 'cumulativeAmount', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'requestWithdraw',
    inputs: [{ name: 'provider', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'cancelWithdraw',
    inputs: [{ name: 'provider', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'completeWithdraw',
    inputs: [{ name: 'provider', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getChannel',
    inputs: [
      { name: 'client', type: 'address' },
      { name: 'provider', type: 'address' },
    ],
    outputs: [
      { name: 'deposited', type: 'uint128' },
      { name: 'withdrawn', type: 'uint128' },
      { name: 'redeemed', type: 'uint128' },
      { name: 'withdrawReadyAt', type: 'uint64' },
      { name: 'available', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'voucherDigest',
    inputs: [
      { name: 'client', type: 'address' },
      { name: 'provider', type: 'address' },
      { name: 'cumulativeAmount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'domainSeparator',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'noticePeriod',
    inputs: [],
    outputs: [{ name: '', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'VOUCHER_TYPEHASH',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
  // Events
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      { indexed: true, name: 'client', type: 'address' },
      { indexed: true, name: 'provider', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
      { indexed: false, name: 'available', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'Redeemed',
    inputs: [
      { indexed: true, name: 'client', type: 'address' },
      { indexed: true, name: 'provider', type: 'address' },
      { indexed: false, name: 'cumulativeAmount', type: 'uint256' },
      { indexed: false, name: 'paid', type: 'uint256' },
      { indexed: false, name: 'redeemed', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'WithdrawRequested',
    inputs: [
      { indexed: true, name: 'client', type: 'address' },
      { indexed: true, name: 'provider', type: 'address' },
      { indexed: false, name: 'readyAt', type: 'uint64' },
    ],
  },
  {
    type: 'event',
    name: 'WithdrawCancelled',
    inputs: [
      { indexed: true, name: 'client', type: 'address' },
      { indexed: true, name: 'provider', type: 'address' },
    ],
  },
  {
    type: 'event',
    name: 'Withdrawn',
    inputs: [
      { indexed: true, name: 'client', type: 'address' },
      { indexed: true, name: 'provider', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
  // Errors
  { type: 'error', name: 'ZeroValue', inputs: [] },
  { type: 'error', name: 'ZeroProvider', inputs: [] },
  { type: 'error', name: 'SelfChannel', inputs: [] },
  { type: 'error', name: 'AmountTooLarge', inputs: [] },
  { type: 'error', name: 'InvalidNoticePeriod', inputs: [] },
  { type: 'error', name: 'NothingToRedeem', inputs: [] },
  { type: 'error', name: 'NoPayout', inputs: [] },
  { type: 'error', name: 'TransferFailed', inputs: [] },
  { type: 'error', name: 'WithdrawAlreadyPending', inputs: [] },
  { type: 'error', name: 'NoChannelOrNoPending', inputs: [] },
  { type: 'error', name: 'NoPendingWithdraw', inputs: [] },
  { type: 'error', name: 'TooEarlyToWithdraw', inputs: [] },
  { type: 'error', name: 'NoAvailableBalance', inputs: [] },
  {
    type: 'error',
    name: 'InvalidSigner',
    inputs: [{ name: 'recovered', type: 'address' }],
  },
] as const
