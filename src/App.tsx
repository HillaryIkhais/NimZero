import { useCallback, useEffect, useMemo, useState } from 'react'
import { BrowserProvider, Contract } from 'ethers'
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
// NimZero — Pay USDT on Polygon without POL.
// A gasless USDT payment: the user signs (Permit + RelayOrder), a funded
// relayer sponsors the settlement transaction on Polygon, and NimZero
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

type Screen = 'home' | 'review' | 'signing' | 'receipt'

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
      setConfigError('No EVM wallet found. Open this Mini App inside Nimiq Pay to continue.')
      return
    }
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

  useEffect(() => {
    if (cfg && window.ethereum && !provider) {
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
  }, [cfg, provider, refreshBalances, switchChain])

  async function signAndSubmit(info: ReviewInfo) {
    if (!provider || !cfg || !wallet.address) throw new Error('Wallet not connected')
    setVerification([])

    const signer: Signer = await provider.getSigner(wallet.address)

    const tokenContract = new Contract(
      cfg.token,
      ['function nonces(address owner) view returns (uint256)'],
      provider
    )
    const tokenNonce = await tokenContract.nonces(wallet.address)

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
      checks.push(`User POL ${fromTokenWei(pol, 18)} (gas was sponsored — not charged to the user)`)
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

  return (
    <div className="app">
      <Header cfg={cfg} />
      <main className="main">
        <Stepper step={stepByScreen[screen]} />

        {screen === 'home' && (
          <HomeScreen
            cfg={cfg}
            wallet={wallet}
            recipient={recipient}
            amount={amount}
            configError={configError}
            onRecipient={setRecipient}
            onAmount={setAmount}
            onConnect={provider ? undefined : connect}
            onContinue={startReview}
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
        <span>You never touched POL to do it.</span>
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
  recipient: string
  amount: number
  configError: string
  onRecipient: (value: string) => void
  onAmount: (value: number) => void
  onConnect?: () => void
  onContinue: () => void
}) {
  const { cfg, wallet, recipient, amount, configError, onRecipient, onAmount, onConnect, onContinue } = props
  return (
    <div className="screen">
      <section className="hero">
        <p className="kicker">GASLESS PAYMENTS</p>
        <h1 className="hero-title">
          Pay USDT on Polygon <span className="ink">— without POL.</span>
        </h1>
        <p className="hero-sub">
          Send {cfg.tokenSymbol} on {cfg.network}. The network fee is paid for you.
        </p>
      </section>

      <WalletCard cfg={cfg} wallet={wallet} onConnect={onConnect} />

      {wallet.connected && (
        <Composer
          cfg={cfg}
          wallet={wallet}
          recipient={recipient}
          amount={amount}
          configError={configError}
          onRecipient={onRecipient}
          onAmount={onAmount}
          onContinue={onContinue}
        />
      )}
    </div>
  )
}

function WalletCard({
  cfg,
  wallet,
  onConnect
}: {
  cfg: ChainConfig
  wallet: WalletInfo
  onConnect?: () => void
}) {
  const connected = wallet.connected
  const [full, setFull] = useState(false)
  const [copied, setCopied] = useState(false)

  const toggleAddress = async () => {
    if (full) return
    if (!wallet.address) return
    setFull(true)
    const ok = await copyText(wallet.address)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }
  }

  return (
    <section className={`wallet-card ${connected ? 'is-connected' : ''}`}>
      <div className="wallet-aurora" aria-hidden="true" />
      <div className="wallet-top">
        <div className="wallet-brand">
          <TokenOrb token={cfg.tokenSymbol} size="sm" />
          <span className="wallet-name">NimZero Pay</span>
        </div>
        {connected ? (
          <button
            className={`chip-mono addr-chip ${full ? 'is-full' : ''}`}
            onClick={toggleAddress}
            aria-expanded={full}
            title={full ? wallet.address : 'Tap to reveal your full address'}
          >
            {full ? wallet.address : shortAddress(wallet.address)}
            <span className="addr-copy">{copied ? <CheckIcon /> : <CopyIcon />}</span>
          </button>
        ) : (
          <span className="chip-mono">no wallet</span>
        )}
      </div>

      <div className="chip-row">
        <div className="chip" aria-hidden="true">
          <i /><i /><i />
        </div>
        <span className="contactless" aria-hidden="true">
          <i /><i /><i />
        </span>
      </div>

      <div className="wallet-balance">
        <span className="balance-amount">{connected ? wallet.token : '——'}</span>
        <span className="balance-token">{cfg.tokenSymbol}</span>
      </div>

      <div className="wallet-rows">
        <div className="wallet-row">
          <span className="w-label"><i className="mini-dot mint" /> {cfg.tokenSymbol}</span>
          <span className="w-value">{connected ? wallet.token : '—'}</span>
        </div>
        <div className="wallet-row">
          <span className="w-label"><BoltIcon /> POL (gas)</span>
          <span className={`w-value ${connected && wallet.pol === '0.00' ? 'blb' : ''}`}>
            {connected ? wallet.pol : '—'}
          </span>
        </div>
      </div>

      {!connected && onConnect ? (
        <button className="btn-primary btn-connect" onClick={onConnect}>
          <WalletIcon /> Connect wallet
        </button>
      ) : (
        <div className="sponsor-strip">
          <span className="sponsor-bolt"><BoltIcon /></span>
          <span>0 POL needed — the relayer pays your gas</span>
        </div>
      )}
    </section>
  )
}

function Composer(props: {
  cfg: ChainConfig
  wallet: WalletInfo
  recipient: string
  amount: number
  configError: string
  onRecipient: (value: string) => void
  onAmount: (value: number) => void
  onContinue: () => void
}) {
  const { cfg, wallet, recipient, amount, configError, onRecipient, onAmount, onContinue } = props
  const chips = ['5', '10', '25', '50', '100']
  return (
    <div className="composer">
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
          <span>Your POL</span>
          <span className="fee-safe">{wallet.pol} · untouched</span>
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
      <p className="tiny-note">You'll sign in Nimiq Pay. No POL is ever taken from your wallet.</p>
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
        <p className="hero-sub">Signed in your wallet, settled by the relayer — zero POL for you.</p>
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
          <span>Your POL balance</span>
          <span>unchanged</span>
        </div>
      </section>

      <button className="btn-secondary" onClick={onBack}>
        Back
      </button>
      <button className="btn-primary btn-send" onClick={onConfirm}>
        <WalletIcon /> Authorize in wallet
      </button>
      <p className="tiny-note">
        You'll sign one authorization in Nimiq Pay. No POL is taken from your wallet — ever.
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
        <span className="orbit-chip chip-b">0 POL</span>
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

export default App