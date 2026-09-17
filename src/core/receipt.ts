import type { PaymentIntent, SignedAuthorization, PaymentReceipt } from './types'
import { verifyPayment } from './verification'

export function generateReceipt(
  intent: PaymentIntent,
  authorization: SignedAuthorization,
  txHash: string
): PaymentReceipt {
  const verification = verifyPayment(intent, authorization, txHash)

  return {
    id: `receipt_${intent.id}`,
    intent,
    txHash,
    gasPaidBy: 'ZERO',
    verified: verification.overall === 'CONFIRMED',
    verification,
    completedAt: Date.now()
  }
}

export function formatReceipt(receipt: PaymentReceipt): string {
  const status = receipt.verified ? '✓ PAYMENT COMPLETE' : '✗ PAYMENT FAILED'
  const amount = `$${receipt.intent.amount.toFixed(2)} ${receipt.intent.asset}`
  const recipient = receipt.intent.recipient.slice(0, 6) + '...' + receipt.intent.recipient.slice(-4)
  const txHash = receipt.txHash.slice(0, 10) + '...' + receipt.txHash.slice(-6)

  return [
    status,
    '',
    amount,
    '',
    `You paid:`,
    recipient,
    '',
    `Gas paid by:`,
    'ZERO',
    '',
    `TX:`,
    txHash
  ].join('\n')
}
