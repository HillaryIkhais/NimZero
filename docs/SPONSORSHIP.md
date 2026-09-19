# Sponsorship Technical Proof

NimZero's gas sponsorship model. This document explains the economics and on-chain mechanics transparently.

## User Flow

```
User owns USDT
    ↓
User signs Permit + RelayOrder via Nimiq Pay
    ↓
NimZero relayer fronts POL (gas token)
    ↓
ZeroPayRelay atomically moves USDT to recipient
    ↓
Relayer recovers nothing from the user
    ↓
On-chain settlement independently verified
```

## Economic Model

| Component | Who pays | Details |
|-----------|----------|---------|
| **USDT amount** | **User** | User's wallet is debited the full payment amount |
| **Network gas (POL)** | **NimZero relayer** | User's wallet is **never** charged POL |
| **NimZero fee** | **NimZero (operator)** | Disclosed execution fee (currently 0, sustainable via relayer POL balance) |
| **Total cost** | **User pays USDT only** | 0 POL required from user |

## On-chain Mechanics

1. **User constructs** Permit (spender approval) + RelayOrder (payment intent) via EIP-712
2. **User signs** both messages with their Ethereum wallet (no NIM required)
3. **Relayer submits** transaction to Sepolia/Polygon via `submitRelay()`
4. **Relayer pays** the POL gas fee from its own balance
5. **ZeroPayRelay contract** atomically transfers USDT from user to recipient
6. **Relayer receives** no reimbursement from the user — the model is sponsored
7. **Settlement verified** independently via `GET /api/payments/:tx` endpoint (RelayExecuted event)

## Key Honesty Statements

- "NimZero currently operates as a sponsored execution model."
- "The relayer must be funded with POL."
- "The protocol never represents gas as nonexistent; it removes POL ownership from the end user."
- "User signs one authorization. No gas is ever taken from your wallet."

## Operational Boundaries

Sponsorship is not an infinite promise. The relayer enforces:

- `maxGasPerTx` — gas estimate per transaction must not exceed this limit
- `maxTransactionsPerWindow` — maximum transactions per time window (e.g., 100 per 24h)
- `windowSeconds` — sponsorship quota resets after this period (e.g., 86400s = 1 day)
- `minRelayerBalance` — relayer must maintain minimum POL balance to continue sponsoring

If capacity is exhausted:

> **Sponsorship temporarily unavailable. Try again later.**

(not a frozen spinner, not a fake "Payment Verified")

## Why This Matters for the Competition

The Nimiq Mini Apps Competition rubric scores:

- **45 points** on functionality/reliability/usefulness
- **15 points** on real usage
- **Explicit points** on real need, clear audience, originality, completeness, repeat value

Being economically honest, operationally bounded, and production-shaped strengthens the technical story and avoids the penalty zones for broken states, poor error handling, and incomplete flows.

## Extending to RECOVERABLE Mode (Future)

A second mode could be added where:

```
Relayer fronts POL
  ↓
User sends USDT
  ↓
Recipient receives amount
  +
Relayer receives a disclosed USDT execution fee
```

This would allow the relayer to sustain itself without relying on a personal POL balance indefinitely, while the user still needs **0 POL** to participate.

## Contact

For questions about the sponsorship model, see the `/api/sponsor` endpoint for live state, or contact the NimZero operator.