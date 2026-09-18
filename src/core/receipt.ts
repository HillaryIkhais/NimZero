import type { PaymentIntent, SignedAuthorization, PaymentReceipt, PaymentStatus, VerificationResult } from './types'
import { verifyPayment } from './verification'

export interface ReceiptInput {
  intent: PaymentIntent
  authorization: SignedAuthorization
  txHash?: string
  status: PaymentStatus
  verification?: VerificationResult
}

export function generateReceipt(input: ReceiptInput): PaymentReceipt {
  const verification = input.verification ?? verifyPayment(input.intent, input.authorization, input.txHash ?? '')

  // "VERIFIED" only ever comes from independent on-chain verification —
  // never from the relayer's own response.
  const verified = input.status === 'VERIFIED' && verification.overall === 'CONFIRMED'

  return {
    id: `receipt_${input.intent.id}`,
    intent: input.intent,
    txHash: input.txHash ?? '',
    gasPaidBy: 'ZERO',
    status: verified ? 'VERIFIED' : input.status,
    verified,
    verification,
    completedAt: Date.now()
  }
}

export function polygonScanUrl(txHash: string): string {
  if (!txHash) return ''
  return `https://polygonscan.com/tx/${txHash}`
}

export function shortHash(txHash: string): string {
  if (!txHash) return ''
  return `${txHash.slice(0, 10)}…${txHash.slice(-8)}`
}

export function shortAddress(address: string): string {
  if (!address) return ''
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function statusLabel(status: PaymentStatus): string {
  switch (status) {
    case 'VERIFIED':
      return 'Verified on Polygon'
    case 'SUBMITTED':
      return 'Submitted — verifying'
    case 'VERIFYING':
      return 'Verifying on Polygon'
    case 'AWAITING_SETTLEMENT':
      return 'Awaiting settlement'
    case 'FAILED':
      return 'Payment failed'
    case 'DECLINED':
      return 'Authorization declined'
    default:
      return 'Signing'
  }
}