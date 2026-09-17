import { describe, it, expect, beforeEach } from 'vitest'
import { Wallet } from 'ethers'
import { createPaymentIntent, resetNonceCounter } from '../src/core/payment-intent'
import { createSignedAuthorization } from '../src/core/relayer'
import { resetUsedNonces } from '../src/core/verification'
import { generateReceipt, formatReceipt } from '../src/core/receipt'

const ALICE = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const BOB = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const RELAY = '0x625C12eE38AAF831D3b4d644D7DaA962e2a26E0a'

describe('Receipt', () => {
  beforeEach(() => {
    resetNonceCounter()
    resetUsedNonces()
  })

  it('generates verified receipt', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const receipt = generateReceipt(intent, auth, '0xtx123')
    expect(receipt.verified).toBe(true)
    expect(receipt.gasPaidBy).toBe('ZERO')
    expect(receipt.txHash).toBe('0xtx123')
    expect(receipt.verification.overall).toBe('CONFIRMED')
  })

  it('generates failed receipt for bad payment', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    generateReceipt(intent, auth, '0xtx123')
    const receipt2 = generateReceipt(intent, auth, '0xtx456')
    expect(receipt2.verified).toBe(false)
    expect(receipt2.verification.overall).toBe('FAILED')
  })

  it('formats receipt', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const receipt = generateReceipt(intent, auth, '0xtx123')
    const formatted = formatReceipt(receipt)
    expect(formatted).toContain('PAYMENT COMPLETE')
    expect(formatted).toContain('$5.00 USDT')
    expect(formatted).toContain('ZERO')
  })
})