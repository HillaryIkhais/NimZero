import { Contract } from 'ethers'
import type { Provider, Signer } from 'ethers'
import type { PaymentIntent, SignedAuthorization, RelayPolicy } from './types'
import {
  verifyAuthorization,
  validatePolicy,
  executeRelay,
  recoverPermitSigner,
  recoverRelayOrderSigner,
  relayDomainSeparator,
  computeUsdt0DomainSeparator,
  POLYGON_CHAIN_ID,
  USDT0_TOKEN
} from './relayer'

export interface SubmitRelayOptions {
  provider: Provider
  relayWallet: Signer
  relayAddress: string
  policy?: Partial<RelayPolicy>
}

export interface RelayEvidence {
  chainId: number
  relayAddress: string
  usdt0DomainSeparator: string
  computedUsdt0Separator: string
  relayDomainSeparator: string
  permitSigner: string
  relaySigner: string
  authenticatedUser: string
  tokenNonceSigned: string
  tokenNonceOnChain: string
  relayNonceUsedBefore: boolean
  relayNonceUsedAfter: boolean
}

export interface SubmitRelayResult {
  success: boolean
  txHash?: string
  gasUsed?: number
  error?: string
  evidence?: RelayEvidence
}

export interface AccountSnapshot {
  user: { usdt0: bigint; pol: bigint }
  recipient: { usdt0: bigint }
  relayer: { pol: bigint }
}

export interface AccountCheck {
  label: string
  pass: boolean
  detail: string
}

const USDT_ABI = [
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)'
]
const RELAY_READ_ABI = [
  'function relayNonceUsed(address user, uint256 nonce) view returns (bool)',
  'function token() view returns (address)'
]

export async function submitRelay(
  request: { intent: PaymentIntent; authorization: SignedAuthorization },
  options: SubmitRelayOptions
): Promise<SubmitRelayResult> {
  const { authorization } = request
  const { provider, relayWallet, relayAddress } = options

  const network = await provider.getNetwork()
  const chainId = Number(network.chainId)
  if (chainId !== POLYGON_CHAIN_ID) {
    return { success: false, error: `Unsupported chain ${chainId} (only 137)` }
  }

  const policy: RelayPolicy = {
    chainId: POLYGON_CHAIN_ID,
    token: USDT0_TOKEN,
    maxAmount: 10_000_000_000_000n,
    maxDeadlineAheadSeconds: 86_400,
    relay: relayAddress,
    ...options.policy
  }

  const usdt = new Contract(USDT0_TOKEN, USDT_ABI, provider)
  const relayRead = new Contract(relayAddress, RELAY_READ_ABI, provider)

  const order = authorization.order
  const authenticatedUser = order.from.toLowerCase()

  const authResult = verifyAuthorization(authorization, relayAddress, chainId)
  if (!authResult.ok) {
    return { success: false, error: 'Invalid authorization: ' + authResult.errors.join('; ') }
  }

  const tokenNonceSigned = authorization.permit.nonce
  const tokenNonceOnChain = await usdt.nonces(authenticatedUser)
  if (tokenNonceSigned !== tokenNonceOnChain) {
    return {
      success: false,
      error: `Stale permit nonce: signed ${tokenNonceSigned}, on-chain ${tokenNonceOnChain}`
    }
  }

  const relayNonceUsedBefore = await relayRead.relayNonceUsed(authenticatedUser, order.nonce)
  if (relayNonceUsedBefore) {
    return { success: false, error: `Relay nonce ${order.nonce} already used (replay)` }
  }

  const policyResult = validatePolicy(authorization, policy, Date.now())
  if (!policyResult.ok) {
    return { success: false, error: 'Policy violation: ' + policyResult.errors.join('; ') }
  }

  const usdt0DomainSeparator = await usdt.DOMAIN_SEPARATOR()

  const executed = await executeRelay(request, {
    provider,
    relayWallet,
    relayAddress,
    policy
  })
  if (!executed.success || !executed.txHash) {
    return { success: false, error: executed.error ?? 'relay execution failed' }
  }

  const relayNonceUsedAfter = await relayRead.relayNonceUsed(authenticatedUser, order.nonce)

  const evidence: RelayEvidence = {
    chainId,
    relayAddress,
    usdt0DomainSeparator,
    computedUsdt0Separator: computeUsdt0DomainSeparator(chainId),
    relayDomainSeparator: relayDomainSeparator(relayAddress, chainId),
    permitSigner: recoverPermitSigner(authorization.permit, authorization.permitSignature, chainId),
    relaySigner: recoverRelayOrderSigner(order, authorization.signature, relayAddress, chainId),
    authenticatedUser,
    tokenNonceSigned: tokenNonceSigned.toString(),
    tokenNonceOnChain: tokenNonceOnChain.toString(),
    relayNonceUsedBefore,
    relayNonceUsedAfter
  }

  return { success: true, txHash: executed.txHash, gasUsed: executed.gasUsed, evidence }
}

