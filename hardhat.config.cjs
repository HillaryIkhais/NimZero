require("@nomicfoundation/hardhat-ethers");

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: {
      chainId: 137,
      forking: {
        url: "https://polygon.drpc.org",
      },
    },
    sepolia: {
      // Ethereum Sepolia (testnet for developers) — the EVM testnet Nimiq Pay
      // supports via wallet_switchEthereumChain. Used ONLY for the live
      // NimZero testnet proof. DEPLOYER_KEY must be a funded Sepolia key.
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
};