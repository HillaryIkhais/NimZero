import { describe, it, expect, beforeEach } from 'vitest'
import { createPaymentIntent, hashIntent, isIntentExpired, isValidAddress, resetNonceCounter } from '../src/core/payment-intent'

const ALICE = '0x1234567890123456789012345678901234567890'
const BOB = '0xaabbccddee11223344556677889900aabbccddee'

describe('PaymentIntent', () => {
  beforeEach(() => {
    resetNonceCounter()
  })

  it('creates valid intent', () => {
    const intent = createPaymentIntent(ALICE, BOB, 5)
    expect(intent.sender).toBe(ALICE)
    expect(intent.recipient).toBe(BOB)
    expect(intent.amount).toBe(5)
    expect(intent.asset).toBe('USDT')
    expect(intent.chain).toBe('polygon')
    expect(intent.id).toMatch(/^intent_/)
    expect(intent.hash).toMatch(/^0x/)
  })

  it('rejects zero amount', () => {
    expect(() => createPaymentIntent(ALICE, BOB, 0)).toThrow('Amount must be positive')
  })

  it('rejects negative amount', () => {
    expect(() => createPaymentIntent(ALICE, BOB, -5)).toThrow('Amount must be positive')
  })

  it('rejects invalid sender', () => {
    expect(() => createPaymentIntent('bad', BOB, 5)).toThrow('Invalid sender address')
  })

  it('rejects invalid recipient', () => {
    expect(() => createPaymentIntent(ALICE, 'bad', 5)).toThrow('Invalid recipient address')
  })

  it('rejects same sender and recipient', () => {
    expect(() => createPaymentIntent(ALICE, ALICE, 5)).toThrow('Sender and recipient must differ')
  })

  it('increments nonce', () => {
    const i1 = createPaymentIntent(ALICE, BOB, 1)
    const i2 = createPaymentIntent(ALICE, BOB, 2)
    expect(i2.nonce).toBe(i1.nonce + 1)
  })

  it('detects expiry', () => {
    const intent = createPaymentIntent(ALICE, BOB, 5, 'USDT', 'polygon', 1000)
    expect(isIntentExpired(intent, intent.expiresAt + 1)).toBe(true)
    expect(isIntentExpired(intent, intent.expiresAt - 1)).toBe(false)
  })

  it('validates addresses', () => {
    expect(isValidAddress(ALICE)).toBe(true)
    expect(isValidAddress('0x' + 'a'.repeat(40))).toBe(true)
    expect(isValidAddress('short')).toBe(false)
    expect(isValidAddress('0x' + 'a'.repeat(39))).toBe(false)
  })

  it('hash is deterministic', () => {
    const data = { sender: ALICE, recipient: BOB, amount: 5, asset: 'USDT', chain: 'polygon', nonce: 0, createdAt: 1000, expiresAt: 2000 }
    expect(hashIntent(data)).toBe(hashIntent(data))
  })
})
