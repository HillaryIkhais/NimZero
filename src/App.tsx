import { useState, useCallback, useEffect } from 'react'
import { Wallet } from 'ethers'
import QRCode from 'qrcode'
import {
  POLYGON_CHAIN_ID_DECIMAL,
  POLYGON_CHAIN_ID_HEX,
  USDT0_POLYGON,
  chainLabel,
  canSignOn,
  matchChain,
  normalizeChainIdHex,
  parseChainId,
  errorCode,
  rawError,
  describeError,
} from './core/chain'
import {
  POLYGON_CHAIN_ID,
  USDT0_POLYGON,
  usdt0PermitDomain,
  USDT0_DOMAIN_SEPARATOR,
  recoverPermitSigner,
  recoverRelayOrderSigner,
  relayDomain,
  computeUsdt0DomainSeparator,
  defaultDeadline,
  toTokenWei,
} from './core/relayer'
import type { PermitMessage, RelayOrderMessage } from './core/types'
import { formatReceipt, shortHash, shortAddress, statusLabel, polygonScanUrl } from './core/receipt'
import { generateReceipt, verifyPayment } from './verification'
import './App.css'

// ── Helpers ────────────────────────────────────────────────────────

function formatUSDT(wei: bigint): string {
  return `$${(Number(wei) / 1_000_000).toFixed(2)} USDT`
}

function formatPOL(wei: bigint): string {
  return wei === 0n ? '0 POL' : `${Number(wei) / 1_000_000_000_000_000_000} POL`
}

function USDTBalance(address: string, provider: Wallet): string {
  try {
    const bal = BigInt(
      (provider as any).provider?.call?.({
        to: USDT0_POLYGON,
        data: '0x70a08231000000000000000000000000' + address.slice(2),
      }) as unknown as string
    )
    return formatUSDT(BigInt(bal))
  } catch {
    return '$0.00 USDT'
  }
}

function POLBalance(address: string, provider: Wallet): string {
  try {
    const bal = provider.getBalance(address)
    return POLBalance(BigInt(bal))
  } catch {
    return '0 POL'
  }
}

// ── Screens ────────────────────────────────────────────────────────

type Screen = 'home' | 'review' | 'signing' | 'receipt'

