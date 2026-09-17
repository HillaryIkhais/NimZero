import type { PaymentIntent } from './types'

let nonceCounter = 0

export function createPaymentIntent(
  sender: string,
  recipient: string,
  amount: number,
  asset: 'USDT' = 'USDT',
  chain: 'polygon' = 'polygon',
  ttlMs: number = 300000
): PaymentIntent {
  if (amount <= 0) throw new Error('Amount must be positive')
  if (!isValidAddress(sender)) throw new Error('Invalid sender address')
  if (!isValidAddress(recipient)) throw new Error('Invalid recipient address')
  if (sender.toLowerCase() === recipient.toLowerCase()) throw new Error('Sender and recipient must differ')

  const now = Date.now()
  const nonce = nonceCounter++
  const id = `intent_${now.toString(36)}_${nonce.toString(36)}`

  const hash = hashIntent({ sender, recipient, amount, asset, chain, nonce, createdAt: now, expiresAt: now + ttlMs })

  return {
    id,
    sender,
    recipient,
    amount,
    asset,
    chain,
    nonce,
    createdAt: now,
    expiresAt: now + ttlMs,
    hash
  }
}

export function hashIntent(data: {
  sender: string
  recipient: string
  amount: number
  asset: string
  chain: string
  nonce: number
  createdAt: number
  expiresAt: number
}): string {
  const str = JSON.stringify({
    sender: data.sender.toLowerCase(),
    recipient: data.recipient.toLowerCase(),
    amount: data.amount,
    asset: data.asset,
    chain: data.chain,
    nonce: data.nonce,
    createdAt: data.createdAt,
    expiresAt: data.expiresAt
  })
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return '0x' + Math.abs(hash).toString(16).padStart(8, '0')
}

export function isIntentExpired(intent: PaymentIntent, now: number = Date.now()): boolean {
  return now > intent.expiresAt
}

export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

export function resetNonceCounter(): void {
  nonceCounter = 0
}
