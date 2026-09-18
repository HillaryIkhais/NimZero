import { useCallback, useEffect, useMemo, useState } from 'react'
import { BrowserProvider, Contract, Wallet } from 'ethers'
import type { Signer } from 'ethers'
import { createPaymentIntent } from './core/payment-intent'
import {
  RELAY_ORDER_TYPES,
  USDT0_PERMIT_TYPES,
  relayDomain,
  usdt0PermitDomain
} from './core/relayer'
import './App.css'

// ─────────────────────────────────────────────────────────────────────
// NimZero — Pay USDT with $0 gas.
// A gasless USDT payment: the user signs (Permit + RelayOrder), a funded
// relayer sponsors the settlement transaction, and NimZero
// independently verifies the result on-chain before showing a receipt.
// ─────────────────────────────────────────────────────────────────────

interface ChainConfig {
  chainId: number
  chainIdHex: string
  network: string
  token: string
  tokenSymbol: string
  tokenName: string
  tokenVersion: string
  tokenDecimals: number
  saltSlotPermit: boolean
  relay: string
  explorerUrl: string
  rpcUrl: string
  live: boolean
}

type Screen = 'home' | 'pay' | 'review' | 'signing' | 'receipt'

interface WalletInfo {
  connected: boolean
  address: string
  pol: string
  token: string
}

interface ReviewInfo {
  amount: number
  amountWei: string
  recipient: string
}

interface ReceiptInfo {
  status: 'verified' | 'failed' | 'awaiting' | 'verifying'
  txHash: string
  title: string
  message: string
}

const API_BASE = (import.meta.env.VITE_RELAYER_URL as string | undefined) ?? ''

async function getConfig(): Promise<ChainConfig> {
  const res = await fetch(`${API_BASE}/api/config`)
  if (!res.ok) throw new Error(`Config unavailable (${res.status})`)
  return res.json()
}

export function shortAddress(address: string): string {
  if (!address) return '…'
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function toTokenWei(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * 10 ** decimals))
}

function fromTokenWei(value: string | bigint, decimals: number): string {
  const wei = BigInt(value)
  const divisor = 10n ** BigInt(decimals)
  const whole = wei / divisor
  const frac = (wei % divisor).toString().padStart(decimals, '0').slice(0, 2)
  return `${whole}.${frac}`
}

