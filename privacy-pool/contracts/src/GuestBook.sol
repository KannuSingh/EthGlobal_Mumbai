// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A stand-in for "any dapp": records who signed and what they wrote. The sponsored
/// transaction's SENDER frame calls it as the user's own account, which holds no ETH.
contract GuestBook {
    mapping(address => uint256) public entries;
    event Signed(address indexed who, uint256 count, string text);

    function sign(string calldata text) external {
        uint256 count = ++entries[msg.sender];
        emit Signed(msg.sender, count, text);
    }
}
