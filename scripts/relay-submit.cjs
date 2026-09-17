#!/usr/bin/env node
// ZERO relayer CLI — submits a signed authorization to the real ZeroPayRelay
// on Polygon mainnet. The relayer pays gas; the user stays gasless.
//
//   RELAYER_PRIVATE_KEY=0x.. node scripts/relay-submit.cjs <authorization.json> [--rpc URL]
//
// Next step after a successful real-Polygon run is the adversarial suite
// (wrong recipient/amount/token/chain, replay, expired, malicious relayer).

const fs = require('node:fs')
const { JsonRpcProvider, Wallet } = require('ethers')
const {
  submitRelay,
  captureAccounts,
  diffAccounts
} = require('../build/.pipeline/submit-relay.js')
const {
  USDT0_TOKEN,
  POLYGON_CHAIN_ID
} = require('../build/.pipeline/relayer.js')

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const RPC = opt('--rpc') || process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com'
const FILE = args.find((a) => !a.startsWith('--'))
const RELAYER_PK = process.env.RELAYER_PRIVATE_KEY

if (!FILE || !RELAYER_PK) {
  console.error('Usage: RELAYER_PRIVATE_KEY=0x.. node scripts/relay-submit.cjs <authorization.json> [--rpc URL]')
  process.exit(2)
}

const reviver = (key, value) => {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    if (key === 'chainId') {
      return Number(value)
    }
    if (key === 'value' || key === 'nonce' || key === 'deadline' || key === 'amount') {
      return BigInt(value)
    }
  }
  return value
}

let raw
try {
  raw = JSON.parse(fs.readFileSync(FILE, 'utf8'), reviver)
} catch (err) {
  console.error(`Cannot read ${FILE}:`, err.message)
  process.exit(2)
}

const auth = {
  ...raw.authorization,
  permit: { ...raw.authorization.permit },
  order: { ...raw.authorization.order }
}
const intent = raw.intent

const provider = new JsonRpcProvider(RPC, POLYGON_CHAIN_ID)

;(async () => {
  const network = await provider.getNetwork()
  console.error(`Chain: ${network.chainId} (expected 137)`)
  if (Number(network.chainId) !== POLYGON_CHAIN_ID) throw new Error(`Wrong chain ${network.chainId}`)

  const relayerWallet = new Wallet(RELAYER_PK, provider)
  const relayer = relayerWallet.address
  console.error(`Relayer: ${relayer}`)
  console.error(`Relay contract: ${raw.relay}`)
  console.error(`User: ${auth.order.from}`)
  console.error(`Recipient: ${auth.order.to}`)
  console.error(`Amount: ${auth.order.amount.toString()} wei USDT0`)

  if (String(auth.order.token).toLowerCase() !== USDT0_TOKEN.toLowerCase()) {
    throw new Error('Order token is not USDT0')
  }

  const before = await captureAccounts(provider, {
    user: auth.order.from,
    recipient: auth.order.to,
    relayer
  })

  const result = await submitRelay(
    { intent, authorization: auth },
    { provider, relayWallet: relayerWallet, relayAddress: raw.relay }
  )

  if (!result.success) {
    console.error('submitRelay FAILED:', result.error)
    process.exit(1)
  }

  console.error('TX submitted:', result.txHash)
  console.error('Gas used:', result.gasUsed)

  const after = await captureAccounts(provider, {
    user: auth.order.from,
    recipient: auth.order.to,
    relayer
  })

  const checks = diffAccounts(before, after, auth.order.amount)
  console.error('\n═══════════════════════════════════════════')
  console.error(' ON-CHAIN VERIFICATION')
  console.error('═══════════════════════════════════════════')
  let ok = true
  for (const c of checks) {
    console.error(`  ${c.pass ? '[PASS]' : '[FAIL]'}: ${c.label} — ${c.detail}`)
    if (!c.pass) ok = false
  }
  console.error(`  [${result.evidence.permitSigner.toLowerCase() === auth.order.from.toLowerCase() ? 'PASS' : 'FAIL'}]: Permit signer recovered = payer`)
  console.error(`  [${result.evidence.relaySigner.toLowerCase() === auth.order.from.toLowerCase() ? 'PASS' : 'FAIL'}]: RelayOrder signer recovered = payer`)
  console.error(`  [${result.evidence.relayNonceUsedBefore === false && result.evidence.relayNonceUsedAfter === true ? 'PASS' : 'FAIL'}]: Relay nonce consumed (${result.evidence.relayNonceUsedBefore} -> ${result.evidence.relayNonceUsedAfter})`)
  console.error(`  [${result.evidence.tokenNonceSigned === result.evidence.tokenNonceOnChain ? 'PASS' : 'FAIL'}]: Token nonce on-chain matches signed`)

  const final = {
    success: ok && result.success,
    txHash: result.txHash,
    gasUsed: result.gasUsed,
    chainId: POLYGON_CHAIN_ID,
    relay: raw.relay,
    user: auth.order.from,
    recipient: auth.order.to,
    amountWei: auth.order.amount.toString(),
    checks,
    domino: 'REAL POLYGON'
  }
  console.log(JSON.stringify(final, null, 2))

  process.exit(ok ? 0 : 1)
})().catch((err) => {
  console.error('relay-submit FAILED:', err.message)
  process.exit(1)
})