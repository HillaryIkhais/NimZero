import { verifyTypedData, Signature, Contract, TypedDataEncoder, toBeHex, zeroPadValue } from 'ethers'
import type { Provider, Signer } from 'ethers'
import type { PaymentIntent, SignedAuthorization, RelayPolicy, PermitMessage, RelayOrderMessage } from './types'
import { USDT0_POLYGON } from './chain'

export const POLYGON_CHAIN_ID = 137

export const USDT0_NAME = 'USDT0'
export const USDT0_VERSION = '1'
export const USDT0_TOKEN = USDT0_POLYGON
export const USDT0_DOMAIN_SEPARATOR = '0x7b43b7deae87806d0ace67d6c8e9e347fc85db8ad198e756e5c17d126fef9a05'

// The USDT0 token (UChildUSDT0) uses a NON-STANDARD EIP-712 domain:
//   EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)
//   chainId is NOT a domain field — it lives in the salt slot. A testnet mirror
//   token uses the same construction (salt = bytes32(chainId)).
// This object is exactly what the wallet signs via eth_signTypedData_v4.
export function usdt0PermitDomain(
  chainId: number = POLYGON_CHAIN_ID,
  opts: { token?: string; name?: string; version?: string; saltSlot?: boolean } = {}
): {
  name: string
  version: string
  verifyingContract: string
  chainId?: number
  salt?: string
} {
  const base = {
    name: opts.name ?? USDT0_NAME,
    version: opts.version ?? USDT0_VERSION,
    verifyingContract: opts.token ?? USDT0_TOKEN
  }
  if (opts.saltSlot === false) {
    return { ...base, chainId }
  }
  return { ...base, salt: zeroPadValue(toBeHex(chainId), 32) }
}

// Reproduce the token's on-chain domainSeparator for sanity checks.
export function computeUsdt0DomainSeparator(
  chainId: number = POLYGON_CHAIN_ID,
  context: PermitContext = { token: USDT0_TOKEN }
): string {
  return TypedDataEncoder.hashDomain(usdt0PermitDomain(chainId, context))
}

export const USDT0_PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
}

export const RELAY_ORDER_TYPES = {
  RelayOrder: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }
  ]
}

export const RELAY_NAME = 'ZeroPayRelay'
export const RELAY_VERSION = '1'

// The ZeroPayRelay contract uses a STANDARD EIP-712 domain.
export function relayDomain(relayAddress: string, chainId: number = POLYGON_CHAIN_ID): {
  name: string
  version: string
  chainId: number
  verifyingContract: string
} {
  return {
    name: RELAY_NAME,
    version: RELAY_VERSION,
    chainId,
    verifyingContract: relayAddress
  }
}

export function relayDomainSeparator(relayAddress: string, chainId: number = POLYGON_CHAIN_ID): string {
  return TypedDataEncoder.hashDomain(relayDomain(relayAddress, chainId))
}

export interface PermitContext {
  token: string
  name?: string
  version?: string
  saltSlot?: boolean
}

export function recoverPermitSigner(
  message: PermitMessage,
  signature: string,
  chainId: number = POLYGON_CHAIN_ID,
  context: PermitContext = { token: USDT0_TOKEN }
): string {
  return verifyTypedData(usdt0PermitDomain(chainId, context), USDT0_PERMIT_TYPES, message, signature)
}

export function recoverRelayOrderSigner(message: RelayOrderMessage, signature: string, relayAddress: string, chainId: number = POLYGON_CHAIN_ID): string {
  return verifyTypedData(relayDomain(relayAddress, chainId), RELAY_ORDER_TYPES, message, signature)
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
  signer: string | null
}

export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

export function defaultDeadline(now: number = Date.now()): bigint {
  return BigInt(Math.floor(now / 1000) + 3600)
}

export function toTokenWei(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000))
}

export function createSignedAuthorization(
  intent: PaymentIntent,
  wallet: Signer,
  relayAddress: string,
  tokenNonce: bigint,
  options: { chainId?: number; deadline?: bigint; recipient?: string; amountWei?: bigint; ctx?: PermitContext } = {}
): Promise<SignedAuthorization> {
  const chainId = options.chainId ?? POLYGON_CHAIN_ID
  const ctx = options.ctx ?? { token: USDT0_TOKEN }
  const deadline = options.deadline ?? defaultDeadline()
  const recipient = options.recipient ?? intent.recipient
  const amount = options.amountWei ?? toTokenWei(intent.amount)

  const permitMessage: PermitMessage = {
    owner: intent.sender,
    spender: relayAddress,
    value: amount,
    nonce: tokenNonce,
    deadline
  }

  const orderMessage: RelayOrderMessage = {
    from: intent.sender,
    to: recipient,
    amount,
    token: ctx.token,
    chainId,
    deadline,
    nonce: BigInt(intent.nonce)
  }

  async function composed(): Promise<SignedAuthorization> {
    const [permitSignature, relaySignature] = await Promise.all([
      signPermit(wallet, permitMessage, chainId, ctx),
      signRelayOrder(wallet, orderMessage, relayAddress, chainId)
    ])

    return {
      intentId: intent.id,
      signature: relaySignature,
      signedBy: intent.sender,
      signedAt: Date.now(),
      permit: permitMessage,
      permitSignature,
      order: orderMessage,
      relay: relayAddress
    }
  }

  return composed()
}

