import { describe, it, expect, beforeEach } from 'vitest'
import { Wallet } from 'ethers'
import { createPaymentIntent, resetNonceCounter } from '../src/core/payment-intent'
import {
  createSignedAuthorization,
  buildRelayRequest,
  executeRelay,
  verifyAuthorization,
  validatePolicy,
  getUsdtContractAddress,
  recoverPermitSigner,
  recoverRelayOrderSigner,
  usdt0PermitDomain,
  computeUsdt0DomainSeparator,
  USDT0_DOMAIN_SEPARATOR,
  POLYGON_CHAIN_ID,
  RELAY_NAME,
  RELAY_VERSION,
  USDT0_NAME,
  USDT0_VERSION,
  USDT0_TOKEN,
  USDT0_PERMIT_TYPES,
  RELAY_ORDER_TYPES,
  relayDomain
} from '../src/core/relayer'
import type { SignedAuthorization } from '../src/core/types'

// deterministic hardhat accounts
const ALICE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BOB_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const ALICE = new Wallet(ALICE_KEY)
const BOB = new Wallet(BOB_KEY)
const RELAY = '0x625C12eE38AAF831D3b4d644D7DaA962e2a26E0a'

describe('Relayer', () => {
  beforeEach(() => {
    resetNonceCounter()
  })

  it('rejects tampering with any relay-order binding field (crypto-level)', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)

    const tamperCases: Array<{ label: string; order: typeof auth.order }> = [
      { label: 'recipient (to)', order: { ...auth.order, to: '0x1111111111111111111111111111111111111111' } },
      { label: 'amount', order: { ...auth.order, amount: auth.order.amount + 1n } },
      { label: 'token', order: { ...auth.order, token: '0x0000000000000000000000000000000000000001' } },
      { label: 'chainId', order: { ...auth.order, chainId: 1 } },
      { label: 'deadline', order: { ...auth.order, deadline: BigInt(999_999_999) } },
      { label: 'nonce (replay)', order: { ...auth.order, nonce: auth.order.nonce + 1n } },
      { label: 'payer (from)', order: { ...auth.order, from: BOB.address } }
    ]

    for (const tc of tamperCases) {
      const tampered: SignedAuthorization = { ...auth, order: tc.order }
      const result = verifyAuthorization(tampered, RELAY)
      expect(result.ok).toBe(false)
      const cryptoCaught = result.errors.some(e => /signer|invalid|payment|token|owner/i.test(e))
      expect(cryptoCaught).toBe(true)
    }
  })

  it('rejects tampering with permit binding fields (crypto-level)', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)

    const tampered = { ...auth, permit: { ...auth.permit, spender: '0x2222222222222222222222222222222222222222' } }
    const result = verifyAuthorization(tampered, RELAY)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/spender/i)
  })

  it('testnet mirror token: salt-slot USDT0-style permit on chain 11155111 verifies with matching context', async () => {
    const CHAIN = 11155111 // Ethereum Sepolia — the testnet Nimiq Pay supports
    const TEST_TOKEN = '0x0000000000000000000000000000000000000A11'
    const testnetContext = { token: TEST_TOKEN, name: 'USDT0', version: '1', saltSlot: true }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

    const intent = createPaymentIntent(ALICE.address, BOB.address, 2)
    const permitMsg = { owner: ALICE.address, spender: RELAY, value: 2_000_000n, nonce: 0n, deadline }
    const orderMsg = {
      from: ALICE.address,
      to: BOB.address,
      amount: 2_000_000n,
      token: TEST_TOKEN,
      chainId: CHAIN,
      deadline,
      nonce: BigInt(intent.nonce)
    }

    // Mirrors the browser signing path exactly: generalized salt-slot domain.
    const [permitSignature, signature] = await Promise.all([
      ALICE.signTypedData(usdt0PermitDomain(CHAIN, testnetContext), USDT0_PERMIT_TYPES, permitMsg),
      ALICE.signTypedData(relayDomain(RELAY, CHAIN), RELAY_ORDER_TYPES, orderMsg)
    ])
    const auth: SignedAuthorization = {
      intentId: intent.id,
      signature,
      signedBy: ALICE.address,
      signedAt: Date.now(),
      permit: permitMsg,
      permitSignature,
      order: orderMsg,
      relay: RELAY
    }

    const ok = verifyAuthorization(auth, RELAY, CHAIN, testnetContext)
    expect(ok.ok).toBe(true)

    // The same signature must be REJECTED under the mainnet USDT0 context —
    // proves the testnet token is bound to its own address, never confused
    // with production USDT0.
    const mainnetReject = verifyAuthorization(auth, RELAY, CHAIN, { token: USDT0_TOKEN })
    expect(mainnetReject.ok).toBe(false)
    expect(mainnetReject.errors.join(' ')).toMatch(/token/i)
  })

  it('creates signed authorization with real EIP-712 signatures', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    expect(auth.intentId).toBe(intent.id)
    expect(auth.signedBy).toBe(ALICE.address)
    expect(auth.signature).toMatch(/^0x/)
    expect(auth.permitSignature).toMatch(/^0x/)
    expect(auth.order.amount).toBe(5_000_000n)
  })

  it('both signatures cryptographically recover to the payer', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const permitSigner = recoverPermitSigner(auth.permit, auth.permitSignature)
    const orderSigner = recoverRelayOrderSigner(auth.order, auth.signature, RELAY)
    expect(permitSigner).toBe(ALICE.address)
    expect(orderSigner).toBe(ALICE.address)
  })

  it('rejects wrong signer', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, BOB, RELAY, 0n)
    const result = verifyAuthorization(auth, RELAY)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/signer|from|owner/i)
  })

  it('builds relay request', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const req = buildRelayRequest(intent, auth)
    expect(req.intent).toBe(intent)
    expect(req.authorization).toBe(auth)
  })

  it('rejects mismatched authorization', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const badAuth = { ...auth, intentId: 'wrong' }
    expect(() => buildRelayRequest(intent, badAuth)).toThrow('Authorization intent mismatch')
  })

  it('rejects authorization signed for a different relay', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const otherRelay = '0x1111111111111111111111111111111111111111'
    const result = verifyAuthorization(auth, otherRelay)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/relay/)
  })

  it('rejects attacker-supplied arbitrary spender', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const tampered = { ...auth, permit: { ...auth.permit, spender: '0x2222222222222222222222222222222222222222' } }
    const result = verifyAuthorization(tampered, RELAY)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/spender/i)
  })

  it('enforces exact USDT0 token address', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const tampered = { ...auth, order: { ...auth.order, token: '0x0000000000000000000000000000000000000001' } }
    const result = verifyAuthorization(tampered, RELAY)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/token/i)
  })

  it('enforces Polygon chain only', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const tampered = { ...auth, order: { ...auth.order, chainId: 1 } }
    const result = verifyAuthorization(tampered, RELAY)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/chainId/i)
  })

  it('rejects amount mismatch between permit and order', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const tampered = { ...auth, permit: { ...auth.permit, value: auth.permit.value + 1n } }
    const result = verifyAuthorization(tampered, RELAY)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/value/i)
  })

  it('rejects deadline mismatch between permit and order', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const tampered = { ...auth, permit: { ...auth.permit, deadline: auth.permit.deadline + 1n } }
    const result = verifyAuthorization(tampered, RELAY)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/deadline/i)
  })

  it('rejects recipient equal to payer', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const tampered = { ...auth, order: { ...auth.order, to: ALICE.address } }
    const result = verifyAuthorization(tampered, RELAY)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/recipient/i)
  })

  it('policy rejects amount over limit', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const result = validatePolicy(auth, { chainId: POLYGON_CHAIN_ID, token: getUsdtContractAddress(), maxAmount: 1_000_000n, maxDeadlineAheadSeconds: 86400, relay: RELAY })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/amount/i)
  })

  it('policy rejects deadline too far ahead', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n, { deadline: BigInt(Math.floor(Date.now() / 1000) + 999999) })
    const result = validatePolicy(auth, { chainId: POLYGON_CHAIN_ID, token: getUsdtContractAddress(), maxAmount: 10_000_000_000_000n, maxDeadlineAheadSeconds: 86400, relay: RELAY })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/deadline/i)
  })

  it('executeRelay rejects bad chain on-chain check', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const fakeProvider = { getNetwork: async () => ({ chainId: 1n }) }
    const result = await executeRelay({ intent, authorization: auth }, { provider: fakeProvider as never, relayWallet: BOB, relayAddress: RELAY })
    expect(result.success).toBe(false)
    expect(result.error).toMatch('137')
  })

  it('executeRelay rejects authorization pinned to a different relay', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const OTHER_RELAY = '0x1111111111111111111111111111111111111111'
    const auth = await createSignedAuthorization(intent, ALICE, OTHER_RELAY, 0n)
    const fakeProvider = { getNetwork: async () => ({ chainId: POLYGON_CHAIN_ID }) }
    const result = await executeRelay({ intent, authorization: auth }, { provider: fakeProvider as never, relayWallet: BOB, relayAddress: RELAY })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/authorization/i)
  })

  it('rejects non-polygon chain in policy', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const result = validatePolicy(auth, { chainId: 1, token: getUsdtContractAddress(), maxAmount: 10_000_000_000_000n, maxDeadlineAheadSeconds: 86400, relay: RELAY })
    expect(result.ok).toBe(false)
  })

  it('returns USDT0 contract address', () => {
    expect(getUsdtContractAddress()).toBe('0xc2132D05D31c914a87C6611C10748AEb04B58e8F')
  })

  it('reproduces the verified USDT0 domain separator', () => {
    expect(computeUsdt0DomainSeparator()).toBe(USDT0_DOMAIN_SEPARATOR)
    expect(usdt0PermitDomain().name).toBe(USDT0_NAME)
    expect(usdt0PermitDomain().version).toBe(USDT0_VERSION)
  })

  it('relay domain uses standard EIP-712 constants', () => {
    expect(RELAY_NAME).toBe('ZeroPayRelay')
    expect(RELAY_VERSION).toBe('1')
    expect(POLYGON_CHAIN_ID).toBe(137)
  })
})

export type { SignedAuthorization }