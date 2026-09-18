// Deploy NimZero's live testnet stack to Ethereum Sepolia:
//   TestUSDT (USDT0-salt-slot-compatible, 6 decimals) + ZeroPayRelay(token)
//
//   DEPLOYER_KEY=0x.. USER_ADDRESS=0x.. [AMOUNT=100] npx hardhat run scripts/deploy-sepolia.cjs --network sepolia
//
// Then run the relayer against this deployment (see README → Live testnet):
//   ZERO_CHAIN_ID=11155111 ZERO_NETWORK="Ethereum Sepolia (testnet)" ZERO_TOKEN=<token>
//   ZERO_TOKEN_NAME=USDT0 ZERO_TOKEN_VERSION=1 ZERO_TOKEN_SYMBOL=NIM-USDT
//   ZERO_TOKEN_DECIMALS=6 ZERO_EXPLORER_URL=https://sepolia.etherscan.io
//   ZERO_RPC_URL=<sepolia rpc> RELAY=<relay> RELAYER_PRIVATE_KEY=0x.. node scripts/relayer-server.cjs

const { ethers } = require("hardhat");

const USER = process.env.USER_ADDRESS;
const AMOUNT = Number(process.env.AMOUNT || 100);

(async () => {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance: ", (await deployer.provider.getBalance(deployer.address)).toString(), "wei"); // the deployer's SEPOLIA ETH
  if (!USER) {
    console.error("USER_ADDRESS required — the wallet that will send the test USDT with 0 gas.");
    process.exit(2);
  }
  if (USER.toLowerCase() === deployer.address.toLowerCase()) {
    console.error("USER_ADDRESS must differ from the deployer, so the user can hold 0 gas.");
    process.exit(2);
  }

  // 1) TestUSDT — name/version mirror production USDT0 so the permit domain is
  //    byte-for-byte identical (only the salt holds chainId 11155111).
  const TestUSDT = await ethers.getContractFactory("TestUSDT");
  const token = await TestUSDT.deploy("USDT0", "NIM-USDT");
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();

  // 2) ZeroPayRelay — same bytecode path as the fork-tested mainnet primitive.
  const ZeroPayRelay = await ethers.getContractFactory("ZeroPayRelay");
  const relay = await ZeroPayRelay.deploy(tokenAddr);
  await relay.waitForDeployment();
  const relayAddr = await relay.getAddress();

  // 3) Fund the user with test USDT (they keep 0 ETH — that's the point).
  const amountWei = BigInt(Math.round(AMOUNT * 1e6));
  await (await token.mint(USER, amountWei)).wait();

  const domain = await token.DOMAIN_SEPARATOR();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log("\n=== Sepolia deployment ===");
  console.log("chainId:      ", Number(chainId));
  console.log("token:        ", tokenAddr);
  console.log("token symbol: ", await token.symbol());
  console.log("token name:   ", await token.name());
  console.log("domain sep:   ", domain);
  console.log("relay:        ", relayAddr);
  console.log("user:         ", USER);
  console.log("user funded:  ", AMOUNT, "NIM-USDT");
  console.log("\nRelayer env:");
  console.log(`ZERO_CHAIN_ID=${Number(chainId)}`);
  console.log(`ZERO_NETWORK="Ethereum Sepolia (testnet)"`);
  console.log(`ZERO_TOKEN=${tokenAddr}`);
  console.log(`ZERO_TOKEN_NAME=USDT0`);
  console.log(`ZERO_TOKEN_VERSION=1`);
  console.log(`ZERO_TOKEN_SYMBOL=NIM-USDT`);
  console.log(`ZERO_TOKEN_DECIMALS=6`);
  console.log(`ZERO_SALT_SLOT=1`);
  console.log(`ZERO_EXPLORER_URL=https://sepolia.etherscan.io`);
  console.log(`ZERO_RPC_URL=${process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"}`);
  console.log(`RELAY=${relayAddr}`);
  console.log("RELAYER_PRIVATE_KEY=<separate funded Sepolia key for the relayer>");
  console.log("\nThe user's wallet must switch to Sepolia and show 0 ETH + funded NIM-USDT.");
})().catch((err) => {
  console.error("deploy-sepolia FAILED:", err);
  process.exit(1);
});