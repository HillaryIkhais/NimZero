import { describe, it, expect, beforeEach } from 'vitest'
import { Wallet } from 'ethers'
import { createPaymentIntent, resetNonceCounter } from '../src/core/payment-intent'
import { createSignedAuthorization, POLYGON_CHAIN_ID, USDT0_TOKEN } from '../src/core/relayer'
import { verifyPayment, resetUsedNonces } from '../src/core/verification'
import type { RelayPolicy } from '../src/core/types'

const ALICE = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const BOB = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const RELAY = '0x625C12eE38AAF831D3b4d644D7DaA962e2a26E0a'

const POLICY: RelayPolicy = {
  chainId: POLYGON_CHAIN_ID,
  token: USDT0_TOKEN,
  maxAmount: 10_000_000_000_000n,
  maxDeadlineAheadSeconds: 86_400,
  relay: RELAY
}

describe('Verification', () => {
  beforeEach(() => {
    resetNonceCounter()
    resetUsedNonces()
  })

  it('confirms valid payment with real crypto', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const result = verifyPayment(intent, auth, '0xtx123', Date.now(), POLICY)
    expect(result.overall).toBe('CONFIRMED')
    expect(result.details).toHaveLength(0)
    expect(result.signatureValid).toBe(true)
    expect(result.recipientValid).toBe(true)
  })

  it('rejects expired intent', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5, 'USDT', 'polygon', 1000)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n, { deadline: BigInt(Math.floor(intent.expiresAt / 1000)) })
    const result = verifyPayment(intent, auth, '0xtx123', intent.expiresAt + 1, POLICY)
    expect(result.overall).toBe('FAILED')
    expect(result.notExpired).toBe(false)
  })

  it('rejects replay', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    verifyPayment(intent, auth, '0xtx1', Date.now(), POLICY)
    const result = verifyPayment(intent, auth, '0xtx2', Date.now(), POLICY)
    expect(result.overall).toBe('FAILED')
    expect(result.nonceValid).toBe(false)
  })

  it('rejects bad signature', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const badAuth = { ...auth, signature: '0x11'.repeat(65) }
    const result = verifyPayment(intent, badAuth, '0xtx123', Date.now(), POLICY)
    expect(result.overall).toBe('FAILED')
    expect(result.signatureValid).toBe(false)
  })

  it('rejects wrong signer', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const wrongAuth = { ...auth, signedBy: BOB.address }
    const result = verifyPayment(intent, wrongAuth, '0xtx123', Date.now(), POLICY)
    expect(result.overall).toBe('FAILED')
    expect(result.signatureValid).toBe(false)
  })

  it('rejects invalid intent', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const badIntent = { ...intent, amount: 0 }
    const result = verifyPayment(badIntent, auth, '0xtx123', Date.now(), POLICY)
    expect(result.overall).toBe('FAILED')
    expect(result.intentValid).toBe(false)
  })

  it('rejects invalid recipient', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const badIntent = { ...intent, recipient: 'bad' }
    const result = verifyPayment(badIntent, auth, '0xtx123', Date.now(), POLICY)
    expect(result.overall).toBe('FAILED')
    expect(result.recipientValid).toBe(false)
  })

  it('rejects wrong chain', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n, { chainId: 1 })
    const badIntent = { ...intent, chain: 'ethereum' as any }
    const result = verifyPayment(badIntent, auth, '0xtx123', Date.now(), POLICY)
    expect(result.overall).toBe('FAILED')
    if (!result.chainValid) expect(result.chainValid).toBe(false)
  })

  it('rejects policy violation (amount over limit)', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 50)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const smallPolicy: RelayPolicy = { ...POLICY, maxAmount: 1_000_000n }
    const result = verifyPayment(intent, auth, '0xtx123', Date.now(), smallPolicy)
    expect(result.overall).toBe('FAILED')
    expect(result.details.join(' ')).toMatch(/amount/i)
  })

  it('rejects amount mismatch between intent and signed order', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const badIntent = { ...intent, amount: 6 }
    const result = verifyPayment(badIntent, auth, '0xtx123', Date.now(), POLICY)
    expect(result.overall).toBe('FAILED')
    expect(result.details.join(' ')).toMatch(/amount/i)
  })

  it('rejects recipient mismatch between intent and signed order', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const badIntent = { ...intent, recipient: Wallet.createRandom().address }
    const result = verifyPayment(badIntent, auth, '0xtx123', Date.now(), POLICY)
    expect(result.overall).toBe('FAILED')
    expect(result.recipientValid).toBe(false)
  })
})