// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title TestUSDT — Polygon-USDT0-compatible ERC-2612 with the salt-slot domain
/// @notice Deployed ONLY on a testnet (e.g. Ethereum Sepolia) so NimZero's exact
///   production permit construction can be exercised live without real USDT0.
///
///   It replicates the UChildUSDT0 peculiarity exactly:
///     EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)
///   with NO chainId field — chainId is encoded in the salt slot. This is the
///   non-standard domain that NimZero's wallet signing and the ZeroPayRelay
///   on-chain permit() path already depend on. A standard EIP-2612 token would
///   NOT be a faithful stand-in, so the testnet token mirrors the real one.
/// @dev This contract is never part of a production deployment.

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

contract TestUSDT is IERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;

    // ── EIP-712 (salt-slot variant, mirroring UChildUSDT0) ──
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)");
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    mapping(address => uint256) public nonces;

    bytes32 private _domainSeparator;

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
        _domainSeparator = keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes(name)),
            keccak256(bytes("1")),
            address(this),
            bytes32(block.chainid)
        ));
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return _domainSeparator;
    }

    function revertIfAddressZero(address account) internal pure {
        require(account != address(0), "TestUSDT: zero address");
    }

    function mint(address to, uint256 value) external {
        revertIfAddressZero(to);
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external override returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external override returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "TestUSDT: allowance exceeded");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        revertIfAddressZero(to);
        require(balanceOf[from] >= value, "TestUSDT: balance exceeded");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _approve(address owner, address spender, uint256 value) internal {
        revertIfAddressZero(spender);
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp <= deadline, "TestUSDT: permit expired");
        revertIfAddressZero(spender);

        bytes32 structHash = keccak256(abi.encode(
            PERMIT_TYPEHASH,
            owner,
            spender,
            value,
            nonces[owner]++,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == owner, "TestUSDT: invalid signature");

        _approve(owner, spender, value);
    }
}