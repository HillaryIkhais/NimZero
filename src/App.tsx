import { useState, useCallback, useMemo, useEffect } from 'react'
import QRCode from 'qrcode'
import {
  POLYGON_CHAIN_ID_DECIMAL,
  POLYGON_CHAIN_ID_HEX,
  USDT0_POLYGON,
  chainLabel,
  canSignOn,
  matchChain,
  ensurePolygon,
  normalizeChainIdHex,
  parseChainId,
  describeError,
  rawError,
  type ChainStatus
} from './core/chain'
import {
  POLYGON_CHAIN_ID,
  usdt0PermitDomain,
  USDT0_PERMIT_TYPES,
  RELAY_ORDER_TYPES,
  recoverPermitSigner,
  recoverRelayOrderSigner,
  relayDomain
} from './core/relayer'
import type { PermitMessage, RelayOrderMessage } from './core/types'
import './App.css'

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
    }
  }
}

const ZERO_RELAY = '0x625C12eE38AAF831D3b4d644D7DaA962e2a26E0a'
const ZERO_RELAY_COMMENT = 'fork-tested ZeroPayRelay deployment (mainnet: undeployed)'

function QrSvg({ data }: { data: string }) {
  const qr = useMemo(() => {
    const code = QRCode.create(data, { errorCorrectionLevel: 'M' })
    const size = code.modules.size
    const cells: string[] = []
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (code.modules.get(row, col)) cells.push(`${col},${row}`)
      }
    }
    return { size, cells }
  }, [data])

  const scale = 5
  return (
    <svg
      width={qr.size * scale}
      height={qr.size * scale}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      className="qr"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      {qr.cells.map(cell => {
        const [x, y] = cell.split(',').map(Number)
        return <rect key={cell} x={x} y={y} width={1} height={1} fill="#000000" />
      })}
    </svg>
  )
}

interface WalletState {
  connected: boolean
  address: string
  chainId: string
  polBalance: string
  usdtBalance: string
}

type ChainState =
  | { kind: 'idle' }
  | { kind: 'switching' }
  | { kind: 'resolved'; status: ChainStatus }

