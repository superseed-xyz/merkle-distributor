import { impersonateAccount, setBalance, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'
import BalanceTree from '../../src/balance-tree'

// EIP-1967 implementation slot.
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const PROXY_ADMIN_ABI = ['function upgrade(address _proxy, address _implementation) external']
const ONE_YEAR = 31536000

const PROXY = process.env.FORK_PROXY
const PROXY_ADMIN = process.env.FORK_PROXY_ADMIN
const ADMIN_OWNER = process.env.FORK_ADMIN_OWNER
const configured = Boolean(PROXY && PROXY_ADMIN && ADMIN_OWNER && process.env.MAINNET_RPC_URL)

;(configured ? describe : describe.skip)('proxy upgrade rehearsal (fork)', () => {
  it('replaces the implementation, preserves the balance, and pays a claim from it', async () => {
    // Prove we really are on a fork: the proxy must already have code and an admin set.
    expect(await ethers.provider.getCode(PROXY!), 'no code at FORK_PROXY — is forking on?').to.not.equal('0x')

    const [deployer, alice, bob] = await ethers.getSigners()

    const balanceBefore = await ethers.provider.getBalance(PROXY!)
    expect(balanceBefore, 'the forked proxy holds no ETH; check FORK_BLOCK_NUMBER').to.be.greaterThan(0n)

    // Legacy portal storage, captured before the upgrade so we can prove the claim
    // later doesn't disturb it. Slots 0..8 are all still whatever they were before.
    const legacySlots: string[] = []
    for (let i = 0; i < 9; i++) {
      legacySlots.push(await ethers.provider.getStorage(PROXY!, i))
    }

    // A synthetic tree, so this test never depends on a specific snapshot dataset.
    const aliceAmount = 10n ** 15n
    const bobAmount = 2n * 10n ** 15n
    const tree = new BalanceTree([
      { account: alice.address, amount: aliceAmount },
      { account: bob.address, amount: bobAmount },
    ])
    expect(balanceBefore, 'proxy balance too small for the test tree').to.be.greaterThan(aliceAmount + bobAmount)

    const endTime = (await ethers.provider.getBlock('latest'))!.timestamp + ONE_YEAR
    const impl = await (
      await ethers.getContractFactory('MerkleDistributorETH')
    ).deploy(tree.getHexRoot(), endTime, deployer.address)
    await impl.waitForDeployment()
    const implAddress = await impl.getAddress()

    // Execute the real upgrade, through the real ProxyAdmin, as its real owner.
    await impersonateAccount(ADMIN_OWNER!)
    await setBalance(ADMIN_OWNER!, 10n ** 18n)
    const adminOwner = await ethers.getSigner(ADMIN_OWNER!)
    const proxyAdmin = new ethers.Contract(PROXY_ADMIN!, PROXY_ADMIN_ABI, adminOwner)
    await proxyAdmin.upgrade(PROXY!, implAddress)

    // The EIP-1967 slot now points at our implementation.
    const slotValue = await ethers.provider.getStorage(PROXY!, IMPL_SLOT)
    expect('0x' + slotValue.slice(26)).to.equal(implAddress.toLowerCase())

    // The ETH never moved.
    expect(await ethers.provider.getBalance(PROXY!)).to.equal(balanceBefore)

    const distributor = await ethers.getContractAt('MerkleDistributorETH', PROXY!)
    expect(await distributor.version()).to.equal('1.0.0')
    expect(await distributor.merkleRoot()).to.equal(tree.getHexRoot())

    // A real claim, paid out of the proxy's pre-existing balance.
    await expect(
      distributor.claim(0, alice.address, aliceAmount, tree.getProof(0, alice.address, aliceAmount))
    ).to.changeEtherBalances([PROXY!, alice.address], [-aliceAmount, aliceAmount])

    await expect(
      distributor.claim(0, alice.address, aliceAmount, tree.getProof(0, alice.address, aliceAmount))
    ).to.be.revertedWithCustomError(distributor, 'AlreadyClaimed')

    // A plain transfer still works, proving the proxy's delegating receive() is satisfied.
    await expect(deployer.sendTransaction({ to: PROXY!, value: 1n })).to.changeEtherBalance(PROXY!, 1n)

    // Legacy portal storage is untouched by the claim: slots 0..8 are all still whatever
    // they were before the upgrade.
    for (let i = 0; i < 9; i++) {
      const now = await ethers.provider.getStorage(PROXY!, i)
      expect(now, `slot ${i} changed`).to.equal(legacySlots[i])
    }

    // Sweep after the deadline returns the surplus.
    await time.increaseTo(endTime + 1)
    const remaining = await ethers.provider.getBalance(PROXY!)
    await expect(distributor.connect(deployer).withdraw()).to.changeEtherBalances(
      [PROXY!, deployer.address],
      [-remaining, remaining]
    )
  })
})
