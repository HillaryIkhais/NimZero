// Local Sepolia fork — used to dry-run scripts/deploy-sepolia.cjs (and any
// testnet script) without spending faucet ETH:
//   npx hardhat node --config scripts/hardhat-sepolia-fork.config.cjs
//   USER_ADDRESS=<any-account> npx hardhat run scripts/deploy-sepolia.cjs --network localhost
module.exports = {
  solidity: { version: "0.8.28", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    hardhat: {
      chainId: 11155111,
      forking: {
        url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
  },
};