export function signPermit(
  wallet: Signer,
  message: PermitMessage,
  chainId: number = POLYGON_CHAIN_ID,
  ctx: PermitContext = { token: USDT0_TOKEN }
): Promise<string> {
  return wallet.signTypedData(usdt0PermitDomain(chainId, ctx), USDT0_PERMIT_TYPES, message)
}

export function signRelayOrder(wallet: Signer, message: RelayOrderMessage, relayAddress: string, chainId: number = POLYGON_CHAIN_ID): Promise<string> {
  return wallet.signTypedData(relayDomain(relayAddress, chainId), RELAY_ORDER_TYPES, message)
}

export function buildRelayRequest(
  intent: PaymentIntent,
  authorization: SignedAuthorization
): { intent: PaymentIntent; authorization: SignedAuthorization } {
  if (authorization.intentId !== intent.id) {
    throw new Error('Authorization intent mismatch')
  }
  return { intent, authorization }
}

// Cryptographic + structural validation of both signatures and every bound field.
// relayAddress is the configured (trusted) ZeroPayRelay — NOT attacker-supplied.
export function verifyAuthorization(
  authorization: SignedAuthorization,
  relayAddress: string,
  chainId: number = POLYGON_CHAIN_ID,
  context: PermitContext = { token: USDT0_TOKEN }
): ValidationResult {
  const errors: string[] = []
  const order = authorization.order
  const permit = authorization.permit

  if (!order) return { ok: false, errors: ['Missing relay order'], signer: null }
  if (!permit) return { ok: false, errors: ['Missing permit message'], signer: null }

  // ── structural field binding ──
  if (order.token.toLowerCase() !== context.token.toLowerCase()) {
    errors.push(`Order token ${order.token} != expected ${context.token}`)
  }
  if (order.chainId !== chainId) {
    errors.push(`Order chainId ${order.chainId} != ${chainId}`)
  }
  if (order.from.toLowerCase() !== authorization.signedBy.toLowerCase()) {
    errors.push('Order from != signedBy')
  }
  if (order.to.toLowerCase() === order.from.toLowerCase()) {
    errors.push('Recipient must differ from payer')
  }
  if (order.amount <= 0n) {
    errors.push('Order amount must be positive')
  }
  if (order.deadline <= BigInt(Math.floor(Date.now() / 1000))) {
    errors.push('Order deadline expired')
  }
  if (authorization.relay.toLowerCase() !== relayAddress.toLowerCase()) {
    errors.push(`Authorization relay ${authorization.relay} != configured relay ${relayAddress}`)
  }

  // ── cross-field binding between permit and relay order ──
  if (permit.value !== order.amount) {
    errors.push('Permit value != order amount')
  }
  if (permit.deadline !== order.deadline) {
    errors.push('Permit deadline != order deadline')
  }
  if (permit.spender.toLowerCase() !== relayAddress.toLowerCase()) {
    errors.push('Permit spender != configured relay (arbitrary spender)')
  }
  if (permit.owner.toLowerCase() !== order.from.toLowerCase()) {
    errors.push('Permit owner != order payer')
  }

  // ── cryptographic recovery ──
  let permitSigner: string | null = null
  try {
    permitSigner = recoverPermitSigner(permit, authorization.permitSignature, chainId, context)
  } catch {
    errors.push('Permit signature invalid')
  }
  let signer: string | null = null
  try {
    signer = recoverRelayOrderSigner(order, authorization.signature, relayAddress, chainId)
  } catch {
    errors.push('Relay order signature invalid')
  }

  if (signer === null) {
    errors.push('Relay order signer could not be recovered')
  } else if (signer.toLowerCase() !== order.from.toLowerCase()) {
    errors.push('Relay order signer != order payer')
  }

  if (permitSigner !== null && permitSigner.toLowerCase() !== order.from.toLowerCase()) {
    errors.push('Permit signer != order payer')
  }

  return { ok: errors.length === 0, errors, signer }
}

