# NimZero

**Pay USDT on Polygon without POL.**

```
USDT:      $10.00
POL:       0
→
$1.00 USDT sent
POL:       0
→
Polygon transaction verified.
```

The user holds USDT, holds **0 POL**, authorizes once in Nimiq Pay, and the payment still settles — because NimZero's relayer sponsors the gas, and the settlement is independently verified on Polygon.

---

## The problem

USDT lives on Polygon, but sending it still costs POL for gas. Anyone who holds USDT but has no POL is locked out of their own money — and on a fresh wallet, "just go buy POL" is a round trip through an exchange or a bridge, for a payment that should take seconds.

## Why Nimiq Pay

NimZero runs inside Nimiq Pay as a Mini App. Nimiq Pay supplies the wallet, the chain-switch, and the native signing surface. The user authorizes a Permit + RelayOrder pair exactly like any EVM dapp — but they never touch a private key, and they never need POL.

## How it works

1. **Sign** — the user enters a recipient and amount and authorizes two EIP-712 messages in Nimiq Pay: a USDT0 `Permit` and a `RelayOrder` that binds recipient, amount, token, chain, deadline, and nonce.
2. **Relay** — the NimZero relayer submits one transaction to the `ZeroPayRelay` contract. The contract atomically calls `permit()` then `transferFrom()`, so the user's USDT moves exactly once, in exactly the agreed amount, to exactly the agreed recipient.
3. **Verify** — NimZero reads Polygon directly: the transaction exists, succeeded, called the pinned relay, and emitted a `RelayExecuted` event matching payer, recipient, and exact amount. Only then does it show **Payment verified**.
4. **Receipt** — gas was paid by the relayer. The user's POL never moves.

## Components

| Component | Location | What it is |
| --- | --- | --- |
| Mini App | `src/` (React + Vite) | Consumer UI: Home → Review → Authorize → Receipt |
| Relayer server | `scripts/relayer-server.cjs` | Zero-dependency HTTP server; submits the relay tx and independently verifies it |
| Contracts | `contracts/ZeroPayRelay.sol` | Token-immutable, chain-agnostic atomic permit + transfer |
| Tests | `tests/` + fork scripts | 69 unit/integration tests + adversarial kill suite |

The frontend calls `/api/config` at startup and adapts to whatever chain the operator has configured — Polygon mainnet USDT0 by default, or a testnet deployment (same software, different env vars).

## Security model

- **The relayer cannot redirect funds.** The `RelayOrder` binds `from`, `to`, `amount`, `token`, `chainId`, `deadline`, `nonce`; both signatures must recover to the payer. If anything is modified after signing, `verifyAuthorization` rejects it and the relay reverts.
- **Replay is impossible.** Both the token nonce and the relay nonce are consumed on-chain exactly once.
- **The relayer is operator-pinned.** The relayer executes only its configured contract; an authorization bound to any other relay address is rejected.
- **The token is exact.** The Permit uses USDT0's non-standard domain (`EIP712Domain(name,version,verifyingContract,salt)` — chainId lives in the salt slot) so the signed permit is valid on-chain USDT0, no approximations.
- **The testnet token is always labelled.** A testnet deployment uses `NIM-USDT` symbol and is displayed as a testnet in the app; it can never be mistaken for production USDT0.

## Evidence hierarchy

1. **Fork proof (security):** 69 unit/integration tests + the adversarial kill suite — every tamper (recipient, amount, payer, token, chain, deadline, nonce, spender, malicious relayer, replay) fails with a specific reason. Proven against a hardhat fork of Polygon mainnet.
2. **Live testnet proof (product):** the same Mini App deployed publicly, executed on Ethereum Sepolia with a USDT0-compatible test token — real Nimiq Pay signing, real relayer, real on-chain transfer, real explorer verification.
3. **Production proof (optional):** same software, `ZERO_CHAIN_ID=137`, real USDT0. Pending real funding.

Testnet proves the mechanism; only a mainnet transaction proves production USDT0 settlement. This README states only what has actually been shown.

## Tests

```bash
npm test            # 69 unit/integration tests
npm run lint        # oxlint, 0 errors
npm run build       # typecheck + production bundle
npm run fork:kill   # adversarial kill suite on a Polygon fork
npm run fork:pipeline   # end-to-end sign → relay → verify on fork
npm run fork:sepolia    # testnet rehearsal: USDT0-mirror + gasless relay on a Sepolia fork
```