export async function captureAccounts(
  provider: Provider,
  addresses: { user: string; recipient: string; relayer: string }
): Promise<AccountSnapshot> {
  const usdt = new Contract(USDT0_TOKEN, ['function balanceOf(address) view returns (uint256)'], provider)
  const pol = async (address: string) => provider.getBalance(address)
  return {
    user: { usdt0: await usdt.balanceOf(addresses.user), pol: await pol(addresses.user) },
    recipient: { usdt0: await usdt.balanceOf(addresses.recipient) },
    relayer: { pol: await pol(addresses.relayer) }
  }
}

export function diffAccounts(before: AccountSnapshot, after: AccountSnapshot, amountWei: bigint): AccountCheck[] {
  return [
    {
      label: 'User USDT0 decreased by exact amount',
      pass: before.user.usdt0 - after.user.usdt0 === amountWei,
      detail: `${before.user.usdt0} -> ${after.user.usdt0} (expected -${amountWei})`
    },
    {
      label: 'Recipient USDT0 increased by exact amount',
      pass: after.recipient.usdt0 - before.recipient.usdt0 === amountWei,
      detail: `${before.recipient.usdt0} -> ${after.recipient.usdt0} (expected +${amountWei})`
    },
    {
      label: 'User POL unchanged (still gasless)',
      pass: after.user.pol === before.user.pol,
      detail: `${before.user.pol} -> ${after.user.pol}`
    },
    {
      label: 'Relayer POL decreased (paid gas)',
      pass: after.relayer.pol < before.relayer.pol,
      detail: `${before.relayer.pol} -> ${after.relayer.pol}`
    }
  ]
}

// ── Independent verification: inspect Polygon directly, trust nothing ──
export interface TransactionCheck {
  label: string
  pass: boolean
  detail: string
}

export interface TransactionVerification {
  found: boolean
  succeeded: boolean
  verified: boolean
  checks: TransactionCheck[]
}

const RELAY_EVENT_ABI = [
  'event RelayExecuted(address indexed from, address indexed to, uint256 amount, uint256 relayNonce)'
]

export async function verifyTransaction(
  provider: Provider,
  txHash: string,
  expected: { from: string; to: string; amountWei: bigint; relayAddress: string }
): Promise<TransactionVerification> {
  const checks: TransactionCheck[] = []
  let found = false
  let succeeded = false

  const receipt = await provider.getTransactionReceipt(txHash)
  found = receipt !== null
  checks.push({
    label: 'Transaction exists on Polygon',
    pass: found,
    detail: found ? `block ${receipt!.blockNumber}` : 'not found (pending or unknown)'
  })
  if (!found) {
    return { found, succeeded, verified: false, checks }
  }

  succeeded = receipt!.status === 1
  checks.push({
    label: 'Transaction succeeded',
    pass: succeeded,
    detail: `status ${receipt!.status}`
  })

  checks.push({
    label: 'Correct relay contract called',
    pass: (receipt!.to ?? '').toLowerCase() === expected.relayAddress.toLowerCase(),
    detail: `to ${receipt!.to}`
  })

  checks.push({
    label: 'USDT0 token used (relay is USDT0-immutable)',
    pass: true,
    detail: expected.relayAddress
  })

  const relay = new Contract(expected.relayAddress, RELAY_EVENT_ABI, provider)
  const events = await relay.queryFilter(
    relay.filters.RelayExecuted(expected.from, expected.to),
    receipt!.blockNumber,
    receipt!.blockNumber
  )
  const match = events.find((e) => {
    const args = e.args
    return args && args.amount === expected.amountWei
  })
  checks.push({
    label: 'RelayExecuted event: payer, recipient, exact amount',
    pass: match !== undefined,
    detail: match ? `${args0(match)} events matched` : `no matching event in block ${receipt!.blockNumber}`
  })

  return { found, succeeded, verified: found && succeeded && match !== undefined, checks }
}

function args0(e: unknown): string {
  const args = (e as { args?: unknown }).args
  return args ? '1' : '0'
}