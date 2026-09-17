// REAL-POLYGON-STYLE KILL TEST against a hardhat fork node.
// Proves, through the exact `submitRelay` entrypoint that the real
// `relay-submit.cjs` uses, that every tampered request FAILS while the
// legitimate one SUCCEEDS.
//
//   npx hardhat node && npx hardhat run scripts/killtest.cjs --network localhost
//
// Requires: npm run relay:build (compiled pipeline) beforehand.
const { ethers, network } = require('hardhat')

const USDT0 = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
const WHALE = '0xf89d7b9c864f589bbF53a82105107622B35EaA40'

const relayer = require('../build/.pipeline/relayer.js')
const submitRelayLib = require('../build/.pipeline/submit-relay.js')
const { createPaymentIntent } = require('../build/.pipeline/payment-intent.js')

const USER_KEY = '0xa1fb4d7dbe4a6069d86dfb8f3724f769e0c1254dd0f70cda17477f6ec24a05dc'
const RECIPIENT_KEY = '0x39b685aa25be121ffef90ed65973fcca0d7688dd56ac20df96db5ccd767f7842'
const RELAYER_KEY = '0x7d7019567960a7cd83b76f3442dfaf259116d1f9fafc333c94088f968ad72005'

async function main() {
  const user = new ethers.Wallet(USER_KEY, ethers.provider)
  const recipient = new ethers.Wallet(RECIPIENT_KEY, ethers.provider)
  const relayerWallet = new ethers.Wallet(RELAYER_KEY, ethers.provider)
  const usdt = await ethers.getContractAt('IERC20Permit', USDT0)

  // fund user once (USDT0 via whale), relayer once (POL), user POL = 0
  await network.provider.request({ method: 'hardhat_impersonateAccount', params: [WHALE] })
  const whale = await ethers.getSigner(WHALE)
  const [deployer] = await ethers.getSigners()
  await usdt.connect(whale).transfer(user.address, ethers.parseUnits('1000', 6))
  await deployer.sendTransaction({ to: relayerWallet.address, value: ethers.parseEther('5') })
  await network.provider.send('hardhat_setBalance', [user.address, '0x0'])
  const userPol = (await ethers.provider.getBalance(user.address)).toString()
  if (userPol !== '0') throw new Error('user must be gasless (0 POL)')

  const stderr = (...a) => console.error(...a)
  const results = []

  const deployRelay = async () => {
    const Relay = await ethers.getContractFactory('ZeroPayRelay')
    const r = await Relay.deploy(USDT0)
    await r.waitForDeployment()
    return r.getAddress()
  }

  const signFresh = async (relayAddr, recipientAddr, amount = 1) => {
    const nonce = await usdt.nonces(user.address)
    const intent = createPaymentIntent(user.address, recipientAddr, amount)
    const auth = await relayer.createSignedAuthorization(intent, user, relayAddr, nonce)
    return { intent, auth, nonce }
  }

  const submit = async (intent, auth, relayAddr) => {
    return submitRelayLib.submitRelay(
      { intent, authorization: auth },
      { provider: ethers.provider, relayWallet: relayerWallet, relayAddress: relayAddr }
    )
  }

  const record = (label, expected, res) => {
    const got = res.success ? 'SUCCESS' : 'FAIL'
    const pass = got === expected
    results.push({ label, expected, got, error: (res.error || '').slice(0, 140) })
    stderr(`  [${pass ? 'PASS' : 'FAIL'}]: ${label} → ${got}${res.error ? ` (${res.error.slice(0, 140)})` : ''}`)
    return pass
  }

  stderr('\n═══════════════════════════════════════════')
  stderr(' REAL-POLYGON-STYLE KILL TEST (fork node)')
  stderr('═══════════════════════════════════════════')
  stderr(`User (gasless): ${user.address}`)
  stderr(`Recipient:      ${recipient.address}`)
  stderr(`Relayer:        ${relayerWallet.address}`)

  // ── 1. LEGIT: fresh relay, real submitRelay ──
  let pass = true
  const legitRelay = await deployRelay()
  const balBefore = await usdt.balanceOf(user.address)
  const recBefore = await usdt.balanceOf(recipient.address)
  const { intent, auth } = await signFresh(legitRelay, recipient.address)
  const legitRes = await submit(intent, auth, legitRelay)
  const balAfter = await usdt.balanceOf(user.address)
  const recAfter = await usdt.balanceOf(recipient.address)
  pass = record('LEGIT payment (submitRelay)', 'SUCCESS', legitRes) && pass

  // ── 2. REPLAY: re-submit identical signatures on same relay ──
  const replayRes = await submit(intent, auth, legitRelay)
  pass = record('REPLAY: reuse same signatures', 'FAIL', replayRes) && pass

  // ── 3. TAMPER cases: fresh relay each so failure is crypto-level ──
  const cases = [
    ['TAMPER: change recipient (to)', (a) => ({ ...a, order: { ...a.order, to: '0x1111111111111111111111111111111111111111' } })],
    ['TAMPER: change amount', (a) => ({ ...a, order: { ...a.order, amount: a.order.amount + 1n } })],
    ['TAMPER: change token', (a) => ({ ...a, order: { ...a.order, token: '0x1111111111111111111111111111111111111111' } })],
    ['TAMPER: change chainId', (a) => ({ ...a, order: { ...a.order, chainId: 1 } })],
    ['TAMPER: expired deadline', (a) => ({ ...a, order: { ...a.order, deadline: BigInt(Math.floor(Date.now() / 1000) - 10) }, permit: { ...a.permit, deadline: BigInt(Math.floor(Date.now() / 1000) - 10) } })],
    ['TAMPER: substitute another permit', (a) => ({ ...a, permit: { ...a.permit, nonce: a.permit.nonce + 1n }, permitSignature: '0x' + '11'.repeat(65) })],
    ['TAMPER: client-supplied relay != pinned relay', (a) => ({ ...a, relay: '0x2222222222222222222222222222222222222222' })],
    ['TAMPER: malicious relayer (authorization relay mismatch)', (a) => ({ ...a, relay: '0x2222222222222222222222222222222222222222', order: { ...a.order, nonce: a.order.nonce + 1n }, permit: { ...a.permit, nonce: a.permit.nonce + 1n } })]
  ]

  for (const [label, mutate] of cases) {
    const r = await deployRelay()
    const signed = await signFresh(r, recipient.address)
    const res = await submit(signed.intent, mutate(signed.auth), r)
    pass = record(label, 'FAIL', res) && pass
  }

  // ── 4. Cross-check: account state after legit payment on-chain ──
  const chainOk = balBefore - balAfter === ethers.parseUnits('1', 6) && recAfter - recBefore === ethers.parseUnits('1', 6)
  stderr(`  [${chainOk ? 'PASS' : 'FAIL'}]: On-chain balances after LEGIT (user -1, recipient +1) → user ${ethers.formatUnits(balBefore, 6)}→${ethers.formatUnits(balAfter, 6)}, recipient ${ethers.formatUnits(recBefore, 6)}→${ethers.formatUnits(recAfter, 6)}`)
  pass = chainOk && pass

  stderr('\n───────────────────────────────────────')
  for (const r of results) {
    stderr(`  ${r.expected === r.got ? '[PASS]' : '[FAIL]'}: ${r.label} — expected ${r.expected}, got ${r.got}`)
  }
  stderr('\n═══════════════════════════════════════════')
  stderr(pass ? ' KILL TEST: PASS' : ' KILL TEST: FAIL')
  stderr('═══════════════════════════════════════════')
  console.log(JSON.stringify({ pass, results }, null, 2))
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('KILL TEST ERROR:', e)
  process.exit(1)
})