## Run locally

```bash
# 1. Relayer (demo mode — signing works, settlement clearly pending)
RELAY=0x625C12eE38AAF831D3b4d644D7DaA962e2a26E0a node scripts/relayer-server.cjs

# 2. Frontend (dev server proxies /api → relayer on :8787)
npm run dev

# 3. Open http://localhost:5173 inside Nimiq Pay
```

Testnet rehearsal without spending faucet ETH (uses a local Sepolia fork):

```bash
npx hardhat node --config scripts/hardhat-sepolia-fork.config.cjs
npm run fork:sepolia
```

Funded mode — the relayer holds a private key (never in the repo):

```bash
RELAY=0x… RELAYER_PRIVATE_KEY=0x… node scripts/relayer-server.cjs
```

## Deploy (Vercel + relayer host)

The frontend and the relayer are separate processes, by design.

**Frontend — Vercel**

```bash
npm i -g vercel
vercel login
vercel            # framework auto-detected (vite); build = npm run build
vercel --prod
```

Set `VITE_RELAYER_URL=https://relayer.yourhost.com` in the Vercel project settings and rebuild. The built app then talks to the relayer host directly (CORS is open; the relayer holds the private key, the frontend never does).

**Relayer — any always-on host** (Railway, Render, Fly, a VPS). Same command as local, with `ZERO_*` and `RELAYER_PRIVATE_KEY` set. See `.env.example` for the full table.

## Live testnet proof (Ethereum Sepolia)

Why Sepolia: Nimiq Pay's supported EVM networks are Ethereum Mainnet, Polygon, Arbitrum One, Optimism, Base, BNB Smart Chain, and **Sepolia** (its testnet for developers). Polygon Amoy is not in that list, so the live testnet proof runs on Sepolia — the testnet the user's wallet can actually switch to. Production remains Polygon mainnet USDT0.

1. Get free Sepolia ETH from a faucet (e.g. [Alchemy's Sepolia faucet](https://www.alchemy.com/faucets/ethereum-sepolia)).

2. Deploy the test token + relay. **No private key needed** — the first run
   generates a dedicated local deployer + relayer wallet pair in
   `.sepolia/secrets.json` (gitignored, `0600`). Fund **both** printed
   addresses from the faucet, then deploy:

```bash
USER_ADDRESS=0x… AMOUNT=100 npm run deploy:sepolia
```

   - `USER_ADDRESS` is your **Nimiq Pay EVM address** — used only as the mint
     target/recipient, never as a signer, and it stays at **0 ETH**.
   - The script prints exactly the four addresses you need: `deployer`,
     `relayer`, deployed `relay`, deployed `token`. It never prints or
     commits private keys.
   - Mint more NIM-USDT to the user anytime:
     ```bash
     ZERO_TOKEN=0x… USER_ADDRESS=0x… AMOUNT=50 npm run mint:sepolia
     ```

3. Run the relayer against that stack. Locally, `RELAYER_PRIVATE_KEY` is
   filled in automatically from `.sepolia/secrets.json`; on a host, set it to
   the relayer key (never in the repo):

```bash
RELAY=0x… ZERO_CHAIN_ID=11155111 ZERO_NETWORK="Ethereum Sepolia (testnet)" \
ZERO_TOKEN=0x… ZERO_TOKEN_SYMBOL=NIM-USDT ZERO_RPC_URL=… node scripts/relayer-server.cjs
```
4. Deploy the frontend pointed at that relayer.
5. In Nimiq Pay: switch to Sepolia → wallet shows `NIM-USDT` funded, `0 ETH` → send → signed → relayer settles → **Payment verified** → `POL: 0`.

The user never holds Sepolia ETH; the sender only signs. The user-facing app shows a **Testnet** badge and the token symbol `NIM-USDT`. No testnet event is presented as mainnet.

## Limitations

- The fork-tested relay has not yet been deployed to Polygon mainnet; production settlement requires deploying `ZeroPayRelay` and funding a relayer (the allocation gate).
- Testnet proof exercises a token that mirrors USDT0's exact permit construction, not the production USDT0 contract itself.
- Polygonscan links render for the configured network; on a testnet deployment they point at Sepolia Etherscan.