import { describe, it, expect, beforeEach } from 'vitest'
import { Wallet } from 'ethers'
import { createPaymentIntent, resetNonceCounter } from '../src/core/payment-intent'
import { createSignedAuthorization } from '../src/core/relayer'
import { resetUsedNonces } from '../src/core/verification'
import { generateReceipt, polygonScanUrl, shortHash, shortAddress, statusLabel } from '../src/core/receipt'

const ALICE = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const BOB = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const RELAY = '0x625C12eE38AAF831D3b4d644D7DaA962e2a26E0a'

describe('Receipt', () => {
  beforeEach(() => {
    resetNonceCounter()
    resetUsedNonces()
  })

  it('verified receipt only when status VERIFIED and crypto confirms', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const receipt = generateReceipt({ intent, authorization: auth, txHash: '0xtx123', status: 'VERIFIED' })
    expect(receipt.status).toBe('VERIFIED')
    expect(receipt.verified).toBe(true)
    expect(receipt.gasPaidBy).toBe('ZERO')
    expect(receipt.txHash).toBe('0xtx123')
  })

  it('SUBMITTED receipt is NOT verified (never fake success)', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const receipt = generateReceipt({ intent, authorization: auth, txHash: '0xtx456', status: 'SUBMITTED' })
    expect(receipt.status).toBe('SUBMITTED')
    expect(receipt.verified).toBe(false)
  })

  it('VERIFIED status with failed crypto is NOT verified', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const badAuth = { ...auth, signature: '0x11'.repeat(65) }
    const receipt = generateReceipt({ intent, authorization: badAuth, txHash: '0xtx789', status: 'VERIFIED' })
    expect(receipt.verified).toBe(false)
  })

  it('AWAITING_SETTLEMENT receipt carries no tx hash', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const receipt = generateReceipt({ intent, authorization: auth, status: 'AWAITING_SETTLEMENT' })
    expect(receipt.txHash).toBe('')
    expect(receipt.verified).toBe(false)
  })

  it('PolygonScan URL and shorteners', () => {
    const tx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
    expect(polygonScanUrl(tx)).toBe('https://polygonscan.com/tx/' + tx)
    expect(polygonScanUrl('')).toBe('')
    expect(shortHash(tx)).toBe('0x12345678…90abcdef')
    expect(shortAddress(ALICE.address)).toBe(ALICE.address.slice(0, 6) + '…' + ALICE.address.slice(-4))
    expect(statusLabel('VERIFIED')).toBe('Verified on Polygon')
    expect(statusLabel('SUBMITTED')).toBe('Submitted — verifying')
  })
})