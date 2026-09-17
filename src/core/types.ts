export interface PaymentIntent {
  id: string
  sender: string
  recipient: string
  amount: number
  asset: 'USDT'
  chain: 'polygon'
  nonce: number
  createdAt: number
  expiresAt: number
  hash: string
}

export interface PermitMessage {
  owner: string
  spender: string
  value: bigint
  nonce: bigint
  deadline: bigint
}

export interface RelayOrderMessage {
  from: string
  to: string
  amount: bigint
  token: string
  chainId: number
  deadline: bigint
  nonce: bigint
}

export interface SignedAuthorization {
  intentId: string
  signature: string
  signedBy: string
  signedAt: number
  permit: PermitMessage
  permitSignature: string
  order: RelayOrderMessage
  relay: string
}

export interface RelayPolicy {
  chainId: number
  token: string
  maxAmount: bigint
  maxDeadlineAheadSeconds: number
  relay: string
}

export interface RelayRequest {
  intent: PaymentIntent
  authorization: SignedAuthorization
}

export interface RelayResult {
  success: boolean
  txHash?: string
  gasUsed?: number
  error?: string
}

export interface VerificationResult {
  intentValid: boolean
  signatureValid: boolean
  nonceValid: boolean
  notExpired: boolean
  senderHasBalance: boolean
  recipientValid: boolean
  chainValid: boolean
  overall: 'CONFIRMED' | 'FAILED'
  details: string[]
}

export interface PaymentReceipt {
  id: string
  intent: PaymentIntent
  txHash: string
  gasPaidBy: 'ZERO'
  verified: boolean
  verification: VerificationResult
  completedAt: number
}

export interface WalletState {
  connected: boolean
  address: string | null
  chain: string | null
  usdtBalance: number
  polBalance: number
}
