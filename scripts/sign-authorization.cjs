#!/usr/bin/env node
// ZERO device-side signer CLI (mimics what the Nimiq Pay user signs).
// Produces a SignedAuthorization JSON for the relayer to submit.
//
//   USER_PRIVATE_KEY=0x.. RECIPIENT=0x.. AMOUNT=<usdt> RELAY=0x.. \
//   node scripts/sign-authorization.cjs [--rpc URL] [--out authorization.json] [--deadline SECS]
//
// The user needs a Polygon USDT0 balance and 0 POL (gasless). The relayer key
// is NOT touched here — the user only signs Permit + RelayOrder.

const fs = require('node:fs')
const { JsonRpcProvider, Wallet } = require('ethers')
const {
  createPaymentIntent
} = require('../build/.pipeline/payment-intent.js')
const {
  createSignedAuthorization,
  verifyAuthorization,
  USDT0_TOKEN,
  USDT0_DOMAIN_SEPARATOR,
  POLYGON_CHAIN_ID,
  computeUsdt0DomainSeparator,
  defaultDeadline,
  toTokenWei
} = require('../build/.pipeline/relayer.js')

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const RPC = opt('--rpc') || process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com'
const OUT = opt('--out') || 'authorization.json'
const DEADLINE = opt('--deadline')
const USER_PK = process.env.USER_PRIVATE_KEY
const RECIPIENT = process.env.RECIPIENT
const AMOUNT = Number(process.env.AMOUNT)
const RELAY = process.env.RELAY

if (!USER_PK || !RECIPIENT || !(AMOUNT > 0)) {
  console.error('Usage: USER_PRIVATE_KEY=0x.. RECIPIENT=0x.. AMOUNT=<usdt> RELAY=0x.. node scripts/sign-authorization.cjs [--rpc URL] [--out file.json]')
  process.exit(2)
}

const provider = new JsonRpcProvider(RPC, POLYGON_CHAIN_ID)

async function tokenNonce(provider, owner) {
  const { Contract } = require('ethers')
  const usdt = new Contract(USDT0_TOKEN, ['function nonces(address) view returns (uint256)'], provider)
  return usdt.nonces(owner)
}

;(async () => {
  const network = await provider.getNetwork()
  console.error(`Chain: ${network.chainId} (expected 137)`)
  if (Number(network.chainId) !== POLYGON_CHAIN_ID) throw new Error(`Wrong chain ${network.chainId}`)

  const userWallet = new Wallet(USER_PK, provider)
  const user = userWallet.address
  console.error(`User: ${user}`)
  console.error(`Recipient: ${RECIPIENT}`)
  console.error(`Amount: ${AMOUNT} USDT0 (= ${toTokenWei(AMOUNT).toString()} wei)`)

  const usdtBalance = await provider.call({
    to: USDT0_TOKEN,
    data: '0x70a08231000000000000000000000000' + user.slice(2)
  })
  console.error(`User USDT0 balance: ${BigInt(usdtBalance).toString()} wei`)
  if (BigInt(usdtBalance) < toTokenWei(AMOUNT)) {
    throw new Error(`User has ${BigInt(usdtBalance)} wei USDT0 but needs ${toTokenWei(AMOUNT)}`)
  }
  const polBalance = await provider.getBalance(user)
  console.error(`User POL balance: ${polBalance.toString()} wei (0 required for gasless demo)`)

  const onChainSeparator = computeUsdt0DomainSeparator(POLYGON_CHAIN_ID)
  if (onChainSeparator.toLowerCase() !== USDT0_DOMAIN_SEPARATOR.toLowerCase()) {
    throw new Error('USDT0 domain separator mismatch — aborting (bug must be fixed, not bypassed)')
  }

  if (!RELAY) throw new Error('RELAY address required (operator-pinned ZeroPayRelay)')

  const nonce = await tokenNonce(provider, user)
  console.error(`On-chain token nonce: ${nonce.toString()}`)

  const deadline = DEADLINE ? BigInt(DEADLINE) : defaultDeadline()
  const intent = createPaymentIntent(user, RECIPIENT, AMOUNT)
  const auth = await createSignedAuthorization(intent, userWallet, RELAY, nonce, { deadline })

  const check = verifyAuthorization(auth, RELAY, POLYGON_CHAIN_ID)
  if (!check.ok) throw new Error('Authorization failed verification: ' + check.errors.join('; '))

  const payload = {
    format: 'zero-signed-auth-v1',
    chainId: POLYGON_CHAIN_ID,
    token: USDT0_TOKEN,
    relay: RELAY,
    signedAt: Date.now(),
    intent,
    authorization: {
      intentId: auth.intentId,
      signedBy: auth.signedBy,
      signedAt: auth.signedAt,
      relay: auth.relay,
      signature: auth.signature,
      permitSignature: auth.permitSignature,
      permit: {
        owner: auth.permit.owner,
        spender: auth.permit.spender,
        value: auth.permit.value.toString(),
        nonce: auth.permit.nonce.toString(),
        deadline: auth.permit.deadline.toString()
      },
      order: {
        from: auth.order.from,
        to: auth.order.to,
        amount: auth.order.amount.toString(),
        token: auth.order.token,
        chainId: auth.order.chainId,
        deadline: auth.order.deadline.toString(),
        nonce: auth.order.nonce.toString()
      }
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2))
  console.error(`Wrote ${OUT}`)
  console.log(OUT)
})().catch((err) => {
  console.error('sign-authorization FAILED:', err.message)
  process.exit(1)
})