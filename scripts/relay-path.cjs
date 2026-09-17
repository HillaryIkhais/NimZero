const { ethers, network } = require("hardhat");

const USDT0 = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const WHALE = "0xf89d7b9c864f589bbF53a82105107622B35EaA40";
const AMOUNT_USDT = 100;

(async function () {
  console.log("═══════════════════════════════════════════════════════");
  console.log(" ZERO PIPELINE INTEGRATION — executeRelay on fork");
  console.log("═══════════════════════════════════════════════════════");

  const usdt = await ethers.getContractAt("IERC20Permit", USDT0);

  const user = ethers.Wallet.createRandom().connect(ethers.provider);
  const recipient = ethers.Wallet.createRandom().connect(ethers.provider);
  const relayerWallet = ethers.Wallet.createRandom().connect(ethers.provider);

  // ── fund user USDT0 via whale ──
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [WHALE] });
  const whale = await ethers.getSigner(WHALE);
  await usdt.connect(whale).transfer(user.address, ethers.parseUnits(String(AMOUNT_USDT), 6));

  // ── fund relayer POL ──
  const [deployer] = await ethers.getSigners();
  await deployer.sendTransaction({ to: relayerWallet.address, value: ethers.parseEther("1") });

  console.log("  User USDT0:", (await usdt.balanceOf(user.address)).toString());
  console.log("  User POL  :", (await ethers.provider.getBalance(user.address)).toString(), "(0 expected)");
  console.log("  Relayer POL:", (await ethers.provider.getBalance(relayerWallet.address)).toString());

  // ── deploy ZeroPayRelay ──
  const RelayFactory = await ethers.getContractFactory("ZeroPayRelay");
  const relay = await RelayFactory.deploy(USDT0);
  await relay.waitForDeployment();
  const relayAddr = await relay.getAddress();
  console.log("\n  Relay deployed:", relayAddr);

  // ── use the REAL pipeline from src/core (freshly compiled to CJS) ──
  const { createPaymentIntent } = require("../build/.pipeline/payment-intent");
  const relayer = require("../build/.pipeline/relayer");

  const intent = createPaymentIntent(user.address, recipient.address, AMOUNT_USDT);
  const tokenNonce = await usdt.nonces(user.address);
  const auth = await relayer.createSignedAuthorization(intent, user, relayAddr, tokenNonce);

  const authCheck = relayer.verifyAuthorization(auth, relayAddr, relayer.POLYGON_CHAIN_ID);
  console.log("  verifyAuthorization ok:", authCheck.ok, authCheck.errors.join("; "));
  if (!authCheck.ok) throw new Error("cryptographic verification failed on fork");

  const policy = {
    chainId: relayer.POLYGON_CHAIN_ID,
    token: relayer.USDT0_TOKEN,
    maxAmount: 10_000_000_000_000n,
    maxDeadlineAheadSeconds: 86_400,
    relay: relayAddr,
  };
  const policyCheck = relayer.validatePolicy(auth, policy);
  console.log("  validatePolicy ok:", policyCheck.ok, policyCheck.errors.join("; "));
  if (!policyCheck.ok) throw new Error("policy validation failed on fork");

  console.log("\n  Executing relay...");
  const before = {
    recipient: await usdt.balanceOf(recipient.address),
    user: await usdt.balanceOf(user.address),
    userPol: await ethers.provider.getBalance(user.address),
    relayerPol: await ethers.provider.getBalance(relayerWallet.address),
  };

  const result = await relayer.executeRelay(
    { intent, authorization: auth },
    { provider: ethers.provider, relayWallet: relayerWallet, relayAddress: relayAddr, policy }
  );
  console.log("  executeRelay result:", JSON.stringify(result));

  if (!result.success || !result.txHash) throw new Error("executeRelay failed: " + result.error);

  const after = {
    recipient: await usdt.balanceOf(recipient.address),
    user: await usdt.balanceOf(user.address),
    userPol: await ethers.provider.getBalance(user.address),
    relayerPol: await ethers.provider.getBalance(relayerWallet.address),
  };

  const expected = ethers.parseUnits(String(AMOUNT_USDT), 6);
  const checks = [
    ["Recipient received exact amount", after.recipient - before.recipient === expected],
    ["User USDT0 decreased exactly", before.user - after.user === expected],
    ["User POL unchanged (0)", after.userPol === 0n],
    ["Relayer paid gas (POL decreased)", after.relayerPol < before.relayerPol],
    ["txHash produced by pipeline", /^0x[a-f0-9]{64}$/.test(result.txHash)],
    ["gasUsed reported", typeof result.gasUsed === "number" && result.gasUsed > 0],
  ];

  let pass = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "[PASS]" : "[FAIL]"}: ${label}`);
    if (!ok) pass = false;
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(pass ? " PIPELINE INTEGRATION: PASS " : " PIPELINE INTEGRATION: FAIL ");
  console.log(" REAL POLYGON: UNPROVEN");
  console.log("═══════════════════════════════════════════════════════");
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error("PIPELINE INTEGRATION FAILED:", err.message);
  process.exit(1);
});