function App() {
  const [lanUrl, setLanUrl] = useState('http://localhost:5173')
  useEffect(() => {
    let active = true
    fetch('/__lan_url')
      .then(res => res.json())
      .then((data: { url: string }) => {
        if (active && data.url) setLanUrl(data.url)
      })
      .catch(() => {})
    return () => { active = false }
  }, [])

  const deepLink = `nimiqpay://miniapp?url=${encodeURIComponent(lanUrl)}`

  // ── Wallet / chain state ──────────────────────────────────────
  const [wallet, setWallet] = useState<{
    connected: boolean
    address: string | null
    chainId: string | null
    polBalance: string
    usdtBalance: string
  }>({
    connected: false,
    address: '',
    chainId: '',
    polBalance: '0 POL',
    usdtBalance: '$0.00 USDT',
  })

  const [screen, setScreen] = useState<'home' | 'review' | 'signing' | 'receipt'>('home')

  const [chainState, setChainState] = useState<'idle' | 'switching' | 'resolved'>('idle')
  const [resolved, setResolved] = useState<{ status: string; activeChainHex: string } | null>(null)

  const [review, setReview] = useState<{
    amount: number
    recipient: string
  } | null>(null)

  const [signing, setSigning] = useState<{
    status: 'idle' | 'submitting' | 'success' | 'fail'
    txHash?: string
  }>({ status: 'idle' })

  // ── Connect wallet ─────────────────────────────────────────────
  const connectWallet = useCallback(async () => {
    if (!window.ethereum) {
      setScreen('home')
      alert('No EVM provider detected. Open this in Nimiq Pay.')
      return
    }

    try {
      const accounts = await window.ethereum?.request?.({
        method: 'eth_requestAccounts',
      }) as string[]

      const chainIdHex = await window.ethereum?.request?.({
        method: 'eth_chainId',
      }) as string

      if (!accounts?.length) throw new Error('No accounts returned')

      const activeHex = chainIdHex ?? '0x1'
      const chain = matchChain(activeHex)

      setChainState({ kind: 'resolved', status: chain })

      const polBalance = POLBalance(accounts[0], window.ethereum as Wallet)
      const usdtBalance = USDTBalance(accounts[0], window.ethereum as Wallet)

      setWallet({
        connected: true,
        address: accounts[0],
        chainId: chain.activeChainHex,
        polBalance,
        usdtBalance,
      })

      // ── auto‑switch to Polygon if needed ───────────────────────
      if (chain.status !== 'MATCHED') {
        try {
          await window.ethereum?.request?.({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: POLYGON_CHAIN_ID_HEX }],
          })
        } catch (e) {
          try {
            await window.ethereum?.request?.({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: POLYGON_CHAIN_ID_HEX,
                  chainName: 'Polygon',
                  rpcUrls: ['https://polygon-bor-rpc.publicnode.com'],
                  nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
                  blockExplorerUrls: ['https://polygonscan.com'],
                },
              ],
            })
          } catch (e2) {
            console.error('Chain switch failed:', describeError(e2))
          }
        }
      }

      // ── If still not matched after switch, report ──────────────
      const newStatus = window.ethereum?.request?.({
        method: 'eth_chainId',
      }) as string
      const finalStatus = parseChainId(newStatus)
      if (finalStatus !== POLYGON_CHAIN_ID_DECIMAL) {
        setChainState({
          kind: 'resolved',
          status: {
            status: 'MISMATCH',
            activeChainHex: normalizeChainIdHex(newStatus),
            error: `Active chain is ${normalizeChainIdHex(newStatus)}; expected 0x89`,
          },
        })
      }
    } catch (err) {
      console.error('Connection failed:', describeError(err))
      alert(`Connection failed: ${describeError(err)}`)
    }
  }, [])

  // ── Chain resolution ──────────────────────────────────────────
  const resolved = chainState.kind === 'resolved' ? chainState.status : null
  const canSign = resolved !== null && canSignOn(resolved)
  const switching = chainState.kind === 'switching'
  const activeHex = resolved ? resolved.activeChainHex : wallet.chainId || ''

  // ── Demo / live config ────────────────────────────────────────
  const [demoMode, setDemoMode] = useState(false)
  useEffect(() => {
    ;(async () => {
      try {
        const cfg = await (await fetch('/api/config')).json()
        setDemoMode(!cfg.live)
      } catch {
        setDemoMode(true) // no relayer → demo mode
      }
    })()
  }, [])

  // ── Home screen ───────────────────────────────────────────────
  const handleHomeContinue = () => {
    const { usdtBalance, polBalance } = wallet
    const usdtOk = /^\$[\d]+\.\d{2} USDT$/.test(usdtBalance)
    const polOk = polBalance === '0 POL'
    if (!wallet.connected) return alert('Connect wallet first')
    if (!usdtOk) return alert('USDT balance not read — please try again')
    if (!polOk) return alert('POL must be 0 — gasless demo only')
    setScreen('review')
  }

  // ── Review screen ─────────────────────────────────────────────
  const handleReview = () => {
    if (!review) return
    setScreen('signing')
    ;(async () => {
      // 1. POST /api/payments → SUBMITTED (or AWAITING_SETTLEMENT / FAILED)
      const resp = await (await fetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: {
            id: 'intent_demo',
            sender: wallet.address,
            recipient: review.recipient,
            amount: review.amount,
            asset: 'USDT',
            chain: 'polygon',
            nonce: 0,
            createdAt: Date.now(),
            expiresAt: Date.now() + 600_000,
            hash: '0x' + Math.random().toString(36).slice(2, 64),
          },
          authorization: {
            intentId: 'intent_demo',
            signedBy: wallet.address,
            signedAt: Date.now(),
            relay: RELAY,
            signature: '', // will be filled by the two native confirmations below
            permitSignature: '',
            permit: {
              owner: wallet.address,
              spender: RELAY,
              value: toTokenWei(review.amount),
              nonce: 0n,
              deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
            },
            order: {
              from: wallet.address,
              to: review.recipient,
              amount: toTokenWei(review.amount),
              token: USDT0_POLYGON,
              chainId: POLYGON_CHAIN_ID,
              deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
              nonce: 0n,
            },
          },
        } as any)
      }).then((r) => r.json())

      if (resp.status === 'AWAITING_SETTLEMENT') {
        // Demo mode: signing complete, but settlement deferred
        setScreen('receipt')
        return
      }

      if (resp.status === 'SUBMITTED') {
        // Poll for verification
        const txHash = resp.txHash!
        let attempts = 0
        const interval = setInterval(async () => {
          attempts++
          const p = await (await fetch(`/api/payments/${txHash}`)).json()
          if (p.status === 'VERIFIED') {
            clearInterval(interval)
            // Show receipt
            const receipt = generateReceipt({
              intent: { id: 'intent_demo', sender: wallet.address, recipient: review.recipient, amount: review.amount, asset: 'USDT', chain: 'polygon', nonce: 0, createdAt: Date.now(), expiresAt: Date.now() + 600_000, hash: '0xdeadbeef' },
              authorization: {
                intentId: 'intent_demo',
                signedBy: wallet.address,
                signedAt: Date.now(),
                relay: RELAY,
                signature: '', // will be filled by the two native confirmations
                permitSignature: '',
                permit: {
                  owner: wallet.address,
                  spender: RELAY,
                  value: toTokenWei(review.amount),
                  nonce: 0n,
                  deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
                },
                order: {
                  from: wallet.address,
                  to: review.recipient,
                  amount: toTokenWei(review.amount),
                  token: USDT0_POLYGON,
                  chainId: POLYGON_CHAIN_ID,
                  deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
                  nonce: 0n,
                },
              },
              status: 'VERIFIED',
            })
            setScreen('receipt')
            // Don't store globally; we just render below
            // The receipt page below will re-read it
          } else if (p.status === 'FAILED') {
            clearInterval(interval)
            setScreen('receipt') // show failure
          }
        }, 3_000)

        return
      }

      setScreen('home')
    })()
  }, [review])

  // ── Signing: two native confirmations (Permit + RelayOrder) ─────
  const [typedTest, setTypedTest] = useState<{
    kind: 'permit' | 'relayOrder'
    status: 'idle' | 'signing' | 'success' | 'fail'
    message: PermitMessage | RelayOrderMessage
    domain: object
    types: object
    signature: string
    recoveredSigner: string
    expectedSigner: string
    match: boolean
    error: string
    errorRaw: string
  }>({
    kind: 'permit',
    status: 'idle',
    message: { owner: '', spender: '', value: 0n, nonce: 0n, deadline: 0n },
    domain: {},
    types: {},
    signature: '',
    recoveredSigner: '',
    expectedSigner: '',
    match: false,
    error: '',
    errorRaw: '',
  })

  const signTestPayment = useCallback(async () => {
    if (!window.ethereum || !wallet.connected) return

    const now = Math.floor(Date.now() / 1000)
    const deadline = now + 300

    const permitValue: PermitMessage = {
      owner: wallet.address,
      spender: RELAY,
      value: toTokenWei(review.amount),
      nonce: 0n,
      deadline: BigInt(deadline),
    }
    const orderValue: RelayOrderMessage = {
      from: wallet.address,
      to: review.recipient,
      amount: toTokenWei(review.amount),
      token: USDT0_POLYGON,
      chainId: POLYGON_CHAIN_ID,
      deadline: BigInt(deadline),
      nonce: 0n,
    }

    const permitDomain = usdt0PermitDomain()
    const orderDomain = relayDomain(RELAY)

    ;(async () => {
      setTypedTest(prev => ({ ...prev, status: 'signing' }))

      const signRequest = async <M extends PermitMessage | RelayOrderMessage>(
        test: typeof typedTest,
        value: M,
        domain: object,
        recover: (val: M, sig: string) => string,
      ): Promise<typeof typedTest> => {
        try {
          const typedData = JSON.stringify({ domain, types: test.types, primaryType: Object.keys(test.types)[0], message: value })
          const sig = await window.ethereum?.request?.({ method: 'eth_signTypedData_v4', params: [wallet.address, typedData] }) as string
          if (!sig) return { ...test, status: 'error', error: 'No signature returned' }
          let recovered = ''
          try {
            recovered = recover(value, sig)
          } catch {
            return { ...test, status: 'error', signature: sig, error: `recover failed`, domain, message: value }
          }
          const match = recovered.toLowerCase() === wallet.address.toLowerCase()
          return { ...test, status: match ? 'success' : 'fail', signature: sig, recoveredSigner: recovered, expectedSigner: wallet.address, match, domain, message: value }
        } catch (err) {
          return { ...test, status: 'error', error: `eth_signTypedData_v4 failed: ${rawError(err)}`, errorRaw: rawError(err) }
        }
      }

      // Permit first, then RelayOrder — but we fire both in parallel as the original app does,
      // then handle the UX flow accordingly.
      const [pResult, oResult] = await Promise.all([
        signRequest(typedTest as typeof typedTest, permitValue, permitDomain, (v, s) => recoverPermitSigner(v, s)),
        signRequest(typedTest as typeof typedTest, orderValue, orderDomain, (v, s) => recoverRelayOrderSigner(v, s, RELAY)),
      ])

      setTypedTest(pResult)
      setTypedTest(oResult)
    })()
  }, [review])

  // ── Receipt screen ────────────────────────────────────────────
  const receipt = computedReceipt // defined below

  // ── Footer ────────────────────────────────────────────────────
  const footer = () => (
    <footer className="footer">
      <span className="footer-label">ZERO</span>
    </footer>
  )

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="header">
        <div className="logo">ZERO</div>
        {demoMode && (
          <div className="tagline">Settlement awaits live execution</div>
        )}
      </header>

      <main className="main">
        {screen === 'home' && <HomeScreen continue={handleHomeContinue} wallet={wallet} />}
        {screen === 'review' && <ReviewScreen amount={review!.amount} recipient={review!.recipient} onContinue={handleReview} />}
        {screen === 'signing' && <SigningScreen />}
        {screen === 'receipt' && <ReceiptScreen />}
      </main>
    </div>
  )
}

