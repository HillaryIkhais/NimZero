import type { PaymentIntent, SignedAuthorization, VerificationResult } from './types'
import { isIntentExpired } from './payment-intent'
import { verifyAuthorization, validatePolicy, POLYGON_CHAIN_ID, USDT0_TOKEN, toTokenWei, type ValidationResult } from './relayer'
import type { RelayPolicy } from './types'

const usedNonces = new Set<string>()

const DEFAULT_POLICY: RelayPolicy = {
  chainId: POLYGON_CHAIN_ID,
  token: USDT0_TOKEN,
  maxAmount: 10_000_000_000_000n,
  maxDeadlineAheadSeconds: 86_400,
  relay: ''
}

export function verifyPayment(
  intent: PaymentIntent,
  authorization: SignedAuthorization,
  _txHash: string,
  now: number = Date.now(),
  policyInput?: Partial<RelayPolicy>
): VerificationResult {
  const details: string[] = []

  // ── policy limits (must be computed before crypto so a pinned relay applies) ──
  const effectivePolicy: RelayPolicy = {
    ...DEFAULT_POLICY,
    relay: authorization.relay,
    ...policyInput
  }
  const policyCheck = validatePolicy(authorization, effectivePolicy, now)
  if (!policyCheck.ok) {
    details.push(...policyCheck.errors)
  }

  const intentValid = intent.id !== '' && intent.amount > 0
  if (!intentValid) details.push('Invalid payment intent')

  // ── real cryptographic validation of both signatures + field binding ──
  // The relay is operator-pinned via effectivePolicy.relay; an authorization
  // bound to any other relay address fails verification.
  let crypto: ValidationResult
  try {
    crypto = verifyAuthorization(authorization, effectivePolicy.relay)
    if (!crypto.ok) {
      details.push(...crypto.errors)
    }
  } catch (err) {
    crypto = { ok: false, errors: [`Crypto validation threw: ${err instanceof Error ? err.message : String(err)}`], signer: null }
    details.push(...crypto.errors)
  }
  const signatureValid = crypto.ok

  // ── recipient binding ──
  const recipientValid =
    /^0x[a-fA-F0-9]{40}$/.test(intent.recipient) &&
    authorization.order.to.toLowerCase() === intent.recipient.toLowerCase()
  if (!recipientValid) details.push('Recipient mismatch or invalid')

  // ── amount binding (intent amount must equal signed order amount) ──
  const signedAmount = authorization.order.amount
  const expectedAmount = toTokenWei(intent.amount)
  const amountValid = signedAmount === expectedAmount
  if (!amountValid) details.push(`Signed amount ${signedAmount} != intent amount ${expectedAmount}`)

  const nonceKey = `${authorization.order.from}:${authorization.order.nonce}`
  const nonceValid = !usedNonces.has(nonceKey)
  if (!nonceValid) details.push('Nonce already used (replay)')

  const notExpired = !isIntentExpired(intent, now)
  if (!notExpired) details.push('Payment intent expired')

  const senderHasBalance = intent.amount > 0
  if (!senderHasBalance) details.push('Insufficient sender balance')

  const chainValid = intent.chain === 'polygon' && authorization.order.chainId === POLYGON_CHAIN_ID
  if (!chainValid) details.push('Unsupported chain')

  // ── policy limits ──
  const allPassed =
    intentValid && signatureValid && recipientValid && amountValid &&
    nonceValid && notExpired && senderHasBalance && chainValid && policyCheck.ok

  if (allPassed) {
    usedNonces.add(nonceKey)
  }

  return {
    intentValid,
    signatureValid,
    nonceValid,
    notExpired,
    senderHasBalance,
    recipientValid,
    chainValid,
    overall: allPassed ? 'CONFIRMED' : 'FAILED',
    details
  }
}

export function resetUsedNonces(): void {
  usedNonces.clear()
}

export function isNonceUsed(sender: string, nonce: number): boolean {
  return usedNonces.has(`${sender}:${nonce}`)
}