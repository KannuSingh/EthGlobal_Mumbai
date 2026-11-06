// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-8421's IStakingRegistry as the alt mempool sidecar's design note gives it
/// (docs/superpowers/specs/2026-09-30-naive-staking-registry-design.md): per-caller stake, no
/// slashing, no admin. Deployed on the local chain so the sidecar can see the privacy pool as staked.
contract NaiveStakingRegistry {
    struct Deposit {
        uint256 stake;
        uint32 unstakeDelaySec;
        uint64 withdrawTime;
    }

    mapping(address => Deposit) private deposits;

    function addStake(uint32 unstakeDelaySec) external payable {
        Deposit storage d = deposits[msg.sender];
        require(unstakeDelaySec >= d.unstakeDelaySec, "cannot decrease unstake delay");
        d.stake += msg.value;
        d.unstakeDelaySec = unstakeDelaySec;
        d.withdrawTime = 0;
    }

    function unlockStake() external {
        Deposit storage d = deposits[msg.sender];
        require(d.stake > 0, "no stake");
        require(d.withdrawTime == 0, "already unlocking");
        d.withdrawTime = uint64(block.timestamp) + d.unstakeDelaySec;
    }

    function withdrawStake(address payable withdrawAddress) external {
        Deposit storage d = deposits[msg.sender];
        require(d.withdrawTime != 0 && block.timestamp >= d.withdrawTime, "not withdrawable");
        uint256 amount = d.stake;
        delete deposits[msg.sender];
        (bool ok,) = withdrawAddress.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    function getDepositInfo(address account)
        external
        view
        returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)
    {
        Deposit storage d = deposits[account];
        return (d.stake, d.unstakeDelaySec, d.withdrawTime);
    }
}
