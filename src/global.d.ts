/// <reference types="vite/client" />

interface Window {
  ethereum?: Eip1193Provider
}

// Minimal shape of an EIP-1193 provider as consumed by ethers BrowserProvider.
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, cb: (payload: unknown) => void): void
  removeListener?(event: string, cb: (payload: unknown) => void): void
}