// ── HomeScreen ────────────────────────────────────────────────────
function HomeScreen({ continue: continueFn }: { continue: () => void }) {
  const { usdtBalance, polBalance, address } = wallet
  return (
    <div className="card">
      <div className="card-header">ZERO</div>
      <div className="card-value">
        <div>Pay USDT without POL</div>
        <div>{wallet.connected && `${wallet.address?.slice(0, 6)}…${wallet.address?.slice(-4)}`}</div>
      </div>
    </div>

    <div className="card">
      <div className="card-header">USDT balance</div>
      <div className="card-value">{wallet.usdtBalance}</div>
    </div>

    <div className="card">
      <div className="card-header">POL balance</div>
      <div className="card-value">{wallet.polBalance}</div>
    </div>

    <div className="card">
      <div className="card-header">Recipient</div>
      <div className="card-value">
        <input
          type="text"
          placeholder="0x..."
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9a-fA-F]/g, '')
            if (/^0x[a-fA-F0-9]{40}$/.test(v)) setReview({ amount: Number(document.getElementById('amount')?.value ?? '1'), recipient: v })
          }}
        />
      </div>
      <input type="number" id="amount" value={1} min={1} step={0.01} />
    </div>

    {wallet.connected && (
      <button
        className="btn-primary"
        onClick={handleHomeContinue}
        disabled={!(/^\$[\d]+\.\d{2} USDT$/.test(wallet.usdtBalance) && wallet.polBalance === '0 POL')}
      >
        Continue
      </button>
    </div>
  )
}

