import { describe, it, expect, beforeEach } from 'vitest'
import { Wallet } from 'ethers'
import { createPaymentIntent, resetNonceCounter } from '../src/core/payment-intent'
import { createSignedAuthorization } from '../src/core/relayer'
import { submitRelay, captureAccounts, diffAccounts } from '../src/core/submit-relay'
import type { AccountSnapshot } from '../src/core/submit-relay'

const ALICE = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const BOB = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const RELAY = '0x625C12eE38AAF831D3b4d644D7DaA962e2a26E0a'

function fakeProvider(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getNetwork: async () => ({ chainId: 137n }),
    getBalance: async () => BigInt(1_000_000_000_000_000_000n),
    call: async () => '0x0000000000000000000000000000000000000000000000000000000000000000',
    ...overrides
  } as never
}

const noExecProvider = (extra: Record<string, unknown> = {}) =>
  fakeProvider(extra) as never

describe('submitRelay', () => {
  beforeEach(() => resetNonceCounter())

  it('rejects non-Polygon chain before any execution', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const provider = noExecProvider({ getNetwork: async () => ({ chainId: 1n }) })
    const result = await submitRelay({ intent, authorization: auth }, { provider, relayWallet: BOB, relayAddress: RELAY })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/only 137/)
  })

  it('rejects authorization bound to a different relay contract', async () => {
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const result = await submitRelay(
      { intent, authorization: auth },
      { provider: noExecProvider(), relayWallet: BOB, relayAddress: '0x1111111111111111111111111111111111111111' }
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Invalid authorization/)
  })

  it('rejects stale permit nonce (on-chain nonce advanced past signed)', async () => {
    const { id } = await import('ethers')
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const noncesSel = id('nonces(address)').slice(0, 10)
    // on-chain nonce = 7, signed nonce = 0 → stale
    const provider = noExecProvider({
      call: async (tx: { to: string; data: string }) => {
        if (tx.data.slice(0, 10).toLowerCase() === noncesSel.toLowerCase()) {
          return '0x' + 7n.toString(16).padStart(64, '0')
        }
        return '0x' + 0n.toString(16).padStart(64, '0')
      }
    })
    const result = await submitRelay({ intent, authorization: auth }, { provider, relayWallet: BOB, relayAddress: RELAY })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Stale permit nonce/)
  })

  it('rejects replay when relay nonce already used on-chain', async () => {
    const { id } = await import('ethers')
    const intent = createPaymentIntent(ALICE.address, BOB.address, 5)
    const auth = await createSignedAuthorization(intent, ALICE, RELAY, 0n)
    const relaySel = id('relayNonceUsed(address,uint256)').slice(0, 10)
    const provider = noExecProvider({
      call: async (tx: { to: string; data: string }) => {
        if (tx.data.slice(0, 10).toLowerCase() === relaySel.toLowerCase()) {
          return '0x' + 1n.toString(16).padStart(64, '0') // true → already used
        }
        return '0x' + 0n.toString(16).padStart(64, '0')
      }
    })
    const result = await submitRelay({ intent, authorization: auth }, { provider, relayWallet: BOB, relayAddress: RELAY })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/replay/)
  })

  it('captures and diffs accounts without a network (deterministic)', async () => {
    const provider = {
      getNetwork: async () => ({ chainId: 137n }),
      getBalance: async (address: string) =>
        BigInt(address.toLowerCase() === ALICE.address.toLowerCase() ? 0 : 999n),
      call: async (tx: { to: string; data: string }) => {
        // balanceOf for USDT0: return different values per address
        const addr = '0x' + tx.data.slice(34)
        return '0x' + BigInt(addr.toLowerCase() === BOB.address.toLowerCase() ? 500_000n : 1_000_000n).toString(16).padStart(64, '0')
      }
    } as never

    const before = await captureAccounts(provider, { user: ALICE.address, recipient: BOB.address, relayer: RELAY })
    expect(before.user.pol).toBe(0n)
    expect(before.user.usdt0).toBe(1_000_000n)
    expect(before.recipient.usdt0).toBe(500_000n)
    expect(before.relayer.pol).toBe(999n)

    const after: AccountSnapshot = {
      user: { usdt0: 500_000n, pol: 0n },
      recipient: { usdt0: 1_000_000n },
      relayer: { pol: 900n }
    }
    const checks = diffAccounts(before, after, 500_000n)
    const labels = Object.fromEntries(checks.map((c) => [c.label, c.pass]))
    expect(labels['User USDT0 decreased by exact amount']).toBe(true)
    expect(labels['Recipient USDT0 increased by exact amount']).toBe(true)
    expect(labels['User POL unchanged (still gasless)']).toBe(true)
    expect(labels['Relayer POL decreased (paid gas)']).toBe(true)
  })

  it('diffAccounts flags mismatches', async () => {
    const before: AccountSnapshot = {
      user: { usdt0: 1_000_000n, pol: 0n },
      recipient: { usdt0: 500_000n },
      relayer: { pol: 999n }
    }
    const after: AccountSnapshot = {
      user: { usdt0: 999_999n, pol: 5n }, // user moved 1 wei instead of 500000, and gained POL
      recipient: { usdt0: 500_001n },
      relayer: { pol: 999n } // relayer paid nothing
    }
    const checks = diffAccounts(before, after, 500_000n)
    expect(checks.every((c) => !c.pass)).toBe(true)
  })
})