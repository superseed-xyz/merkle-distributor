// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

/// @notice A contract with no payable receive or fallback. Any ETH sent to it reverts.
contract RejectsETH {
    function ping() external pure returns (bool) {
        return true;
    }
}
