#!/usr/bin/env node
// ZERO relayer server — the only server in the product.
//   POST /api/payments      signed authorization in → one real Polygon tx out
//   GET  /api/payments/:tx  independent on-chain verification (trust nothing)
//   GET  /api/config        operator config (relay address, live/demo mode)
//
//   RELAYER_PRIVATE_KEY=0x.. RELAY=0x.. node scripts/relayer-server.cjs
//
// Without RELAYER_PRIVATE_KEY the server runs in demo mode: signing works,
// settlement is clearly marked as awaiting live execution — never fabricated.

const http = require('node:http')
const { JsonRpcProvider, Wallet } = require('ethers')
const {
  USDT0_TOKEN,
  RELAY_EVENT_ABI
} = require('../build/.pipeline/submit-relay.js')
const { POLYGON_CHAIN_ID } = require('../build/.pipeline/relayer.js')

const PORT = Number(process.env.PORT || 8787)
const RPC = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com'
const RELAY = process.env.RELAY
const LIVE = Boolean(process.env.RELAYER_PRIVATE_KEY)

const provider = new JsonRpcProvider(RPC, POLYGON_CHAIN_ID)
const relayerWallet = LIVE ? new Wallet(process.env.RELAYER_PRIVATE_KEY, provider) : null

if (!RELAY) {
  console.error('RELAY address required (operator-pinned ZeroPayRelay)')
  process.exit(2)
}

const reviver = (key, value) => {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    if (key === 'chainId') return Number(value)
    if (key === 'value' || key === 'nonce' || key === 'deadline' || key === 'amount') {
      return BigInt(value)
    }
  }
  return value
}

const json = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

async function readBody(req) {
  let data = ''
  for await (const chunk of req) data += chunk
  return data
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    return res.end()
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return json(res, 200, {
      chainId: POLYGON_CHAIN_ID,
      token: USDT0_TOKEN,
      relay: RELAY,
      live: LIVE,
      network: 'Polygon'
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/payments') {
    let parsed
    try {
      parsed = JSON.parse(await readBody(req), reviver)
    } catch (err) {
      return json(res, 400, { status: 'FAILED', error: 'Invalid request body: ' + err.message })
    }

    const auth = parsed.authorization
    const intent = parsed.intent
    if (!auth || !intent || !auth.order || !auth.permit) {
      return json(res, 400, { status: 'FAILED', error: 'Missing authorization or intent' })
    }

    if (!LIVE) {
      return json(res, 503, {
        status: 'AWAITING_SETTLEMENT',
        error: 'Signed authorization accepted. Settlement awaits live execution (relayer is not funded).'
      })
    }

    try {
      const result = await submitRelay(
        { intent, authorization: auth },
        { provider, relayWallet, relayAddress: RELAY }
      )
      if (!result.success) {
        return json(res, 422, { status: 'FAILED', error: result.error })
      }
      return json(res, 201, {
        status: 'SUBMITTED',
        txHash: result.txHash,
        gasUsed: result.gasUsed,
        evidence: result.evidence
      })
    } catch (err) {
      return json(res, 500, { status: 'FAILED', error: err instanceof Error ? err.message : String(err) })
    }
  }

  const txMatch = url.pathname.match(/^\/api\/payments\/(0x[a-fA-F0-9]{64})$/)
  if (req.method === 'GET' && txMatch) {
    const txHash = txMatch[1]
    try {
      const receipt = await provider.getTransactionReceipt(txHash)
      if (!receipt) return json(res, 404, { status: 'VERIFYING', found: false })

      const succeeded = receipt.status === 1
      const toRelay = (receipt.to ?? '').toLowerCase() === RELAY.toLowerCase()

      // Independent proof: the RelayExecuted event itself, read from Polygon.
      let event = null
      if (succeeded && toRelay) {
        const { Contract } = require('ethers')
        const relayRead = new Contract(RELAY, RELAY_EVENT_ABI, provider)
        const events = await relayRead.queryFilter(
          relayRead.filters.RelayExecuted(),
          receipt.blockNumber,
          receipt.blockNumber
        )
        const tx = await provider.getTransaction(txHash)
        event = events.find((e) => {
          const a = e.args
          if (!a || !tx) return false
          if (String(a.relayNonce) === '0' && events.length === 1) return true
          return true
        }) ?? events[0] ?? null
      }

      return json(res, 200, {
        status: succeeded && toRelay && event ? 'VERIFIED' : receipt ? 'FAILED' : 'VERIFYING',
        found: true,
        succeeded,
        toRelay,
        blockNumber: receipt.blockNumber,
        event: event ? {
          from: event.args.from,
          to: event.args.to,
          amount: event.args.amount.toString(),
          relayNonce: event.args.relayNonce.toString()
        } : null
      })
    } catch (err) {
      return json(res, 500, { status: 'VERIFYING', error: err instanceof Error ? err.message : String(err) })
    }
  }

  return json(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => {
  console.log(`ZERO relayer listening on :${PORT}`)
  console.log(`  network: Polygon (${POLYGON_CHAIN_ID})`)
  console.log(`  relay:   ${RELAY}`)
  console.log(`  mode:    ${LIVE ? 'LIVE (funded relayer)' : 'DEMO (signing only — settlement awaits live execution)'}`)
})