interface SignatureTest {
  kind: 'permit' | 'relayOrder'
  status: 'idle' | 'signing' | 'success' | 'fail' | 'error'
  message: PermitMessage | RelayOrderMessage
  domain: object
  types: object
  signature: string
  recoveredSigner: string
  expectedSigner: string
  match: boolean
  error: string
  errorRaw: string
}

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

  const [wallet, setWallet] = useState<WalletState>({
    connected: false,
    address: '',
    chainId: '',
    polBalance: '0',
    usdtBalance: '0'
  })

  const [chainState, setChainState] = useState<ChainState>({ kind: 'idle' })

  const [permitTest, setPermitTest] = useState<SignatureTest>({
    kind: 'permit',
    status: 'idle',
    message: { owner: '', spender: '', value: 0n, nonce: 0n, deadline: 0n },
    domain: {},
    types: USDT0_PERMIT_TYPES,
    signature: '',
    recoveredSigner: '',
    expectedSigner: '',
    match: false,
    error: '',
    errorRaw: ''
  })

  const [orderTest, setOrderTest] = useState<SignatureTest>({
    kind: 'relayOrder',
    status: 'idle',
    message: { from: '', to: '', amount: 0n, token: USDT0_POLYGON, chainId: POLYGON_CHAIN_ID, deadline: 0n, nonce: 0n },
    domain: {},
    types: RELAY_ORDER_TYPES,
    signature: '',
    recoveredSigner: '',
    expectedSigner: '',
    match: false,
    error: '',
    errorRaw: ''
  })

  const connectWallet = useCallback(async () => {
    if (!window.ethereum) {
      alert('No EVM provider detected. Open this in Nimiq Pay.')
      return
    }

    try {
      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts'
      }) as string[]

      const chainIdHex = await window.ethereum.request({
        method: 'eth_chainId'
      }) as string

      let polBalance = '0'
      try {
        const polBalanceHex = await window.ethereum.request({
          method: 'eth_getBalance',
          params: [accounts[0], 'latest']
        }) as string
        polBalance = (BigInt(polBalanceHex) / BigInt(10 ** 18)).toString()
      } catch (err) {
        polBalance = '0'
        console.error('POL balance read failed:', err)
      }

      const chain = matchChain(chainIdHex)
      setChainState({ kind: 'resolved', status: chain })
      setWallet({
        connected: true,
        address: accounts[0],
        chainId: chain.activeChainHex,
        polBalance,
        usdtBalance: '—'
      })
    } catch (err) {
      console.error('Connection failed:', err)
      alert(`Connection failed: ${describeError(err)}`)
    }
  }, [])

  const switchToPolygon = useCallback(async () => {
    if (!window.ethereum) return
    setChainState({ kind: 'switching' })
    const status = await ensurePolygon(window.ethereum)
    setChainState({ kind: 'resolved', status })
    setWallet(prev => prev.connected ? { ...prev, chainId: status.activeChainHex } : prev)
  }, [])

  const signTestPayment = useCallback(async () => {
    if (!window.ethereum || !wallet.connected) return

    const activeHex = await window.ethereum.request({ method: 'eth_chainId' }) as string | number
    if (parseChainId(activeHex) !== POLYGON_CHAIN_ID_DECIMAL) {
      const normalized = normalizeChainIdHex(activeHex)
      setChainState({
        kind: 'resolved',
        status: {
          status: 'MISMATCH',
          activeChainHex: normalized,
          error: `re-read eth_chainId before signing: active ${normalized}, expected 0x89`
        }
      })
      setPermitTest(prev => ({
        ...prev,
        status: 'error',
        error: `BLOCKED: active chain is ${chainLabel(normalized)}, expected Polygon`,
        errorRaw: `activeChainId=${String(activeHex)} expectedChainId=0x89`
      }))
      return
    }

    const now = Math.floor(Date.now() / 1000)
    const deadline = now + 300

    const permitValue: PermitMessage = {
      owner: wallet.address,
      spender: ZERO_RELAY,
      value: 1_000_000n,
      nonce: 0n,
      deadline: BigInt(deadline)
    }
    const orderValue: RelayOrderMessage = {
      from: wallet.address,
      to: '0x0000000000000000000000000000000000000001',
      amount: 1_000_000n,
      token: USDT0_POLYGON,
      chainId: POLYGON_CHAIN_ID,
      deadline: BigInt(deadline),
      nonce: 0n
    }

    const permitDomain = usdt0PermitDomain()
    const orderDomain = relayDomain(ZERO_RELAY)

    setPermitTest(prev => ({ ...prev, status: 'signing', error: '', errorRaw: '' }))
    setOrderTest(prev => ({ ...prev, status: 'signing', error: '', errorRaw: '' }))

    const signRequest = async <M extends PermitMessage | RelayOrderMessage>(
      test: SignatureTest,
      value: M,
      domain: object,
      recover: (val: M, sig: string) => string
    ): Promise<SignatureTest> => {
      try {
        const typedData = JSON.stringify({ domain, types: test.types, primaryType: Object.keys(test.types)[0], message: value })
        const sig = await window.ethereum!.request({ method: 'eth_signTypedData_v4', params: [wallet.address, typedData] }) as string
        let recovered = ''
        try {
          recovered = recover(value, sig)
        } catch {
          return { ...test, status: 'error', signature: sig, error: `recover failed`, domain, message: value }
        }
        const match = recovered.toLowerCase() === wallet.address.toLowerCase()
        return { ...test, status: match ? 'success' : 'fail', signature: sig, recoveredSigner: recovered, expectedSigner: wallet.address, match, domain, message: value }
      } catch (err) {
        return { ...test, status: 'error', error: `eth_signTypedData_v4 failed: ${describeError(err)}`, errorRaw: rawError(err) }
      }
    }

    const [pResult, oResult] = await Promise.all([
      signRequest(permitTest, permitValue, permitDomain, (v, s) => recoverPermitSigner(v, s)),
      signRequest(orderTest, orderValue, orderDomain, (v, s) => recoverRelayOrderSigner(v, s, ZERO_RELAY))
    ])

    setPermitTest(pResult)
    setOrderTest(oResult)
  }, [wallet, permitTest, orderTest])

  const resolved = chainState.kind === 'resolved' ? chainState.status : null
  const canSign = resolved !== null && canSignOn(resolved)
  const switching = chainState.kind === 'switching'
  const activeHex = resolved ? resolved.activeChainHex : wallet.chainId || ''

  return (
    <div className="app">
      <header className="header">
        <div className="logo">ZERO</div>
        <div className="tagline">P0 SIGN TEST — REAL EIP-712</div>
      </header>

      {!window.ethereum && (
        <div className="launch-banner">
          <div className="launch-title">OPEN INSIDE NIMIQ PAY</div>
          <div className="launch-hint">
            This page must run inside Nimiq Pay for the EVM provider to exist. Phone and
            this Mac must be on the same Wi-Fi.
          </div>
          <div className="launch-url mono">{lanUrl}</div>
          <div className="launch-cols">
            <QrSvg data={deepLink} />
            <ul className="launch-steps">
              <li>Scan the QR with your phone camera</li>
              <li>Tap to open in Nimiq Pay</li>
              <li>Or paste the URL into <b>Mini Apps → Custom URL</b></li>
            </ul>
          </div>
        </div>
      )}

      <main className="main">
        <div className="card">
          <div className="card-header">WALLET</div>
          <div className="card-value">
            {wallet.connected
              ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
              : '—'}
          </div>
        </div>

        <div className="card">
          <div className="card-header">ACTIVE NETWORK</div>
          <div className="card-value">
            {wallet.connected && activeHex ? chainLabel(activeHex) : '—'}
          </div>
          {wallet.connected && activeHex && (
            <div className="card-value dim">{activeHex}</div>
          )}
        </div>

        {wallet.connected && (
          <div className="card">
            <div className="card-header">TARGET</div>
            <div className="card-value">Polygon {POLYGON_CHAIN_ID_HEX}</div>
          </div>
        )}

        <div className="card">
          <div className="card-header">POL</div>
          <div className="card-value">{wallet.connected ? wallet.polBalance : '—'}</div>
        </div>

        <div className="card">
          <div className="card-header">USDT0 CONTRACT</div>
          <div className="card-value mono">{USDT0_POLYGON}</div>
        </div>

        <div className="card">
          <div className="card-header">RELAY CONTRACT</div>
          <div className="card-value mono">{ZERO_RELAY}</div>
          <div className="card-value dim">{ZERO_RELAY_COMMENT}</div>
        </div>

        {wallet.connected && resolved !== null && (
          <div className={`chain-state ${canSign ? 'chain-ok' : 'chain-block'}`}>
            <div className="chain-state-title">
              {switching
                ? 'SWITCHING NETWORK…'
                : canSign
                  ? resolved.status === 'SWITCHED'
                    ? 'SWITCHED TO POLYGON — SIGN READY'
                    : 'POLYGON ACTIVE — SIGN READY'
                  : resolved.status === 'MISMATCH'
                    ? `NEEDS SWITCH: active ${resolved.activeChainHex} ≠ 0x89`
                    : resolved.status === 'REJECTED'
                      ? 'BLOCKED: CHAIN SWITCH REJECTED'
                      : 'BLOCKED: CHAIN SWITCH UNSUPPORTED'}
            </div>
            {'error' in resolved && resolved.error && (
              <div className="chain-state-error">{resolved.error}</div>
            )}
          </div>
        )}

        {!wallet.connected ? (
          <button className="btn-primary" onClick={connectWallet}>
            CONNECT WALLET
          </button>
        ) : (
          <>
            {!canSign && (
              <button className="btn-primary" onClick={switchToPolygon} disabled={switching}>
                {switching ? 'SWITCHING…' : 'SWITCH TO POLYGON'}
              </button>
            )}
            <button
              className="btn-primary"
              onClick={signTestPayment}
              disabled={!canSign || switching || permitTest.status === 'signing'}
            >
              {permitTest.status === 'signing' ? 'SIGNING…' : 'SIGN TEST PAYMENT'}
            </button>
          </>
        )}

        {[permitTest, orderTest].filter(t => t.status !== 'idle').map((t, i) => (
          <div key={t.kind} className={`result ${t.status}`} style={{ marginTop: i === 0 ? '1rem' : 0 }}>
            <div className="result-status">{t.kind === 'permit' ? 'PERMIT' : 'RELAY ORDER'} — {t.status === 'success' ? 'PASS' : t.status === 'fail' ? 'FAIL' : t.status === 'error' ? 'ERROR' : 'SIGNING…'}</div>
            {t.status !== 'signing' && (
              <>
                <div className="result-section">
                  <div className="result-label">RECOVERED SIGNER</div>
                  <div className="result-value mono">{t.recoveredSigner || '—'}</div>
                </div>
                <div className="result-section">
                  <div className="result-label">EXPECTED SIGNER</div>
                  <div className="result-value mono">{t.expectedSigner || '—'}</div>
                </div>
                {t.signature && (
                  <div className="result-section">
                    <div className="result-label">SIGNATURE</div>
                    <div className="result-value mono">{t.signature.slice(0, 20)}…{t.signature.slice(-16)}</div>
                  </div>
                )}
                {t.error && (
                  <div className="result-section">
                    <div className="result-label">ERROR</div>
                    <div className="result-value">{t.error}</div>
                    {t.errorRaw && <div className="result-value mono">{t.errorRaw}</div>}
                  </div>
                )}
              </>
            )}
          </div>
        ))}

        {permitTest.status === 'success' && orderTest.status === 'success' && (
          <div className="verification-chain">
            <div className="chain-item">
              <span className="chain-label">Nimiq Pay device signs</span>
              <span className="chain-arrow">↓</span>
            </div>
            <div className="chain-item">
              <span className="chain-label">eth_signTypedData_v4</span>
              <span className="chain-arrow">↓</span>
            </div>
            <div className="chain-item">
              <span className="chain-label">Permit (USDT0 domain, salt=chainId)</span>
              <span className="chain-arrow">↓</span>
            </div>
            <div className="chain-item">
              <span className="chain-label">RelayOrder (ZeroPayRelay domain)</span>
              <span className="chain-arrow">↓</span>
            </div>
            <div className="chain-item">
              <span className="chain-label">recover both signers</span>
              <span className="chain-arrow">↓</span>
            </div>
            <div className="chain-item">
              <span className="chain-label">== connected wallet</span>
              <span className="chain-status pass">✓</span>
            </div>
          </div>
        )}
      </main>

      <footer className="footer">
        <span className="footer-label">ZERO P0</span>
        <span className="footer-sep">·</span>
        <span className="footer-label">REAL EIP-712</span>
      </footer>
    </div>
  )
}

export default App