// ── ReviewScreen ────────────────────────────────────────────────
function ReviewScreen({ amount, recipient, onContinue }: { amount: number; recipient: string; onContinue: () => void }) {
  return (
    <div className="card">
      <div className="card-header">Review payment</div>
      <div className="card-value">
        <div>Send ${amount} USDT</div>
        <div>To ${recipient.slice(0, 6)}…${recipient.slice(-4)}</div>
        <div>Network Polygon</div>
        <div>Network fee $0.00</div>
        <div>Your POL 0 POL</div>
        <div>Sponsored by ZERO</div>
      </div>

      <button
        className="btn-primary"
        onClick={onContinue}
        disabled={signing.status !== 'idle'}
      >
        {signing.status === 'submitting' ? 'Submitting…' : 'Authorize payment'}
      </button>
    </div>
  )
}

// ── SigningScreen ───────────────────────────────────────────────
function SigningScreen() {
  return (
    <div className="card">
      <div className="card-header">Submitting payment…</div>
      <p>Your authorization is being submitted to the relayer and verified on Polygon.</p>
    </div>
  )
}

// ── ReceiptScreen ───────────────────────────────────────────────
function ReceiptScreen() {
  // Read the receipt from localStorage (set by the page, injected via data-* )
  const stored = localStorage.getItem('ZERO_receipt')
  const receipt = stored ? JSON.parse(stored) : null

  if (!receipt) return null

  const { status, verified, txHash, intent, verification } = receipt
  const isVerified = status === 'VERIFIED' && verified

  return (
    <div className="card">
      <div className="card-header">
        {isVerified ? 'Payment complete' : 'Payment failed'}
      </div>
      {isVerified && (
        <div>
          <div>{formatUSDT(intent.amount)} sent</div>
          <div>
            From <shortAddress(wallet.address ?? '')</shortAddress>
            To <shortAddress(intent.recipient)</shortAddress>
          </div>
          <div>Gas paid by ZERO</div>
          <div>Transaction {shortHash(txHash ?? '')}</div>
          <a href={polygonScanUrl(txHash ?? '')} target="_blank" rel="noopener">
            View on PolygonScan
          </a>
        </div>
        )}
        {!isVerified && (
          <div>
            <div>{statusLabel(status ?? 'FAILED')}</div>
            {verification?.details?.[0] && <div>{verification.details![0]}</div>}
          </div>
        )}
        {status !== 'VERIFIED' && status !== 'FAILED' && (
          <div>{statusLabel(status ?? 'SUBMITTED')}</div>
        )}
        <button onClick={() => localStorage.removeItem('ZERO_receipt')}>Close</button>
      </div>
    </div>
  )
}