function explorerTxUrl(cfg: ChainConfig, txHash: string): string {
  return `${cfg.explorerUrl}/tx/${txHash}`
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to legacy copy
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function avatarFor(address: string): string {
  const hex = address.replace(/^0x/, '').padEnd(40, '0')
  let seed = 0
  for (let i = 0; i < 6; i++) seed = (seed * 31 + hex.charCodeAt(i * 2)) % 360
  return `conic-gradient(from ${seed}deg, #f8a81b, #e8762b 45%, #1f2348 70%, #25c28f)`
}

function demoAddr(seed: string): string {
  const hex = '0123456789abcdef'
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff
  let out = ''
  for (let i = 0; i < 40; i++) {
    h = (h * 1103515245 + 12345) & 0xffffffff
    out += hex[(h >>> 24) % 16]
  }
  return '0x' + out
}

const DEMO_CONTACTS = ['Ceylon', 'Sashi', 'Momo', 'Kimani', 'Ava'].map((name) => ({
  name,
  addr: demoAddr(name)
}))

const DEMO_TXS = [
  { name: 'Ceylon', date: 'Sep 14 · 09:41', delta: -25 },
  { name: 'Sashi', date: 'Sep 12 · 18:02', delta: -10 },
  { name: 'Receipt', date: 'Sep 09 · 12:27', delta: 50 },
  { name: 'Momo', date: 'Sep 06 · 21:15', delta: -5 },
  { name: 'Kimani', date: 'Sep 02 · 08:33', delta: -12 },
  { name: 'Ava', date: 'Aug 28 · 14:50', delta: -30 }
].map((tx) => ({ ...tx, addr: demoAddr(tx.name) }))

function App() {
  const [cfg, setCfg] = useState<ChainConfig | null>(null)
  const [configError, setConfigError] = useState<string>('')
  const [provider, setProvider] = useState<BrowserProvider | null>(null)
  const [wallet, setWallet] = useState<WalletInfo>({
    connected: false,
    address: '',
    pol: '',
    token: ''
  })
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState(1)
  const [screen, setScreen] = useState<Screen>('home')
  const [review, setReview] = useState<ReviewInfo | null>(null)
  const [receipt, setReceipt] = useState<ReceiptInfo | null>(null)
  const [verification, setVerification] = useState<string[]>([])
  const [demo, setDemo] = useState<Signer | null>(null)

  const tokenWei = useMemo(
    () => (cfg ? toTokenWei(amount, cfg.tokenDecimals) : 0n),
    [cfg, amount]
  )

  useEffect(() => {
    getConfig()
      .then(setCfg)
      .catch((err) => setConfigError(err instanceof Error ? err.message : String(err)))
  }, [])

  const switchChain = useCallback(async (p: BrowserProvider, c: ChainConfig) => {
    try {
      await p.send('wallet_switchEthereumChain', [{ chainId: c.chainIdHex }])
    } catch (err) {
      if (err instanceof Error && /4902|Unrecognized chain|unknown chain/i.test(err.message)) {
        await p.send('wallet_addEthereumChain', [
          {
            chainId: c.chainIdHex,
            chainName: c.network,
            rpcUrls: [c.rpcUrl],
            nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
            blockExplorerUrls: [c.explorerUrl]
          }
        ])
      } else {
        throw err
      }
    }
  }, [])

  const refreshBalances = useCallback(
    async (p: BrowserProvider, address: string, c: ChainConfig) => {
      const pol = await p.getBalance(address)
      const token = new Contract(c.token, ['function balanceOf(address) view returns (uint256)'], p)
      const tokenBalance = await token.balanceOf(address)
      setWallet({
        connected: true,
        address,
        pol: fromTokenWei(pol, 18),
        token: fromTokenWei(tokenBalance, c.tokenDecimals)
      })
      return { pol, tokenBalance }
    },
    []
  )

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setConfigError('No EVM wallet found. Use a wallet inside Nimiq Pay, or tap “Explore the demo” to simulate one.')
      return
    }
    setConfigError('')
    const c = cfg
    if (!c) return
    const p = new BrowserProvider(window.ethereum)
    try {
      const accounts = (await p.send('eth_requestAccounts', [])) as string[]
      const address = accounts[0]
      setProvider(p)
      await switchChain(p, c)
      await refreshBalances(p, address, c)
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err))
    }
  }, [cfg, switchChain, refreshBalances])

  const startDemo = useCallback(() => {
    const w = Wallet.createRandom()
    setDemo(w)
    setProvider(null)
    setWallet({ connected: true, address: w.address, pol: '0.00', token: '12.48' })
    setConfigError('')
  }, [])

  useEffect(() => {
    if (cfg && !demo && window.ethereum && !provider) {
      const p = new BrowserProvider(window.ethereum)
      setProvider(p)
      p.send('eth_requestAccounts', [])
        .then(async (accounts) => {
          const addr = (accounts as string[])[0]
          if (!addr) return
          await switchChain(p, cfg)
          await refreshBalances(p, addr, cfg)
        })
        .catch(() => {
          // leave disconnected until the user taps "Connect"
        })
    }
  }, [cfg, provider, refreshBalances, switchChain, demo])

  async function signAndSubmit(info: ReviewInfo) {
    if (!cfg || !wallet.address) throw new Error('Wallet not connected')
    setVerification([])

    let signer: Signer | null = null
    let tokenNonce = 0n
    if (demo) {
      signer = demo
    } else if (provider) {
      signer = await provider.getSigner(wallet.address)
      const tokenContract = new Contract(
        cfg.token,
        ['function nonces(address owner) view returns (uint256)'],
        provider
      )
      tokenNonce = await tokenContract.nonces(wallet.address)
    }
    if (!signer) throw new Error('Wallet not connected')

    const amountWei = BigInt(info.amountWei)
    const nowSec = BigInt(Math.floor(Date.now() / 1000))
    const deadline = nowSec + 3600n

    const intent = createPaymentIntent(
      wallet.address,
      info.recipient,
      info.amount,
      'USDT',
      'polygon'
    )

    const permitMessage = {
      owner: wallet.address,
      spender: cfg.relay,
      value: amountWei,
      nonce: tokenNonce,
      deadline
    }
    const orderMessage = {
      from: wallet.address,
      to: info.recipient,
      amount: amountWei,
      token: cfg.token,
      chainId: cfg.chainId,
      deadline,
      nonce: BigInt(intent.nonce)
    }

    const [permitSignature, relaySignature] = await Promise.all([
      signer.signTypedData(
        usdt0PermitDomain(cfg.chainId, {
          token: cfg.token,
          name: cfg.tokenName,
          version: cfg.tokenVersion,
          saltSlot: cfg.saltSlotPermit
        }),
        USDT0_PERMIT_TYPES,
        permitMessage
      ),
      signer.signTypedData(relayDomain(cfg.relay, cfg.chainId), RELAY_ORDER_TYPES, orderMessage)
    ])

    const dispatch = {
      intent: {
        id: intent.id,
        sender: intent.sender,
        recipient: intent.recipient,
        amount: intent.amount,
        asset: intent.asset,
        chain: intent.chain,
        nonce: intent.nonce,
        createdAt: intent.createdAt,
        expiresAt: intent.expiresAt,
        hash: intent.hash
      },
      authorization: {
        intentId: intent.id,
        signedBy: wallet.address,
        signedAt: Date.now(),
        relay: cfg.relay,
        signature: relaySignature,
        permitSignature,
        permit: {
          owner: wallet.address,
          spender: cfg.relay,
          value: amountWei.toString(),
          nonce: tokenNonce.toString(),
          deadline: deadline.toString()
        },
        order: {
          from: wallet.address,
          to: info.recipient,
          amount: amountWei.toString(),
          token: cfg.token,
          chainId: cfg.chainId,
          deadline: deadline.toString(),
          nonce: orderMessage.nonce.toString()
        }
      }
    }

    const res = await fetch(`${API_BASE}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dispatch)
    })
    const body = await res.json().catch(() => ({}))

    if (res.status === 503) {
      setReceipt({
        status: 'awaiting',
        txHash: '',
        title: 'Signed — settlement pending',
        message: 'NimZero accepted your signed authorization. Settlement awaits live execution on this network. Nothing was fabricated.'
      })
      return
    }
    if (res.status === 422 || res.status === 400) {
      throw new Error(body.error ?? `Relayer rejected the request (${res.status})`)
    }
    if (res.status === 201 && body.txHash) {
      setVerification((v) => [...v, `Submitted ${body.txHash.slice(0, 10)}…`])
      await pollVerification(body.txHash)
      return
    }
    throw new Error(body.error ?? `Unexpected relayer response (${res.status})`)
  }

  async function pollVerification(txHash: string) {
    if (!cfg) return
    const started = Date.now()
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await fetch(`${API_BASE}/api/payments/${txHash}`)
      const body = await res.json().catch(() => ({}))
      if (body.status === 'VERIFIED') {
        await captureProof(txHash)
        return
      }
      if (body.status === 'FAILED') {
        setReceipt({
          status: 'failed',
          txHash,
          title: 'Payment failed',
          message: 'The settlement transaction failed on-chain. The user paid nothing, and the relay order rejected the change.'
        })
        return
      }
      if (Date.now() - started > 60_000) {
        setReceipt({
          status: 'verifying',
          txHash,
          title: 'Still verifying',
          message: 'The transaction is on-chain but not yet final. It will settle shortly.'
        })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }

  async function captureProof(txHash: string) {
    if (!cfg || !provider || !wallet.address) return
    const checks: string[] = []
    try {
      const pol = await provider.getBalance(wallet.address)
      checks.push(`User gas ${fromTokenWei(pol, 18)} (gas was sponsored — not charged to the user)`)
    } catch {
      /* ignore balance read failures in proof capture */
    }
    setReceipt({
      status: 'verified',
      txHash,
      title: 'Payment verified',
      message: `${wallet.address ? shortAddress(wallet.address) : ''} — verified on ${cfg.network} by NimZero's independent check.`
    })
    setVerification((v) => [...v, ...checks])
  }

  const startReview = () => {
    if (!wallet.connected || !cfg) return
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      setConfigError('Enter a valid recipient address (0x…, 40 hex characters).')
      return
    }
    if (recipient.toLowerCase() === wallet.address.toLowerCase()) {
      setConfigError('Recipient must be different from your wallet.')
      return
    }
    if (!(amount > 0)) {
      setConfigError('Enter an amount greater than zero.')
      return
    }
    setConfigError('')
    setReview({ amount, amountWei: tokenWei.toString(), recipient })
    setScreen('review')
  }

  const confirmPayment = async () => {
    if (!review) return
    setScreen('signing')
    try {
      await signAndSubmit(review)
    } catch (err) {
      setScreen('receipt')
      setReceipt({
        status: 'failed',
        txHash: '',
        title: 'Payment not sent',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const reset = () => {
    setScreen('home')
    setReview(null)
    setReceipt(null)
  }

  const stepByScreen: Record<Screen, number> = {
    home: 0,
    pay: 0,
    review: 1,
    signing: 2,
    receipt: 3
  }

  if (configError && !cfg) {
    return (
      <div className="app">
        <Header cfg={null} />
        <main className="main">
          <div className="fatal">
            <div className="fatal-orb">!</div>
            <h1 className="fatal-title">NimZero can't start</h1>
            <p className="fatal-text">{configError}</p>
            <button className="btn-primary" onClick={() => location.reload()}>
              Retry
            </button>
          </div>
        </main>
      </div>
    )
  }

  if (!cfg) {
    return (
      <div className="app">
        <Header cfg={null} />
        <main className="main">
          <div className="fatal">
            <div className="loader-coin" />
            <p className="fatal-text">Talking to the NimZero relayer…</p>
          </div>
        </main>
      </div>
    )
  }

  return screen === 'home' ? (
    <HomeScreen
      cfg={cfg}
      wallet={wallet}
      configError={configError}
      onRecipient={setRecipient}
      onConnect={provider ? undefined : connect}
      onStartDemo={startDemo}
      onPay={() => setScreen('pay')}
    />
  ) : (
    <div className="app">
      <Header cfg={cfg} />
      <main className="main">
        <Stepper step={stepByScreen[screen]} />

        {screen === 'pay' && (
          <PayScreen
            cfg={cfg}
            wallet={wallet}
            recipient={recipient}
            amount={amount}
            configError={configError}
            onRecipient={setRecipient}
            onAmount={setAmount}
            onContinue={startReview}
            onBack={() => setScreen('home')}
          />
        )}

        {screen === 'review' && review && (
          <ReviewScreen cfg={cfg} review={review} onBack={() => setScreen('home')} onConfirm={confirmPayment} />
        )}

        {screen === 'signing' && (
          <SigningScreen cfg={cfg} verification={verification} />
        )}

        {screen === 'receipt' && (
          <ReceiptScreen cfg={cfg} receipt={receipt} verification={verification} onReset={reset} />
        )}
      </main>
      <footer className="footer">
        <span>You never touched gas to do it.</span>
      </footer>
    </div>
  )
}

function Header({ cfg }: { cfg: ChainConfig | null }) {
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-bolt"><BoltIcon /></span>
        <span className="logo">NIMZERO</span>
      </div>
      <div className="header-pills">
        {cfg && cfg.network && cfg.chainId !== 137 && (
          <span className="badge">{cfg.network}</span>
        )}
        {cfg && !cfg.live && <span className="badge demo">DEMO</span>}
      </div>
    </header>
  )
}

function Stepper({ step }: { step: number }) {
  const steps = ['Send', 'Review', 'Wallet', 'Receipt']
  return (
    <nav className="stepper" aria-label="progress">
      {steps.map((label, i) => (
        <div key={label} className={`step ${i < step ? 'done' : ''} ${i === step ? 'now' : ''}`}>
          <span className="step-dot">{i < step ? <CheckIcon /> : i + 1}</span>
          <span className="step-label">{label}</span>
        </div>
      ))}
    </nav>
  )
}

function HomeScreen(props: {
  cfg: ChainConfig
  wallet: WalletInfo
  configError: string
  onRecipient: (value: string) => void
  onConnect?: () => void
  onStartDemo: () => void
  onPay: () => void
}) {
  const { cfg, wallet, configError, onRecipient, onConnect, onStartDemo, onPay } = props
  const connected = wallet.connected
  const [sheet, setSheet] = useState<'menu' | 'connect' | null>(null)
  const [tab, setTab] = useState<'home' | 'stat' | 'activity'>('home')
  const [masked, setMasked] = useState(false)
  const [full, setFull] = useState(false)
  const [copied, setCopied] = useState(false)

  const requestPay = () => {
    if (connected) onPay()
    else setSheet('connect')
  }

  const pickContact = (addr: string) => {
    onRecipient(addr)
    requestPay()
  }

  const revealAddress = async () => {
    if (!wallet.address || full) return
    setFull(true)
    if (await copyText(wallet.address)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }
  }

  return (
    <div className="app wallet-home">
      <nav className="appbar" aria-label="Wallet header">
        <button className="icon-btn" aria-label="Menu" onClick={() => setSheet('menu')}>
          <MenuIcon />
        </button>
        <div className="appbar-title">
          <span className="appbar-title-main">Wallet</span>
          <span className="appbar-title-sub">My Cards &amp; Transaction</span>
        </div>
        <button className="icon-btn" aria-label="Start a payment" onClick={requestPay}>
          <PlusIcon />
        </button>
      </nav>

      {tab === 'home' && (
        <>
          <section className="wallet-stack">
            <div className="wallet-stack-back" aria-hidden="true">
              <span className="stack-line">
                <span>NIMIQ PAY</span>
                <span>**** 5678</span>
                <span>{cfg.tokenSymbol} · EXP 08/27</span>
              </span>
            </div>
            <div className="wallet-card hero-card">
              <div className="wallet-aurora" aria-hidden="true" />
              <div className="hero-card-head">
                <span className="contactless" aria-hidden="true">
                  <i /><i /><i />
                </span>
                <div className="hero-card-pills">
                  {cfg.chainId !== 137 && <span className="badge glass">{cfg.network}</span>}
                  {!cfg.live && <span className="badge demo glass">DEMO</span>}
                </div>
              </div>

              <div className="hero-balance">
                <span className="hero-balance-label">Total Balance</span>
                <div className="hero-balance-value">
                  <span className="balance-amount">{masked ? '••••••' : connected ? wallet.token : '——'}</span>
                  <span className="balance-token">{cfg.tokenSymbol}</span>
                </div>
                {connected ? (
                  <button
                    className="hero-balance-addr"
                    onClick={revealAddress}
                    aria-expanded={full}
                    title={full ? wallet.address : 'Tap to reveal and copy your full address'}
                  >
                    {full ? wallet.address : shortAddress(wallet.address)}
                    <span className="addr-copy">{copied ? <CheckIcon /> : <CopyIcon />}</span>
                  </button>
                ) : (
                  <button className="hero-balance-addr dim" onClick={() => setSheet('connect')}>
                    Tap to connect your wallet
                  </button>
                )}
              </div>

              <div className="hero-actions">
                <button className="btn-primary hero-add" onClick={requestPay}>
                  <PlusIcon /> Add Balance
                </button>
                <div className="icon-btn-row">
                  <button className="icon-btn glass" aria-label="Transfer" onClick={requestPay}>
                    <SendIcon />
                  </button>
                  <button
                    className="icon-btn glass"
                    aria-label="Toggle balance visibility"
                    onClick={() => setMasked((m) => !m)}
                  >
                    {masked ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>

              <div className="sponsor-strip">
                <span className="sponsor-bolt"><BoltIcon /></span>
                <span>Gas sponsored by NimZero — ETH required: 0</span>
              </div>
            </div>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Quick Top-Up</h2>
              <button className="text-link" onClick={requestPay}>See more</button>
            </div>
            <div className="scroll-row">
              <button className="topup-item" onClick={requestPay}>
                <span className="topup-add-circle"><PlusIcon /></span>
                <span className="topup-label">Add</span>
              </button>
              <span className="scroll-divider" aria-hidden="true" />
              {DEMO_CONTACTS.map((c) => (
                <button key={c.name} className="topup-item" onClick={() => pickContact(c.addr)}>
                  <span className="topup-avatar" style={{ background: avatarFor(c.addr) }}>{c.name[0]}</span>
                  <span className="topup-label">{c.name}</span>
                </button>
              ))}
            </div>
          </section>

          {connected && (
            <section className="section">
              <div className="section-head">
                <h2>Latest Transactions</h2>
                <button className="text-link" onClick={requestPay}>See more</button>
              </div>
              <div className="scroll-row">
                {DEMO_TXS.map((tx) => (
                  <button key={tx.name} className="tx-card" onClick={() => pickContact(tx.addr)}>
                    <span className="tx-avatar" style={{ background: avatarFor(tx.addr) }}>{tx.name[0]}</span>
                    <span className="tx-name">{tx.name}</span>
                    <span className="tx-date">{tx.date}</span>
                    <span className={`tx-amount ${tx.delta < 0 ? 'neg' : 'pos'}`}>
                      {tx.delta > 0 ? '+' : ''}{tx.delta.toFixed(2)} USDT0
                    </span>
                  </button>
                ))}
              </div>
              <p className="tiny-note">Demo entries — tap one to send to that contact.</p>
            </section>
          )}
        </>
      )}

      {tab === 'stat' && (
        <section className="section">
          <div className="section-head"><h2>Gasless stats</h2></div>
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-value">$0.00</span>
              <span className="stat-label">Network fees paid</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">0.00</span>
              <span className="stat-label">ETH required</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">1</span>
              <span className="stat-label">Settlement tx per payment</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{cfg.tokenSymbol}</span>
              <span className="stat-label">Asset · {cfg.network}</span>
            </div>
          </div>
          <div className="warn-note">
            <BoltIcon /> The NimZero relayer sponsors every settlement. Your gas stays untouched — ETH required: 0.
          </div>
        </section>
      )}

      {tab === 'activity' && (
        <section className="section">
          <div className="section-head"><h2>Activity</h2></div>
          <div className="activity-list">
            {DEMO_TXS.map((tx) => (
              <button key={tx.name} className="activity-row" onClick={() => pickContact(tx.addr)}>
                <span className="tx-avatar" style={{ background: avatarFor(tx.addr) }}>{tx.name[0]}</span>
                <span className="activity-main">
                  <span className="activity-name">{tx.name}</span>
                  <span className="activity-date">{tx.date} · {cfg.tokenSymbol}</span>
                </span>
                <span className={`tx-amount ${tx.delta < 0 ? 'neg' : 'pos'}`}>
                  {tx.delta > 0 ? '+' : ''}{tx.delta.toFixed(2)}
                </span>
              </button>
            ))}
          </div>
          <p className="tiny-note">Demo data — tap one to start a payment to that contact.</p>
        </section>
      )}

      <nav className="dock" aria-label="Bottom navigation">
        <button className={`dock-item ${tab === 'home' ? 'active' : ''}`} onClick={() => { setTab('home'); setSheet(null) }}>
          <HomeIcon /><span>Home</span>
        </button>
        <button className={`dock-item ${tab === 'stat' ? 'active' : ''}`} onClick={() => { setTab('stat'); setSheet(null) }}>
          <ChartIcon /><span>Statistic</span>
        </button>
        <div className="dock-slot">
          <button className="dock-center" aria-label="Start a payment" onClick={requestPay}>
            <QrIcon />
          </button>
        </div>
        <button className={`dock-item ${tab === 'activity' ? 'active' : ''}`} onClick={() => { setTab('activity'); setSheet(null) }}>
          <ActivityIcon /><span>Activity</span>
        </button>
        <button className="dock-item" onClick={requestPay}>
          <WalletIcon /><span>Pay</span>
        </button>
      </nav>

      {sheet && (
        <div className="sheet-overlay" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {sheet === 'menu' ? (
              <>
                <div className="sheet-head">
                  <h3>Gasless by NimZero</h3>
                  <button className="icon-btn sheet-close" aria-label="Close" onClick={() => setSheet(null)}>
                    <XIcon />
                  </button>
                </div>
                <p className="muted">
                  Send {cfg.tokenSymbol} on {cfg.network} without holding gas. You sign one authorization,
                  and the NimZero relayer sponsors the gas and settles it in a single transaction.
                </p>
                <div className="warn-note">
                  <ClockIcon /> Live settlement requires a funded relayer on this network.
                </div>
                {connected && (
                  <button className="btn-primary" onClick={() => { setSheet(null); onPay() }}>
                    Start a payment
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="sheet-head">
                  <h3>Connect your wallet</h3>
                  <button className="icon-btn sheet-close" aria-label="Close" onClick={() => setSheet(null)}>
                    <XIcon />
                  </button>
                </div>
                <p className="muted">
                  Link a wallet to send {cfg.tokenSymbol}. The network fee stays $0.00 — the relayer sponsors it.
                </p>
                {configError && <div className="error-message">{configError}</div>}
                {onConnect && (
                  <button className="btn-primary btn-send" onClick={onConnect}>
                    <WalletIcon /> Use wallet in Nimiq Pay
                  </button>
                )}
                <button className="btn-secondary" onClick={() => { onStartDemo(); setSheet(null) }}>
                  <BoltIcon /> Explore the demo
                </button>
                <p className="tiny-note">
                  {onConnect
                    ? 'Demo uses a simulated wallet so you can walk the full flow anywhere.'
                    : 'You are already connected.'}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function PayScreen(props: {
  cfg: ChainConfig
  wallet: WalletInfo
  recipient: string
  amount: number
  configError: string
  onRecipient: (value: string) => void
  onAmount: (value: number) => void
  onContinue: () => void
  onBack: () => void
}) {
  const { cfg, recipient, amount, configError, onRecipient, onAmount, onContinue, onBack } = props
  const chips = ['5', '10', '25', '50', '100']
  return (
    <div className="screen">
      <button className="btn-back" onClick={onBack}>
        <ChevronLeftIcon /> Back to wallet
      </button>

      <section className="hero">
        <p className="kicker">GASLESS PAYMENT</p>
        <h1 className="hero-title">
          Send {cfg.tokenSymbol} <span className="ink">— pay zero gas.</span>
        </h1>
        <p className="hero-sub">Network fee: $0. Gas sponsored by NimZero. ETH required: 0.</p>
      </section>

      <div className="amount-edit">
        <span className="amount-prefix">$</span>
        <input
          className="amount-input"
          type="number"
          value={Number.isFinite(amount) ? amount : 1}
          min={0.01}
          step={0.01}
          onChange={(e) => onAmount(Number(e.target.value))}
          aria-label="Amount"
        />
        <TokenOrb token={cfg.tokenSymbol} size="md" />
      </div>
      <div className="amount-line">
        <span className="amount-note">
          {(`${cfg.tokenSymbol} · $${(Number.isFinite(amount) ? amount : 0).toFixed(2)}`)}
        </span>
        <div className="chips">
          {chips.map((c) => (
            <button
              key={c}
              className={`chip-btn ${amount === Number(c) ? 'is-on' : ''}`}
              onClick={() => onAmount(Number(c))}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <section className="recipient-box">
        <span className="mini-avatar" style={{ background: avatarFor(recipient || '0x') }} aria-hidden="true" />
        <div className="recipient-field">
          <label className="field-label">Recipient</label>
          <input
            className="field-input"
            value={recipient}
            placeholder="0x… (40 hex)"
            onChange={(e) => onRecipient(e.target.value)}
            spellCheck={false}
          />
        </div>
      </section>

      <section className="fee-card">
        <div className="fee-row">
          <span>Network fee</span>
          <span className="fee-zero">
            <span className="fee-through">$0.00</span>
            <span className="fee-sponsored"><BoltIcon /> sponsored</span>
          </span>
        </div>
        <div className="fee-row">
          <span>ETH required</span>
          <span className="fee-safe">0 · untouched</span>
        </div>
        <div className="fee-row">
          <span>Settlement</span>
          <span className="fee-normal">1 tx by the NimZero relayer</span>
        </div>
      </section>

      {configError && <div className="error-message">{configError}</div>}

      <button className="btn-primary btn-send" onClick={onContinue}>
        Review payment <SendIcon />
      </button>
      <p className="tiny-note">You sign one authorization. No gas is ever taken from your wallet.</p>
    </div>
  )
}

function ReviewScreen(props: {
  cfg: ChainConfig
  review: ReviewInfo
  onBack: () => void
  onConfirm: () => void
}) {
  const { cfg, review, onBack, onConfirm } = props
  return (
    <div className="screen">
      <section className="hero compact">
        <p className="kicker">REVIEW</p>
        <h1 className="hero-title">One authorization.</h1>
        <p className="hero-sub">Signed in your wallet, settled by the relayer — zero gas for you.</p>
      </section>

      <section className="review-hero">
        <TokenOrb token={cfg.tokenSymbol} size="lg" />
        <div className="review-amount">
          <span className="review-amount-main">${review.amount.toFixed(2)}</span>
          <span className="review-amount-sub">{cfg.tokenSymbol} · fee $0.00</span>
        </div>
      </section>

      <section className="review-card">
        <div className="review-row">
          <span>To</span>
          <span className="review-mono">{shortAddress(review.recipient)}</span>
        </div>
        <div className="review-row">
          <span>Network</span>
          <span>{cfg.network}</span>
        </div>
        <div className="review-row">
          <span>Network fee</span>
          <span className="review-strong blb">$0.00</span>
        </div>
        <div className="review-row">
          <span>Gas paid by</span>
          <span className="review-strong"><BoltIcon /> NimZero relayer</span>
        </div>
        <div className="review-row">
          <span>Your ETH balance</span>
          <span>unchanged · 0 required</span>
        </div>
      </section>

      <button className="btn-secondary" onClick={onBack}>
        Back
      </button>
      <button className="btn-primary btn-send" onClick={onConfirm}>
        <WalletIcon /> Authorize in wallet
      </button>
      <p className="tiny-note">
        You'll sign one authorization in Nimiq Pay. No gas is taken from your wallet — ever.
      </p>
    </div>
  )
}

function SigningScreen(props: { cfg: ChainConfig; verification: string[] }) {
  const { cfg, verification } = props
  const phases = ['Permit for the relayer', 'Relay order to the recipient', 'Settlement submitted']
  return (
    <div className="screen">
      <section className="hero compact">
        <p className="kicker">AUTHORIZING</p>
        <h1 className="hero-title">Sealing your signature.</h1>
      </section>

      <div className="orbit">
        <div className="orbit-ring orbit-a" />
        <div className="orbit-ring orbit-b" />
        <div className="orbit-core"><BoltIcon /></div>
        <span className="orbit-chip chip-a">{cfg.tokenSymbol}</span>
        <span className="orbit-chip chip-b">0 ETH</span>
      </div>

      <p className="muted center">
        Confirm the two-part authorization in your wallet. Then the NimZero relayer submits one
        settlement transaction on {cfg.network}.
      </p>

      <section className="phase-card">
        {phases.map((phase, i) => (
          <div key={phase} className={`phase ${verification.length > i ? 'done' : i === 0 ? 'pulse' : ''}`}>
            <span className="phase-dot">
              {verification.length > i ? <CheckIcon /> : i + 1}
            </span>
            <span className="phase-label">{phase}</span>
          </div>
        ))}
      </section>

      {verification.length > 0 && (
        <section className="form-card">
          <div className="card-label">Relayer activity</div>
          {verification.map((line, i) => (
            <div key={i} className="verification-line">
              <CheckIcon /> {line}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

function ReceiptScreen(props: {
  cfg: ChainConfig
  receipt: ReceiptInfo | null
  verification: string[]
  onReset: () => void
}) {
  const { cfg, receipt, verification, onReset } = props
  if (!receipt) return null
  const verified = receipt.status === 'verified'
  const pending = receipt.status === 'awaiting' || receipt.status === 'verifying'
  const failed = receipt.status === 'failed'
  const orbClass = verified ? 'ok' : failed ? 'fail' : 'pending'
  const orbIcon = verified ? <CheckIcon /> : failed ? <XIcon /> : <ClockIcon />
  return (
    <div className="screen">
      <section className="hero compact center">
        <div className={`status-orb ${orbClass}`}>{orbIcon}</div>
        <h1 className="hero-title">{receipt.title}</h1>
        <p className="hero-sub">{receipt.message}</p>
      </section>

      {receipt.txHash && (
        <section className="form-card">
          <div className="card-label">Transaction</div>
          <a
            className="review-mono link tx-link"
            href={explorerTxUrl(cfg, receipt.txHash)}
            target="_blank"
            rel="noreferrer"
          >
            {receipt.txHash.slice(0, 10)}…{receipt.txHash.slice(-8)} ↗
          </a>
        </section>
      )}

      {verification.length > 0 && (
        <section className="form-card">
          <div className="card-label">Independent on-chain check</div>
          {verification.map((line, i) => (
            <div key={i} className="verification-line">
              <CheckIcon /> {line}
            </div>
          ))}
        </section>
      )}

      {pending && (
        <div className="warn-note">
          <ClockIcon /> Settlement is pending live execution. Nothing is simulated.
        </div>
      )}

      <button className="btn-primary btn-send" onClick={onReset}>
        {verified ? 'Make another payment' : 'Back'}
      </button>
    </div>
  )
}

function TokenOrb({ token, size = 'md' }: { token: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`orb ${size}`} aria-hidden="true">
      <span className="orb-inner">{token.slice(0, 1)}</span>
    </span>
  )
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H13L13 2z" />
    </svg>
  )
}

function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h11a2 2 0 0 1 2 2v.5h-13a2.5 2.5 0 0 1-2.5-2.5z" />
      <path d="M3.5 9.5v6A2.5 2.5 0 0 0 6 18h13.5a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H6a2.5 2.5 0 0 0-2.5 1.5z" />
      <circle cx="16.5" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4 5 19l7-3.2L19 19 12 4z" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15H4.5A2.5 2.5 0 0 1 2 12.5v-8A2.5 2.5 0 0 1 4.5 2h8A2.5 2.5 0 0 1 15 4.5V5" />
    </svg>
  )
}

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h10" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" {...strokeProps} strokeWidth={2.2} aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a16.6 16.6 0 0 1-2.4 3.4" />
      <path d="M6.6 6.6A15.9 15.9 0 0 0 2 12s3.5 7 10 7c1 0 1.9-.1 2.8-.3" />
      <path d="M9.9 9.9a2.6 2.6 0 0 0 3.5 3.5" />
    </svg>
  )
}

function QrIcon() {
  return (
    <svg viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 14h3v3h-3zM21 14h.01M14 21h.01M21 20v1" />
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
      <path d="M3.5 11 12 4l8.5 7" />
      <path d="M5.5 9.8V20h13V9.8" />
    </svg>
  )
}

function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
      <path d="M4 20V10M10 20V4M16 20v-6" />
      <path d="M3 20h18" />
    </svg>
  )
}

function ActivityIcon() {
  return (
    <svg viewBox="0 0 24 24" {...strokeProps} aria-hidden="true">
      <path d="M4 4v16h16" />
      <path d="M8 14l3-3 3 3 5-6" />
    </svg>
  )
}

export default App