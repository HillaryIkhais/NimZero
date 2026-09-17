const hardhat = require('hardhat');
const { ethers } = hardhat;

const USDT0 = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const WHALE = "0xf89d7b9c864f589bbF53a82105107622B35EaA40";

(async () => {
  const [deployer] = await ethers.getSigners();
  const Relay = await ethers.getContractFactory("ZeroPayRelay");
  const relay = await Relay.deploy(USDT0);
  await relay.waitForDeployment();
  const relayAddr = await relay.getAddress();

  const userKey = "0xa1fb4d7dbe4a6069d86dfb8f3724f769e0c1254dd0f70cda17477f6ec24a05dc";
  const userWallet = new ethers.Wallet(userKey, ethers.provider);
  const user = userWallet.address;

  const recipientKey = "0x39b685aa25be121ffef90ed65973fcca0d7688dd56ac20df96db5ccd767f7842";
  const recipientWallet = new ethers.Wallet(recipientKey, ethers.provider);
  const recipient = recipientWallet.address;

  const relayerKey = "0x7d7019567960a7cd83b76f3442dfaf259116d1f9fafc333c94088f968ad72005";
  const relayerWallet = new ethers.Wallet(relayerKey, ethers.provider);
  const relayer = relayerWallet.address;

  // fund user with USDT0 from whale
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [WHALE] });
  const whale = await ethers.getSigner(WHALE);
  const usdt = await ethers.getContractAt("IERC20Permit", USDT0);
  const amount = ethers.parseUnits("50", 6);
  await usdt.connect(whale).transfer(user, amount);

  // fund relayer with POL
  await deployer.sendTransaction({ to: relayer, value: ethers.parseEther("1") });

  const polUser = await ethers.provider.getBalance(user);
  const usdtUser = await usdt.balanceOf(user);
  const polRelayer = await ethers.provider.getBalance(relayer);

  const out = {
    relay: relayAddr,
    user,
    userKey,
    recipient,
    recipientKey,
    relayer,
    relayerKey,
    polUser: polUser.toString(),
    usdtUser: usdtUser.toString(),
    polRelayer: polRelayer.toString(),
    rpc: "http://127.0.0.1:8545"
  };
  require('fs').writeFileSync("build/killtest-env.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})().catch((err) => { console.error(err); process.exit(1); });