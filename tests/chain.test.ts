import { describe, it, expect } from 'vitest'
import {
  parseChainId,
  normalizeChainIdHex,
  chainLabel,
  canSignOn,
  matchChain,
  ensurePolygon,
  POLYGON_CHAIN_ID_HEX,
  POLYGON_CHAIN_META,
  type ChainController
} from '../src/core/chain'

interface Call {
  method: string
  params?: unknown[]
}

function mockController(routes: Record<string, () => unknown>): { ctrl: ChainController; calls: Call[] } {
  const calls: Call[] = []
  const ctrl: ChainController = {
    request: async (args) => {
      calls.push({ method: args.method, params: args.params })
      const route = routes[args.method]
      if (!route) throw new Error(`no route for ${args.method}`)
      return route()
    }
  }
  return { ctrl, calls }
}

describe('chain helpers', () => {
  it('parses hex and decimal chain ids', () => {
    expect(parseChainId('0x89')).toBe(137)
    expect(parseChainId('137')).toBe(137)
    expect(parseChainId(137)).toBe(137)
  })

  it('normalizes chain ids to 0x hex', () => {
    expect(normalizeChainIdHex('0x89')).toBe('0x89')
    expect(normalizeChainIdHex('137')).toBe('0x89')
    expect(normalizeChainIdHex(1)).toBe('0x1')
  })

  it('labels known chains', () => {
    expect(chainLabel('0x89')).toBe('Polygon (0x89)')
    expect(chainLabel('0x1')).toBe('Ethereum (0x01)')
    expect(chainLabel('0x9999')).toBe('Chain 0x9999')
  })
})

describe('matchChain', () => {
  it('matches when active chain is Polygon', () => {
    const status = matchChain('0x89')
    expect(status.status).toBe('MATCHED')
    expect(canSignOn(status)).toBe(true)
  })

  it('mismatch when active chain is not Polygon (signing blocked)', () => {
    const status = matchChain('0x1')
    expect(status.status).toBe('MISMATCH')
    expect(status.activeChainHex).toBe('0x1')
    expect(canSignOn(status)).toBe(false)
  })
})

describe('ensurePolygon', () => {
  it('proceeds when active chain already matches the payload chain', async () => {
    const { ctrl, calls } = mockController({
      eth_chainId: () => POLYGON_CHAIN_ID_HEX
    })
    const status = await ensurePolygon(ctrl)
    expect(status.status).toBe('MATCHED')
    expect(canSignOn(status)).toBe(true)
    expect(calls.filter(c => c.method === 'wallet_switchEthereumChain')).toHaveLength(0)
  })

  it('switches then re-reads chain id before signing', async () => {
    let reads = 0
    const { ctrl, calls } = mockController({
      eth_chainId: () => {
        reads++
        return reads === 1 ? '0x1' : '0x89'
      },
      wallet_switchEthereumChain: () => null
    })
    const status = await ensurePolygon(ctrl)
    expect(status.status).toBe('SWITCHED')
    expect(status.activeChainHex).toBe('0x89')
    expect(canSignOn(status)).toBe(true)
    expect(reads).toBe(2)
    expect(calls).toContainEqual({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] })
  })

  it('adds the chain first when switch returns 4902', async () => {
    let reads = 0
    const { ctrl, calls } = mockController({
      eth_chainId: () => {
        reads++
        return reads === 1 ? '0x1' : '0x89'
      },
      wallet_switchEthereumChain: () => {
        throw { code: 4902, message: 'Unrecognized chain ID' }
      },
      wallet_addEthereumChain: () => null
    })
    const status = await ensurePolygon(ctrl)
    expect(status.status).toBe('SWITCHED')
    expect(calls).toContainEqual({ method: 'wallet_addEthereumChain', params: [POLYGON_CHAIN_META] })
  })

  it('reports REJECTED when user rejects the switch', async () => {
    const { ctrl } = mockController({
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => {
        throw { code: 4001, message: 'User rejected the request.' }
      }
    })
    const status = await ensurePolygon(ctrl)
    expect(status.status).toBe('REJECTED')
    expect(status.activeChainHex).toBe('0x1')
    expect(status.error).toContain('4001')
    expect(canSignOn(status)).toBe(false)
  })

  it('reports REJECTED when user rejects the add-chain fallback', async () => {
    const { ctrl } = mockController({
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => {
        throw { code: 4902, message: 'Unrecognized chain ID' }
      },
      wallet_addEthereumChain: () => {
        throw { code: 4001, message: 'User rejected the request.' }
      }
    })
    const status = await ensurePolygon(ctrl)
    expect(status.status).toBe('REJECTED')
    expect(canSignOn(status)).toBe(false)
  })

  it('reports UNSUPPORTED when switch method is not available', async () => {
    const { ctrl } = mockController({
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => {
        throw { code: -32601, message: 'Method not found' }
      }
    })
    const status = await ensurePolygon(ctrl)
    expect(status.status).toBe('UNSUPPORTED')
    expect(status.error).toContain('-32601')
    expect(canSignOn(status)).toBe(false)
  })

  it('reports UNSUPPORTED when add-chain method is not available', async () => {
    const { ctrl } = mockController({
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => {
        throw { code: 4902, message: 'Unrecognized chain ID' }
      },
      wallet_addEthereumChain: () => {
        throw { code: -32601, message: 'Method not found' }
      }
    })
    const status = await ensurePolygon(ctrl)
    expect(status.status).toBe('UNSUPPORTED')
    expect(canSignOn(status)).toBe(false)
  })

  it('reports MATCH/switch failure as MISMATCH when re-read differs', async () => {
    const { ctrl } = mockController({
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => null
    })
    const status = await ensurePolygon(ctrl)
    expect(status.status).toBe('MISMATCH')
    expect(status.activeChainHex).toBe('0x1')
    expect(status.error).toContain('expected 0x89')
    expect(canSignOn(status)).toBe(false)
  })

  it('reports UNSUPPORTED when eth_chainId itself fails', async () => {
    const { ctrl } = mockController({
      eth_chainId: () => {
        throw { code: -32601, message: 'Method not found' }
      }
    })
    const status = await ensurePolygon(ctrl)
    expect(status.status).toBe('UNSUPPORTED')
    expect(status.activeChainHex).toBe('')
    expect(canSignOn(status)).toBe(false)
  })
})