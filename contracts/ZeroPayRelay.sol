// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ZeroPayRelay — atomic ERC-2612 permit + transferFrom with recipient binding
/// @notice The user signs two EIP-712 messages:
///   (1) Standard ERC-2612 Permit (token domain) → authorizes relay as spender
///   (2) RelayOrder (relay domain) → binds recipient, amount, token, chainId, deadline, nonce
///   Both signatures must recover to the same address. Single tx = atomic, relay pays gas.

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function transferFrom(address from, address to, uint256 value) external returns (bool);

    function nonces(address owner) external view returns (uint256);

    function DOMAIN_SEPARATOR() external view returns (bytes32);

    function allowance(address owner, address spender) external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 value) external returns (bool);
}

contract ZeroPayRelay {
    // ── Relay order binding (ZERO's own EIP-712 domain) ──
    bytes32 public constant RELAY_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public constant RELAY_ORDER_TYPEHASH =
        keccak256("RelayOrder(address from,address to,uint256 amount,address token,uint256 chainId,uint256 deadline,uint256 nonce)");

    string public constant NAME = "ZeroPayRelay";
    string public constant VERSION = "1";

    address public immutable token;

    // nonce tracking per signer (relay-order nonce, independent of token nonces)
    mapping(address => uint256) public relayNonces;
    mapping(address => mapping(uint256 => bool)) public relayNonceUsed;

    // events
    event RelayExecuted(address indexed from, address indexed to, uint256 amount, uint256 relayNonce);

    error InvalidSignature();
    error InvalidRelayOrder();
    error NonceAlreadyUsed();
    error PermitFailed();

    constructor(address _token) {
        token = _token;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            RELAY_DOMAIN_TYPEHASH,
            keccak256(bytes(NAME)),
            keccak256(bytes(VERSION)),
            block.chainid,
            address(this)
        ));
    }

    /// @notice Execute an atomic permit + transfer in a single tx, relay pays gas
    /// @param from       Token owner (user)
    /// @param to         Recipient
    /// @param amount     Exact transfer amount (must match permit value)
    /// @param deadline   Permit + relay deadline
    /// @param relayNonce User's relay nonce ( replay protection )
    /// @param permitV    ERC-2612 permit v
    /// @param permitR    ERC-2612 permit r
    /// @param permitS    ERC-2612 permit s
    /// @param relayV     RelayOrder v
    /// @param relayR     RelayOrder r
    /// @param relayS     RelayOrder s
    function relay(
        address from,
        address to,
        uint256 amount,
        uint256 deadline,
        uint256 relayNonce,
        uint8 permitV, bytes32 permitR, bytes32 permitS,
        uint8 relayV, bytes32 relayR, bytes32 relayS
    ) external {
        // ── 1. Enforce deadline ──
        require(block.timestamp <= deadline, "Relay: expired");

        // ── 2. Verify relay-order nonce not used ──
        if (relayNonceUsed[from][relayNonce]) revert NonceAlreadyUsed();

        // ── 3. Verify relay-order signature (ZERO domain, binds recipient) ──
        bytes32 relayHash = keccak256(abi.encodePacked(
            "\x19\x01",
            domainSeparator(),
            keccak256(abi.encode(
                RELAY_ORDER_TYPEHASH,
                from,
                to,
                amount,
                token,
                block.chainid,
                deadline,
                relayNonce
            ))
        ));
        address relaySigner = ecrecover(relayHash, relayV, relayR, relayS);
        if (relaySigner == address(0) || relaySigner != from) revert InvalidSignature();

        // ── 4. Mark relay nonce used (replay protection) ──
        relayNonceUsed[from][relayNonce] = true;
        relayNonces[from]++;

        // ── 5. Execute ERC-2612 permit (sets allowance from → this for amount) ──
        IERC20Permit(token).permit(from, address(this), amount, deadline, permitV, permitR, permitS);

        // ── 6. Verify allowance was set (defense-in-depth) ──
        uint256 allowed = IERC20Permit(token).allowance(from, address(this));
        if (allowed < amount) revert PermitFailed();

        // ── 7. Execute transferFrom (atomic with permit in same tx) ──
        //    Since permit grants exactly `amount`, transferFrom consumes the full allowance.
        IERC20Permit(token).transferFrom(from, to, amount);

        emit RelayExecuted(from, to, amount, relayNonce);
    }
}