// Policy limits on top of cryptographic binding.
export function validatePolicy(
  authorization: SignedAuthorization,
  policy: RelayPolicy,
  now: number = Date.now()
): ValidationResult {
  const order = authorization.order
  if (!order) {
    return { ok: false, errors: ['Missing relay order'], signer: null }
  }

  const errors: string[] = []
  if (order.chainId !== policy.chainId) {
    errors.push(`chainId ${order.chainId} not allowed (only ${policy.chainId})`)
  }
  if (order.token.toLowerCase() !== policy.token.toLowerCase()) {
    errors.push(`token ${order.token} not allowed (only ${policy.token})`)
  }
  if (order.amount > policy.maxAmount) {
    errors.push(`amount ${order.amount} exceeds policy max ${policy.maxAmount}`)
  }
  const deadlineSec = Number(order.deadline)
  const nowSec = Math.floor(now / 1000)
  if (deadlineSec <= nowSec) {
    errors.push(`deadline ${deadlineSec} already passed (now ${nowSec})`)
  }
  if (deadlineSec > nowSec + policy.maxDeadlineAheadSeconds) {
    errors.push(`deadline ${deadlineSec} too far ahead (> ${policy.maxDeadlineAheadSeconds}s)`)
  }
  if (typeof order.nonce !== 'bigint') {
    errors.push('Invalid nonce')
  }
  return { ok: errors.length === 0, errors, signer: null }
}

// On-chain execution path — calls the exact fork-tested ZeroPayRelay.relay(...) primitive.
const RELAY_ABI = [
  'function relay(address from, address to, uint256 amount, uint256 deadline, uint256 relayNonce, uint8 permitV, bytes32 permitR, bytes32 permitS, uint8 relayV, bytes32 relayR, bytes32 relayS)'
]

export interface ExecuteRelayOptions {
  provider: Provider
  relayWallet: Signer
  // Operator-pinned ZeroPayRelay contract. The relayer executes ONLY this
  // contract; an authorization bound to any other relay address is rejected.
  relayAddress: string
  policy?: Partial<RelayPolicy>
  now?: number
  chain?: Partial<PermitContext> & { chainId: number; token: string }
}

export async function executeRelay(
  request: { intent: PaymentIntent; authorization: SignedAuthorization },
  options: ExecuteRelayOptions
): Promise<{ success: boolean; txHash?: string; gasUsed?: number; error?: string }> {
  const { authorization } = request
  const { provider, relayWallet } = options
  const chain = options.chain ?? { chainId: POLYGON_CHAIN_ID, token: USDT0_TOKEN }

  // The relayer uses ONLY its operator-pinned relay contract. The client-supplied
  // authorization.relay is bound into the signed order, and is rejected unless
  // it equals this pinned address (see verifyAuthorization below).
  const configuredRelay = options.relayAddress

  const basePolicy: RelayPolicy = {
    chainId: chain.chainId,
    token: chain.token,
    maxAmount: 10_000_000_000_000n,
    maxDeadlineAheadSeconds: 86_400,
    relay: configuredRelay
  }
  const policy: RelayPolicy = { ...basePolicy, ...options.policy }

  const authResult = verifyAuthorization(authorization, configuredRelay, chain.chainId, chain)
  if (!authResult.ok) {
    return { success: false, error: 'Invalid authorization: ' + authResult.errors.join('; ') }
  }

  const policyResult = validatePolicy(authorization, policy, options.now ?? Date.now())
  if (!policyResult.ok) {
    return { success: false, error: 'Policy violation: ' + policyResult.errors.join('; ') }
  }

  const network = await provider.getNetwork()
  if (Number(network.chainId) !== chain.chainId) {
    return { success: false, error: `Unsupported chain ${network.chainId} (only ${chain.chainId})` }
  }

  const relay = new Contract(configuredRelay, RELAY_ABI, relayWallet)
  const order = authorization.order
  const permitSig = Signature.from(authorization.permitSignature)
  const relaySig = Signature.from(authorization.signature)

  try {
    const tx = await relay.relay(
      order.from,
      order.to,
      order.amount,
      order.deadline,
      order.nonce,
      permitSig.v, permitSig.r, permitSig.s,
      relaySig.v, relaySig.r, relaySig.s
    )
    const receipt = await tx.wait()
    return { success: true, txHash: receipt.hash, gasUsed: Number(receipt.gasUsed) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function getUsdtContractAddress(): string {
  return USDT0_TOKEN
}

export function getRelayerAddress(): string {
  return ''
}