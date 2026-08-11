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
error ZeroOwner();

/// @notice Distributes native ETH against a merkle root.
/// @dev Built to run behind a proxy whose storage is already in use: config lives in
///      immutables, state in one ERC-7201 slot. See docs/architecture.md.
contract MerkleDistributorETH {
    /// @custom:storage-location erc7201:superseed.merkledistributor.eth.v1
    struct DistributorStorage {
        mapping(uint256 => uint256) claimedBitMap;
    }

    /// @notice Which claim-bitmap generation this implementation reads and writes.
    uint256 public constant STORAGE_VERSION = 1;

    // keccak256(abi.encode(uint256(keccak256("superseed.merkledistributor.eth.v1")) - 1)) & ~bytes32(uint256(0xff))
    // Rotating a root means bumping the namespace, STORAGE_VERSION and this literal together;
    // the storage-layout test fails if they disagree. See docs/architecture.md.
    bytes32 private constant STORAGE_SLOT = 0xf1244374a681ce036c09aa3a94dc201275b109e965cdf26ca3c475a86f309d00;

    bytes32 public immutable merkleRoot;
    uint256 public immutable endTime;
    address public immutable owner;

    event Claimed(uint256 index, address account, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    constructor(bytes32 merkleRoot_, uint256 endTime_, address owner_) {
        if (endTime_ <= block.timestamp) revert EndTimeInPast();
        if (owner_ == address(0)) revert ZeroOwner();
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
    /// @dev Strictly `>` endTime, mirroring `claim`'s `<=`. If this used `>=`, both functions
    ///      would be callable in the block at exactly `endTime`, letting the owner front-run a
    ///      final claim. The two windows must not overlap by even one block.
    function withdraw() external {
        if (msg.sender != owner) revert NotOwner();
        if (block.timestamp <= endTime) revert NoWithdrawDuringClaim();
        uint256 amount = address(this).balance;
        (bool ok, ) = owner.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(owner, amount);
    }

    /// @dev The OP-Stack proxy delegates plain transfers, so without this every ETH send
    ///      to the proxy address would revert.
    receive() external payable {}
}
