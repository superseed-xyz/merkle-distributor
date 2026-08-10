// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

error AlreadyClaimed();
error InvalidProof();
error ClaimWindowFinished();
error NoWithdrawDuringClaim();
error NotOwner();
error TransferFailed();
error EndTimeInPast();

/// @notice Distributes native ETH against a merkle root.
/// @dev Designed to be installed as the implementation behind an existing upgradeable
///      proxy that already holds ETH and already has unrelated data in slots 0..n.
///      Configuration is held in immutables (which live in code, not storage, and so
///      survive delegatecall), and the only storage this contract touches is a single
///      ERC-7201 namespaced struct. Nothing here reads or writes the proxy's legacy slots.
contract MerkleDistributorETH {
    /// @custom:storage-location erc7201:superseed.merkledistributor.eth
    struct DistributorStorage {
        mapping(uint256 => uint256) claimedBitMap;
    }

    // keccak256(abi.encode(uint256(keccak256("superseed.merkledistributor.eth")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT = 0xbd41cceab922f36bac0cf81de847cd25a494caecc49165e378ce2a722e723100;

    bytes32 public immutable merkleRoot;
    uint256 public immutable endTime;
    address public immutable owner;

    event Claimed(uint256 index, address account, uint256 amount);

    constructor(bytes32 merkleRoot_, uint256 endTime_, address owner_) {
        if (endTime_ <= block.timestamp) revert EndTimeInPast();
        merkleRoot = merkleRoot_;
        endTime = endTime_;
        owner = owner_;
    }

    function _storage() private pure returns (DistributorStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }

    function version() external pure returns (string memory) {
        return "1.0.0";
    }

    function isClaimed(uint256 index) public view returns (bool) {
        uint256 claimedWordIndex = index / 256;
        uint256 claimedBitIndex = index % 256;
        uint256 claimedWord = _storage().claimedBitMap[claimedWordIndex];
        uint256 mask = (1 << claimedBitIndex);
        return claimedWord & mask == mask;
    }

    function _setClaimed(uint256 index) private {
        uint256 claimedWordIndex = index / 256;
        uint256 claimedBitIndex = index % 256;
        DistributorStorage storage $ = _storage();
        $.claimedBitMap[claimedWordIndex] = $.claimedBitMap[claimedWordIndex] | (1 << claimedBitIndex);
    }

    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata merkleProof) external {
        if (block.timestamp > endTime) revert ClaimWindowFinished();
        if (isClaimed(index)) revert AlreadyClaimed();

        bytes32 node = keccak256(abi.encodePacked(index, account, amount));
        if (!MerkleProof.verifyCalldata(merkleProof, merkleRoot, node)) revert InvalidProof();

        // Effects before interaction: a reentrant claim on this index hits AlreadyClaimed,
        // so no reentrancy guard is required.
        _setClaimed(index);

        (bool ok, ) = account.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Claimed(index, account, amount);
    }

    /// @notice Sweeps everything left to `owner`, but only once the claim window has closed.
    function withdraw() external {
        if (msg.sender != owner) revert NotOwner();
        if (block.timestamp < endTime) revert NoWithdrawDuringClaim();
        (bool ok, ) = owner.call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev The OP-Stack proxy delegates plain transfers, so without this every ETH send
    ///      to the proxy address would revert.
    receive() external payable {}
}
