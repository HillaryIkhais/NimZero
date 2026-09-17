export const POLYGON_CHAIN_ID_HEX = '0x89'
export const POLYGON_CHAIN_ID_DECIMAL = 137
export const USDT0_POLYGON = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'

export const POLYGON_CHAIN_META = {
  chainId: POLYGON_CHAIN_ID_HEX,
  chainName: 'Polygon',
  rpcUrls: ['https://polygon-bor-rpc.publicnode.com'],
  nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
  blockExplorerUrls: ['https://polygonscan.com']
}

export interface ChainController {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

export type ChainStatus =
  | { status: 'MATCHED'; activeChainHex: string }
  | { status: 'SWITCHED'; activeChainHex: string }
  | { status: 'REJECTED'; activeChainHex: string; error: string }
  | { status: 'UNSUPPORTED'; activeChainHex: string; error: string }
  | { status: 'MISMATCH'; activeChainHex: string; error: string }

const KNOWN_CHAINS: Record<number, string> = {
  [POLYGON_CHAIN_ID_DECIMAL]: 'Polygon (0x89)',
  1: 'Ethereum (0x01)',
  10: 'Optimism (0x0a)',
  42161: 'Arbitrum One (0xa4b1)',
  8453: 'Base (0x2105)',
  56: 'BNB Smart Chain (0x38)',
  11155111: 'Sepolia (0xaa36a7)'
}

export function parseChainId(raw: string | number): number {
  if (typeof raw === 'number') return raw
  if (typeof raw !== 'string' || raw === '') return NaN
  return raw.startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10)
}

export function normalizeChainIdHex(raw: string | number): string {
  const n = parseChainId(raw)
  return Number.isNaN(n) ? String(raw) : '0x' + n.toString(16)
}

export function chainLabel(raw: string | number): string {
  const n = parseChainId(raw)
  if (!Number.isNaN(n) && KNOWN_CHAINS[n]) return KNOWN_CHAINS[n]
  return `Chain ${normalizeChainIdHex(raw)}`
}

export function canSignOn(status: ChainStatus): boolean {
  return status.status === 'MATCHED' || status.status === 'SWITCHED'
}

export function matchChain(active: string | number): ChainStatus {
  const hex = normalizeChainIdHex(active)
  return parseChainId(hex) === POLYGON_CHAIN_ID_DECIMAL
    ? { status: 'MATCHED', activeChainHex: hex }
    : { status: 'MISMATCH', activeChainHex: hex, error: `Active chain is ${hex}; expected 0x89` }
}

export function errorCode(err: unknown): number | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'number') return code
    if (typeof code === 'string' && /^\d+$/.test(code)) return parseInt(code, 10)
  }
  return null
}

export function describeError(err: unknown): string {
  const parts: string[] = []
  const code = errorCode(err)
  if (code != null) parts.push(`code=${code}`)
  if (err instanceof Error) {
    parts.push(err.message)
  } else if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string' && msg) parts.push(msg)
  } else if (typeof err === 'string' && err) {
    parts.push(err)
  }
  return parts.join(' · ') || String(err)
}

export function rawError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err)
  const own: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(err)) {
    const value = (err as Record<string, unknown>)[key]
    if (typeof value !== 'function') own[key] = value
  }
  const serialized = JSON.stringify(own)
  return serialized && serialized !== '{}' ? serialized : describeError(err)
}

function isRejection(err: unknown): boolean {
  const code = errorCode(err)
  if (code != null) return code === 4001
  const message = err instanceof Error ? err.message : String(err)
  return /reject|denied|declin|cancel/i.test(message)
}

export async function ensurePolygon(ctrl: ChainController): Promise<ChainStatus> {
  let active: string | number
  try {
    active = (await ctrl.request({ method: 'eth_chainId' })) as string | number
  } catch (err) {
    return {
      status: 'UNSUPPORTED',
      activeChainHex: '',
      error: `eth_chainId failed: ${describeError(err)}`
    }
  }

  const activeHex = normalizeChainIdHex(active)
  if (parseChainId(active) === POLYGON_CHAIN_ID_DECIMAL) {
    return { status: 'MATCHED', activeChainHex: activeHex }
  }

  try {
    await ctrl.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: POLYGON_CHAIN_ID_HEX }] })
  } catch (err) {
    if (errorCode(err) === 4902) {
      try {
        await ctrl.request({ method: 'wallet_addEthereumChain', params: [POLYGON_CHAIN_META] })
      } catch (err2) {
        return {
          status: isRejection(err2) ? 'REJECTED' : 'UNSUPPORTED',
          activeChainHex: activeHex,
          error: `wallet_addEthereumChain failed: ${describeError(err2)}`
        }
      }
    } else if (isRejection(err)) {
      return { status: 'REJECTED', activeChainHex: activeHex, error: describeError(err) }
    } else {
      return {
        status: 'UNSUPPORTED',
        activeChainHex: activeHex,
        error: `wallet_switchEthereumChain failed: ${describeError(err)}`
      }
    }
  }

  let now: string | number
  try {
    now = (await ctrl.request({ method: 'eth_chainId' })) as string | number
  } catch (err) {
    return {
      status: 'MISMATCH',
      activeChainHex: activeHex,
      error: `re-read eth_chainId after switch failed: ${describeError(err)}`
    }
  }

  const nowHex = normalizeChainIdHex(now)
  if (parseChainId(now) === POLYGON_CHAIN_ID_DECIMAL) {
    return { status: 'SWITCHED', activeChainHex: nowHex }
  }
  return {
    status: 'MISMATCH',
    activeChainHex: nowHex,
    error: `switch reported ok but eth_chainId is still ${nowHex}; expected 0x89`
  }
}