// SEPOLIA TESTNET REHEARSAL — the exact "live testnet proof" flow, dry-run
// against a local hardhat fork of Ethereum Sepolia (chainId 11155111).
//   npx hardhat node --config scripts/hardhat-sepolia-fork.config.cjs
//   npm run fork:sepolia
//
// Mirrors production Polygon to the letter, except:
//   • token = TestUSDT (USDT0-compatible salt-slot permit domain)
//   • chain  = 11155111
//   • salt slot = bytes32(11155111)
// The user holds 0 ETH; the relayer sponsors gas; on-chain permit() accepts
// the exact signatures the wallet's eth_signTypedData_v4 would produce.

const { ethers } = require("hardhat");

const NETWORK_NAME = "Ethereum Sepolia (testnet)";
const CHAIN_ID = 11155111;
const AMOUNT_USDT = 100;

(async function () {
  console.log("═══════════════════════════════════════════════════════");
  console.log(" SEPOLIA REHEARSAL — testnet USDT0 mirror + gasless relay");
  console.log(` chain: ${NETWORK_NAME} (${CHAIN_ID})`);
  console.log("═══════════════════════════════════════════════════════");

  const [deployer] = await ethers.getSigners();

  // ── the app's permit context: signed = {name,version,verifyingContract,salt} ──
  const TestUSDT = await ethers.getContractFactory("TestUSDT");
  const token = await TestUSDT.deploy("USDT0", "NIM-USDT");
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  const ctx = { token: tokenAddr, name: "USDT0", version: "1", saltSlot: true };

  const RelayFactory = await ethers.getContractFactory("ZeroPayRelay");
  const relay = await RelayFactory.deploy(tokenAddr);
  await relay.waitForDeployment();
  const relayAddr = await relay.getAddress();

  const user = ethers.Wallet.createRandom().connect(ethers.provider);
  const recipient = ethers.Wallet.createRandom().connect(ethers.provider);
  const relayerWallet = ethers.Wallet.createRandom().connect(ethers.provider);

  // ── fund user NIM-USDT (deployer mints; user keeps 0 ETH) ──
  const amountWei = ethers.parseUnits(String(AMOUNT_USDT), 6);
  await (await token.mint(user.address, amountWei)).wait();

  // ── fund relayer with Sepolia ETH for gas (deployer has plenty on fork) ──
  await (await deployer.sendTransaction({ to: relayerWallet.address, value: ethers.parseEther("1") })).wait();

  console.log("  token:     ", tokenAddr);
  console.log("  relay:     ", relayAddr);
  console.log("  User NIM-USDT:", (await token.balanceOf(user.address)).toString());
  console.log("  User ETH  :", (await ethers.provider.getBalance(user.address)).toString(), "(0 expected)");
  console.log("  Relayer ETH:", (await ethers.provider.getBalance(relayerWallet.address)).toString());

  const permanentDomain = await token.DOMAIN_SEPARATOR();

  // ── use the REAL pipeline from src/core (freshly compiled to CJS) ──
  const { createPaymentIntent } = require("../build/.pipeline/payment-intent");
  const relayer = require("../build/.pipeline/relayer");

  const intent = createPaymentIntent(user.address, recipient.address, AMOUNT_USDT);
  const tokenNonce = await token.nonces(user.address);
  const auth = await relayer.createSignedAuthorization(intent, user, relayAddr, tokenNonce, {
    chainId: CHAIN_ID,
    ctx
  });

  // The signed domain must match the token's on-chain DOMAIN_SEPARATOR —
  // otherwise the contract's permit() would reject these exact signatures.
  const signedDomain = relayer.computeUsdt0DomainSeparator(CHAIN_ID, ctx);
  console.log("  signed domain              :", signedDomain);
  console.log("  token DOMAIN_SEPARATOR()   :", permanentDomain);
  if (signedDomain.toLowerCase() !== permanentDomain.toLowerCase()) {
    throw new Error("signed permit domain does not match on-chain DOMAIN_SEPARATOR");
  }

  const authCheck = relayer.verifyAuthorization(auth, relayAddr, CHAIN_ID, ctx);
  console.log("  verifyAuthorization ok:", authCheck.ok, authCheck.errors.join("; "));
  if (!authCheck.ok) throw new Error("cryptographic verification failed on sepolia fork");

  const policy = {
    chainId: CHAIN_ID,
    token: tokenAddr,
    maxAmount: 10_000_000_000_000n,
    maxDeadlineAheadSeconds: 86_400,
    relay: relayAddr
  };
  const policyCheck = relayer.validatePolicy(auth, policy);
  console.log("  validatePolicy ok:", policyCheck.ok, policyCheck.errors.join("; "));
  if (!policyCheck.ok) throw new Error("policy validation failed on sepolia fork");

  console.log("\n  Executing relay on Sepolia fork...");
  const before = {
    recipient: await token.balanceOf(recipient.address),
    user: await token.balanceOf(user.address),
    userEth: await ethers.provider.getBalance(user.address),
    relayerEth: await ethers.provider.getBalance(relayerWallet.address)
  };

  const result = await relayer.executeRelay(
    { intent, authorization: auth },
    {
      provider: ethers.provider,
      relayWallet: relayerWallet,
      relayAddress: relayAddr,
      policy,
      chain: { ...ctx, chainId: CHAIN_ID }
    }
  );
  console.log("  executeRelay result:", JSON.stringify(result));
  if (!result.success || !result.txHash) throw new Error("executeRelay failed: " + result.error);

  const after = {
    recipient: await token.balanceOf(recipient.address),
    user: await token.balanceOf(user.address),
    userEth: await ethers.provider.getBalance(user.address),
    relayerEth: await ethers.provider.getBalance(relayerWallet.address)
  };

  const checks = [
    ["Recipient received exact amount", after.recipient - before.recipient === amountWei],
    ["User NIM-USDT decreased exactly", before.user - after.user === amountWei],
    ["User ETH unchanged (0)", after.userEth === before.userEth],
    ["Relayer paid gas (ETH decreased)", after.relayerEth < before.relayerEth],
    ["permit() accepted the wallet signatures (tx succeeded)", true],
    ["txHash produced by pipeline", /^0x[a-f0-9]{64}$/.test(result.txHash)],
    ["gasUsed reported", typeof result.gasUsed === "number" && result.gasUsed > 0]
  ];

  let pass = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "[PASS]" : "[FAIL]"}: ${label}`);
    if (!ok) pass = false;
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(pass ? " SEPOLIA REHEARSAL: PASS " : " SEPOLIA REHEARSAL: FAIL ");
  console.log(" REAL SEPOLIA MAINNET: UNPROVEN");
  console.log("═══════════════════════════════════════════════════════");
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error("SEPOLIA REHEARSAL FAILED:", err.message);
  process.exit(1);
});