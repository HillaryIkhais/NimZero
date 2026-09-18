// Mint NIM-USDT on the Sepolia NimZero stack to any address.
//   ZERO_TOKEN=0x.. USER_ADDRESS=0x.. [AMOUNT=100] npm run mint:sepolia
//
// The deployer wallet from .sepolia/secrets.json pays the mint gas (via the
// permissionless TestUSDT.mint). USER_ADDRESS is only ever a target address —
// never a signer, and it stays at 0 ETH on purpose.
//
// The token's mint() is public, so this works even if someone else deployed
// the stack. Prints only public addresses; keys are never printed.

const { JsonRpcProvider, Contract } = require('ethers')
const { ensureWallets } = require('./lib/sepolia-wallets.cjs')

const CHAIN_ID = 11155111
const RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
const TOKEN = process.env.ZERO_TOKEN
const USER = process.env.USER_ADDRESS
const AMOUNT = Number(process.env.AMOUNT || 100)
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

;(async () => {
  if (!TOKEN || !ADDRESS_RE.test(TOKEN)) {
    console.error('[usage] ZERO_TOKEN required — the deployed NIM-USDT address (0x + 40 hex).')
    process.exit(2)
  }
  if (!USER || !ADDRESS_RE.test(USER)) {
    console.error('[usage] USER_ADDRESS required — 0x + 40 hex.')
    process.exit(2)
  }

  const provider = new JsonRpcProvider(RPC, CHAIN_ID)
  const { deployer } = ensureWallets(provider)
  console.log('deployer  :', deployer.address, '(pays mint gas)')

  const token = new Contract(
    TOKEN,
    ['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'],
    deployer
  )

  const amountWei = BigInt(Math.round(AMOUNT * 1e6))
  console.log('minting   :', AMOUNT, 'NIM-USDT ->', USER)
  await (await token.mint(USER, amountWei)).wait()

  const [symbol, balance] = await Promise.all([token.symbol(), token.balanceOf(USER)])
  console.log('result    :', (Number(balance) / 1e6).toFixed(2), String(symbol), '->', USER, '(ETH stays 0)')
})().catch((err) => {
  console.error('mint-sepolia FAILED:', err)
  process.exit(1)
})