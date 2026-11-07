// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Framecaster: short public posts (up to 160 bytes), threads, replies and likes, the
/// "any dapp" of this repository. Each call runs in a SENDER frame as the user's own account,
/// which holds no ETH; the privacy pool pays the gas. Posts live in event logs, not storage, so a
/// post writes no new storage slot and a like writes one, under the wallet's 200,000 state gas
/// per call.
///
/// A thread is one frame transaction whose calls are post() then thread() for each next part:
/// a thread part belongs to the post or part logged just before it by the same author in the
/// same transaction (the readers join them; the contract keeps no per-author state).
contract Framecaster {
    uint256 public constant MAX_BYTES = 160;

    uint8 public constant KIND_POST = 0;
    uint8 public constant KIND_REPLY = 1;
    uint8 public constant KIND_THREAD = 2;

    /// @notice The next post's id. It starts at 1, so ids are never 0 and counting writes no new slot.
    uint256 public nextId = 1;
    /// @notice Whether an account liked a post (one like per account per post).
    mapping(uint256 => mapping(address => bool)) public liked;

    /// @param parent The post replied to (KIND_REPLY), else 0.
    event Posted(uint256 indexed id, address indexed author, uint256 indexed parent, uint8 kind, string text);
    event Liked(uint256 indexed id, address indexed by);

    error EmptyOrTooLong();
    error NoSuchPost();
    error AlreadyLiked();

    /// @notice A new post.
    function post(string calldata text) external returns (uint256) {
        return _add(0, KIND_POST, text);
    }

    /// @notice The next part of a thread started earlier in this transaction.
    function thread(string calldata text) external returns (uint256) {
        return _add(0, KIND_THREAD, text);
    }

    /// @notice A reply to a post, a thread part or another reply.
    function reply(uint256 parent, string calldata text) external returns (uint256) {
        if (parent == 0 || parent >= nextId) revert NoSuchPost();
        return _add(parent, KIND_REPLY, text);
    }

    function like(uint256 id) external {
        if (id == 0 || id >= nextId) revert NoSuchPost();
        if (liked[id][msg.sender]) revert AlreadyLiked();
        liked[id][msg.sender] = true;
        emit Liked(id, msg.sender);
    }

    function _add(uint256 parent, uint8 kind, string calldata text) internal returns (uint256 id) {
        uint256 n = bytes(text).length;
        if (n == 0 || n > MAX_BYTES) revert EmptyOrTooLong();
        id = nextId++;
        emit Posted(id, msg.sender, parent, kind, text);
    }
}
