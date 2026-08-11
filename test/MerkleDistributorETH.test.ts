import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { Contract } from 'ethers'
import { ethers } from 'hardhat'
import BalanceTree from '../src/balance-tree'

const ONE_YEAR = 31536000
const ZERO_BYTES32 = '0x' + '00'.repeat(32)

describe('MerkleDistributorETH', () => {
  async function twoAccountFixture() {
    const [deployer, owner, alice, bob, carol] = await ethers.getSigners()

    const tree = new BalanceTree([
      { account: alice.address, amount: 100n },
      { account: bob.address, amount: 101n },
    ])

    const endTime = (await ethers.provider.getBlock('latest'))!.timestamp + ONE_YEAR
    const factory = await ethers.getContractFactory('MerkleDistributorETH')
    const distributor = await factory.deploy(tree.getHexRoot(), endTime, owner.address)
    await distributor.waitForDeployment()

    // Fund it exactly like the proxy would be funded.
    await deployer.sendTransaction({ to: await distributor.getAddress(), value: 1000n })

    return { distributor, tree, endTime, owner, alice, bob, carol }
  }

  it('rejects deployment with a zero owner', async () => {
    const factory = await ethers.getContractFactory('MerkleDistributorETH')
    const endTime = (await ethers.provider.getBlock('latest'))!.timestamp + ONE_YEAR
    await expect(factory.deploy(ZERO_BYTES32, endTime, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      factory,
      'ZeroOwner'
    )
  })

  describe('storage layout', () => {
    it('places the claimed bitmap at the ERC-7201 namespaced slot', async () => {
      const { distributor, tree, alice } = await loadFixture(twoAccountFixture)
      const proof = tree.getProof(0, alice.address, 100n)

      // Derive the namespace from the contract's own STORAGE_VERSION rather than a
      // hardcoded string, so bumping the version without bumping the namespace (or the
      // slot literal) fails here instead of silently pointing the bitmap elsewhere.
      const storageVersion = await distributor.STORAGE_VERSION()
      const namespace = `superseed.merkledistributor.eth.v${storageVersion}`
      const expectedSlot = (() => {
        const inner = BigInt(ethers.keccak256(ethers.toUtf8Bytes(namespace))) - 1n
        return BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [inner]))) & ~0xffn
      })()

      const addr = await distributor.getAddress()
      // Word 0 of the bitmap lives at keccak256(abi.encode(0, slot)).
      const bitmapWordSlot = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [0, expectedSlot])
      )

      expect(await ethers.provider.getStorage(addr, 0)).to.equal(ZERO_BYTES32)
      await distributor.claim(0, alice.address, 100n, proof)
      // Slot 0 must remain untouched; the bit must land in the namespaced word.
      expect(await ethers.provider.getStorage(addr, 0)).to.equal(ZERO_BYTES32)
      expect(BigInt(await ethers.provider.getStorage(addr, bitmapWordSlot))).to.equal(1n)
    })
  })

  describe('claim', () => {
    it('pays the account and marks the index claimed', async () => {
      const { distributor, tree, alice } = await loadFixture(twoAccountFixture)
      const proof = tree.getProof(0, alice.address, 100n)

      expect(await distributor.isClaimed(0)).to.equal(false)
      await expect(distributor.claim(0, alice.address, 100n, proof)).to.changeEtherBalances(
        [await distributor.getAddress(), alice.address],
        [-100n, 100n]
      )
      expect(await distributor.isClaimed(0)).to.equal(true)
    })

    it('emits Claimed', async () => {
      const { distributor, tree, bob } = await loadFixture(twoAccountFixture)
      const proof = tree.getProof(1, bob.address, 101n)
      await expect(distributor.claim(1, bob.address, 101n, proof))
        .to.emit(distributor, 'Claimed')
        .withArgs(1, bob.address, 101n)
    })

    it('lets a third party submit a claim, paying the account not the caller', async () => {
      const { distributor, tree, alice, carol } = await loadFixture(twoAccountFixture)
      const proof = tree.getProof(0, alice.address, 100n)
      await expect(
        (distributor.connect(carol) as unknown as Contract).claim(0, alice.address, 100n, proof)
      ).to.changeEtherBalance(alice.address, 100n)
    })

    it('reverts on a second claim of the same index', async () => {
      const { distributor, tree, alice } = await loadFixture(twoAccountFixture)
      const proof = tree.getProof(0, alice.address, 100n)
      await distributor.claim(0, alice.address, 100n, proof)
      await expect(distributor.claim(0, alice.address, 100n, proof)).to.be.revertedWithCustomError(
        distributor,
        'AlreadyClaimed'
      )
    })

    it('reverts on a wrong amount', async () => {
      const { distributor, tree, alice } = await loadFixture(twoAccountFixture)
      const proof = tree.getProof(0, alice.address, 100n)
      await expect(distributor.claim(0, alice.address, 101n, proof)).to.be.revertedWithCustomError(
        distributor,
        'InvalidProof'
      )
    })

    it('reverts for an address not in the tree', async () => {
      const { distributor, tree, alice, carol } = await loadFixture(twoAccountFixture)
      const proof = tree.getProof(0, alice.address, 100n)
      await expect(distributor.claim(0, carol.address, 100n, proof)).to.be.revertedWithCustomError(
        distributor,
        'InvalidProof'
      )
    })

    it('reverts with TransferFailed for a recipient that cannot receive ETH, leaving the bit unset', async () => {
      const [deployer, owner] = await ethers.getSigners()
      const rejector = await (await ethers.getContractFactory('RejectsETH')).deploy()
      await rejector.waitForDeployment()
      const rejectorAddress = await rejector.getAddress()

      const tree = new BalanceTree([{ account: rejectorAddress, amount: 100n }])
      const endTime = (await ethers.provider.getBlock('latest'))!.timestamp + ONE_YEAR
      const distributor = await (
        await ethers.getContractFactory('MerkleDistributorETH')
      ).deploy(tree.getHexRoot(), endTime, owner.address)
      await distributor.waitForDeployment()
      await deployer.sendTransaction({ to: await distributor.getAddress(), value: 1000n })

      const proof = tree.getProof(0, rejectorAddress, 100n)
      await expect(distributor.claim(0, rejectorAddress, 100n, proof)).to.be.revertedWithCustomError(
        distributor,
        'TransferFailed'
      )
      expect(await distributor.isClaimed(0)).to.equal(false)
    })
  })

  describe('receive', () => {
    it('accepts a plain ETH transfer', async () => {
      const { distributor } = await loadFixture(twoAccountFixture)
      const [deployer] = await ethers.getSigners()
      await expect(deployer.sendTransaction({ to: await distributor.getAddress(), value: 5n })).to.changeEtherBalance(
        await distributor.getAddress(),
        5n
      )
    })
  })

  describe('deadline and withdraw', () => {
    it('reverts deployment when endTime is in the past', async () => {
      const [, owner] = await ethers.getSigners()
      const factory = await ethers.getContractFactory('MerkleDistributorETH')
      const past = (await ethers.provider.getBlock('latest'))!.timestamp - 1
      await expect(factory.deploy(ZERO_BYTES32, past, owner.address)).to.be.revertedWithCustomError(
        factory,
        'EndTimeInPast'
      )
    })

    it('rejects a claim after endTime', async () => {
      const { distributor, tree, endTime, alice } = await loadFixture(twoAccountFixture)
      const proof = tree.getProof(0, alice.address, 100n)
      await time.increaseTo(endTime + 1)
      await expect(distributor.claim(0, alice.address, 100n, proof)).to.be.revertedWithCustomError(
        distributor,
        'ClaimWindowFinished'
      )
    })

    it('accepts a claim in the final second of the window', async () => {
      const { distributor, tree, endTime, alice } = await loadFixture(twoAccountFixture)
      const proof = tree.getProof(0, alice.address, 100n)
      await time.setNextBlockTimestamp(endTime)
      await expect(distributor.claim(0, alice.address, 100n, proof)).to.changeEtherBalance(alice.address, 100n)
    })

    it('rejects withdraw from a non-owner even after endTime', async () => {
      const { distributor, endTime, carol } = await loadFixture(twoAccountFixture)
      await time.increaseTo(endTime + 1)
      await expect((distributor.connect(carol) as unknown as Contract).withdraw()).to.be.revertedWithCustomError(
        distributor,
        'NotOwner'
      )
    })

    it('rejects withdraw from the owner before endTime', async () => {
      const { distributor, owner } = await loadFixture(twoAccountFixture)
      await expect((distributor.connect(owner) as unknown as Contract).withdraw()).to.be.revertedWithCustomError(
        distributor,
        'NoWithdrawDuringClaim'
      )
    })

    it('rejects withdraw in the block at exactly endTime, so it cannot overlap a final claim', async () => {
      const { distributor, owner, endTime } = await loadFixture(twoAccountFixture)
      await time.setNextBlockTimestamp(endTime)
      await expect((distributor.connect(owner) as unknown as Contract).withdraw()).to.be.revertedWithCustomError(
        distributor,
        'NoWithdrawDuringClaim'
      )
    })

    it('allows withdraw one second after endTime', async () => {
      const { distributor, owner, endTime } = await loadFixture(twoAccountFixture)
      await time.setNextBlockTimestamp(endTime + 1)
      await expect((distributor.connect(owner) as unknown as Contract).withdraw()).to.changeEtherBalance(
        owner.address,
        1000n
      )
    })

    it('sweeps the full remaining balance to the owner after endTime', async () => {
      const { distributor, tree, endTime, owner, alice } = await loadFixture(twoAccountFixture)
      await distributor.claim(0, alice.address, 100n, tree.getProof(0, alice.address, 100n))
      await time.increaseTo(endTime + 1)
      await expect((distributor.connect(owner) as unknown as Contract).withdraw()).to.changeEtherBalances(
        [await distributor.getAddress(), owner.address],
        [-900n, 900n]
      )
    })

    it('emits Withdrawn with the swept amount', async () => {
      const { distributor, tree, endTime, owner, alice } = await loadFixture(twoAccountFixture)
      await distributor.claim(0, alice.address, 100n, tree.getProof(0, alice.address, 100n))
      await time.increaseTo(endTime + 1)
      // 1000 funded - 100 claimed = 900 remaining.
      await expect((distributor.connect(owner) as unknown as Contract).withdraw())
        .to.emit(distributor, 'Withdrawn')
        .withArgs(owner.address, 900n)
    })

    it('reports the configured immutables', async () => {
      const { distributor, tree, endTime, owner } = await loadFixture(twoAccountFixture)
      expect(await distributor.merkleRoot()).to.equal(tree.getHexRoot())
      expect(await distributor.endTime()).to.equal(BigInt(endTime))
      expect(await distributor.owner()).to.equal(owner.address)
      expect(await distributor.version()).to.equal('1.0.0')
    })
  })
})
