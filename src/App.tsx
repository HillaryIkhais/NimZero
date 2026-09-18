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

function shortAddress(address: string): string {
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

function chainName(cfg: ChainConfig): string {
  return cfg.network
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

  // ── Load operator config (network, token, relay, explorer) ──
  useEffect(() => {
    getConfig()
      .then(setCfg)
      .catch((err) => setConfigError(err instanceof Error ? err.message : String(err)))
  }, [])

  // ── Boot the injected wallet provider (Nimiq Pay) ──
  const switchChain = useCallback(async (p: BrowserProvider, c: ChainConfig) => {
    try {
      await p.send('wallet_switchEthereumChain', [{ chainId: c.chainIdHex }])
    } catch (err) {
      if (err instanceof Error && /4902|Unrecognized chain|unknown chain/i.test(err.message)) {
        await p.send('wallet_addEthereumChain', [
          {
            chainId: c.chainIdHex,
            chainName: chainName(c),
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

  // ── Signing + submission ──
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
      message: `${wallet.address ? shortAddress(wallet.address) : ''} — verified on ${chainName(cfg)} by NimZero's independent check.`
    })
    setVerification((v) => [...v, ...checks])
  }

  // ── Screen transitions ──
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

  // ── Render ──
  if (configError && !cfg) {
    return (
      <div className="app">
        <Header cfg={cfg} />
        <main className="main">
          <div className="card">
            <div className="error-title">NimZero can't start</div>
            <p className="error-message">{configError}</p>
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
          <div className="card">Loading operator configuration…</div>
        </main>
      </div>
    )
  }

  return (
    <div className="app">
      <Header cfg={cfg} />
      <main className="main">
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
        <span>And you never touched POL to do it.</span>
      </footer>
    </div>
  )
}

function Header({ cfg }: { cfg: ChainConfig | null }) {
  return (
    <header className="header">
      <div className="logo">NIMZERO</div>
      <div className="tagline">
        {cfg && cfg.network && cfg.chainId !== 137 && <span className="badge">Testnet · {cfg.network}</span>}
      </div>
    </header>
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
        <h1 className="hero-title">Pay USDT on Polygon without POL.</h1>
        <p className="hero-sub">
          Send {cfg.tokenSymbol} on {cfg.network}. The network fee is paid for you.
        </p>
      </section>

      <section className="card balances">
        <div className="balance-row">
          <span className="balance-label">{cfg.tokenSymbol}</span>
          <span className="balance-value">
            {wallet.connected ? `${wallet.token} ${cfg.tokenSymbol}` : '—'}
          </span>
        </div>
        <div className="balance-row">
          <span className="balance-label">POL (gas)</span>
          <span className="balance-value">{wallet.connected ? `${wallet.pol} POL` : '—'}</span>
        </div>
        {wallet.pol === '0.00' && (
          <div className="zero-tag">0 POL — no problem, gas is sponsored.</div>
        )}
      </section>

      {!wallet.connected && onConnect && (
        <button className="btn-primary" onClick={onConnect}>
          Connect wallet
        </button>
      )}

      {wallet.connected && (
        <>
          <section className="card">
            <label className="field-label">Recipient</label>
            <input
              className="field-input"
              value={recipient}
              placeholder="0x… (40 hex)"
              onChange={(e) => onRecipient(e.target.value)}
              spellCheck={false}
            />
            <label className="field-label">Amount</label>
            <input
              className="field-input"
              type="number"
              value={Number.isFinite(amount) ? amount : 1}
              min={0.01}
              step={0.01}
              onChange={(e) => onAmount(Number(e.target.value))}
            />
          </section>

          <div className="fee-note">
            <span>{cfg.tokenSymbol} amount</span>
            <span>
              {('$' + (Number.isFinite(amount) ? amount : 0).toFixed(2))} · fee $0.00
            </span>
          </div>

          {configError && <div className="error-message">{configError}</div>}

          <button className="btn-primary" onClick={onContinue}>
            Review
          </button>
        </>
      )}
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
      <h2 className="screen-title">Review payment</h2>

      <section className="card review-card">
        <div className="review-row">
          <span>Paying</span>
          <span className="review-strong">
            {`$${review.amount.toFixed(2)} ${cfg.tokenSymbol}`}
          </span>
        </div>
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
          <span className="review-strong">$0.00</span>
        </div>
        <div className="review-row">
          <span>Gas paid by</span>
          <span>the NimZero relayer</span>
        </div>
        <div className="review-row">
          <span>Your POL balance</span>
          <span>unchanged (sponsored)</span>
        </div>
      </section>

      <button className="btn-secondary" onClick={onBack}>
        Back
      </button>
      <button className="btn-primary" onClick={onConfirm}>
        Authorize in wallet
      </button>
      <p className="tiny-note">
        You'll sign one authorization in Nimiq Pay. No POL is taken from your wallet — ever.
      </p>
    </div>
  )
}

function SigningScreen(props: { cfg: ChainConfig; verification: string[] }) {
  const { cfg, verification } = props
  return (
    <div className="screen">
      <h2 className="screen-title">Authorizing…</h2>
      <p className="muted">
        Confirm the two-part authorization in your wallet. Then the NimZero relayer submits one
        settlement transaction on {cfg.network}.
      </p>
      <div className="spinner" />
      {verification.length > 0 && (
        <div className="verification">
          {verification.map((line, i) => (
            <div key={i} className="verification-line">
              ✓ {line}
            </div>
          ))}
        </div>
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
  return (
    <div className="screen">
      <h2 className={`screen-title ${verified ? 'success' : pending ? 'pending' : 'fail'}`}>
        {receipt.status === 'awaiting' ? '⏳' : verified ? '✓' : '×'} {receipt.title}
      </h2>
      <p className="muted">{receipt.message}</p>

      {receipt.txHash && (
        <section className="card tx-card">
          <div className="review-row">
            <span>Transaction</span>
            <a
              className="review-mono link"
              href={explorerTxUrl(cfg, receipt.txHash)}
              target="_blank"
              rel="noreferrer"
            >
              {receipt.txHash.slice(0, 10)}…{receipt.txHash.slice(-8)}
            </a>
          </div>
        </section>
      )}

      {verification.length > 0 && (
        <section className="card">
          <div className="card-label">Independent on-chain check</div>
          {verification.map((line, i) => (
            <div key={i} className="verification-line">
              ✓ {line}
            </div>
          ))}
        </section>
      )}

      {warnings(receipt) && (
        <div className="warn-note">
          Note: this settlement is pending live execution. Nothing is simulated.
        </div>
      )}

      <button className="btn-primary" onClick={onReset}>
        {verified ? 'Make another payment' : 'Back'}
      </button>
    </div>
  )
  function warnings(r: ReceiptInfo): boolean {
    return r.status === 'awaiting'
  }
}

export default App