// ── Startup: LAN QR ─────────────────────────────────────────────
useEffect(() => {
  let active = true
  fetch('/__lan_url')
    .then(res => res.json())
    .then((data: { url: string }) => {
      if (active && data.url) setLanUrl(data.url)
    })
    .catch(() => {})
  return () => { active = false }
}, [])

// ── Initial chain check ─────────────────────────────────────────
useEffect(() => {
  ;(async () => {
    if (!window.ethereum) return
    const activeHex = await window.ethereum?.request?.({ method: 'eth_chainId' }) as string | number
    if (parseChainId(activeHex) !== POLYGON_CHAIN_ID_DECIMAL) {
      const normalized = normalizeChainIdHex(activeHex)
      setChainState({ kind: 'resolved', status: { status: 'MISMATCH', activeChainHex: normalized, error: `Active chain is ${normalized} ≠ 0x89` } })
    } else {
      setChainState({ kind: 'resolved', status: { status: 'SWITCHED', activeChainHex: normalizedChainIdHex(activeHex) } })
    }
  })()
}, [])

// ── On wallet change (rare) ─────────────────────────────────────
useEffect(() => {
  ;(async () => {
    if (!window.ethereum) return
    const accounts = await window.ethereum?.request?.({ method: 'eth_requestAccounts' }) as string[]
    if (accounts?.length) {
      setWallet((prev) => ({
        ...prev,
        connected: true,
        address: accounts[0],
        polBalance: POLBalance(accounts[0], window.ethereum as Wallet),
        usdtBalance: USDTBalance(accounts[0], window.ethereum as Wallet),
      }))
    }
  })()
}, [])

// ── Receipt: store after render so the ReceiptScreen can read it ────
useEffect(() => {
  if (screen === 'receipt' && receipt) {
    localStorage.setItem('ZERO_receipt', JSON.stringify(receipt))
  }
}, [screen, receipt])