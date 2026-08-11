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
/// @dev Designed to be installed as the implementation behind an existing upgradeable
///      proxy that already holds ETH and already has unrelated data in slots 0..n.
///      Configuration is held in immutables (which live in code, not storage, and so
///      survive delegatecall), and the only storage this contract touches is a single
///      ERC-7201 namespaced struct. Nothing here reads or writes the proxy's legacy slots.
contract MerkleDistributorETH {
    /// @custom:storage-location erc7201:0xnikolas.merkledistributor.eth
    struct DistributorStorage {
        mapping(uint256 => uint256) claimedBitMap;
    }

    // keccak256(abi.encode(uint256(keccak256("0xnikolas.merkledistributor.eth")) - 1)) & ~bytes32(uint256(0xff))
    //
    // Forks SHOULD change this namespace to their own, and MUST recompute the constant to match:
    //   node -e "const {keccak256,toUtf8Bytes,AbiCoder,toBeHex}=require('ethers');
    //     const i=BigInt(keccak256(toUtf8Bytes('<your.namespace>')))-1n;
    //     console.log(toBeHex(BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(['uint256'],[i])))&~0xffn,32))"
    // The storage-layout test asserts the literal below matches the namespace above, so a
    // namespace change without a recomputed constant fails the suite rather than silently
    // pointing the claim bitmap at someone else's slot.
    bytes32 private constant STORAGE_SLOT = 0xf22f1ade672922e65654a2754b03b255798248be9f1c474371dd8a173dea3e00;

    bytes32 public immutable merkleRoot;
    uint256 public immutable endTime;
    address public immutable owner;

    event Claimed(uint256 index, address account, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    constructor(bytes32 merkleRoot_, uint256 endTime_, address owner_) {
        if (endTime_ <= block.timestamp) revert EndTimeInPast();
        // Without this, withdraw() is permanently uncallable and the residual balance
        // — potentially tens of ETH of unclaimed funds — is unrecoverable forever.
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
