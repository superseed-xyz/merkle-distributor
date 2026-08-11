import { ethers, network, run } from 'hardhat'
import fs from 'fs'

/**
 * Deploys the MerkleDistributorETH implementation.
 *
 *   yarn deploy:mainnet
 *
 * Reads dist/distribution.json (whatever `yarn distribution` produced) and the
 * addresses from .env. Writes dist/deployment.json so the upgrade step can pick the
 * implementation address up on its own instead of the operator copying it by hand.
 *
 * This only deploys the implementation. Installing it behind a proxy is a separate,
 * multisig-gated step. See proposeUpgrade.ts.
 */
async function main() {
  // Defaults to the pipeline's output, so the common path needs no env var at all.
  const distributionPath = process.env.DISTRIBUTION_FILE ?? 'dist/distribution.json'
  const owner = process.env.DISTRIBUTOR_OWNER
  const windowSeconds = Number(process.env.CLAIM_WINDOW_SECONDS ?? 31536000)
  const proxy = process.env.PROXY
  const proxyAdmin = process.env.PROXY_ADMIN
  // The proxy is the address that pays claims, so it is the funding address too.
  const fundingAddress = process.env.FUNDING_ADDRESS ?? proxy

  if (!fs.existsSync(distributionPath)) {
    throw new Error(
      `${distributionPath} not found. Run \`yarn distribution <snapshot>\` first, ` +
        `or set DISTRIBUTION_FILE to point at an existing distribution file.`
    )
  }
  if (!owner) throw new Error('DISTRIBUTOR_OWNER is required')
  if (!ethers.isAddress(owner)) throw new Error(`DISTRIBUTOR_OWNER is not an address: ${owner}`)
  // The constructor reverts with ZeroOwner, but catching it here costs nothing,
  // whereas discovering it on-chain burns real mainnet gas on a doomed deploy.
  const ownerChecksummed = ethers.getAddress(owner)
  if (ownerChecksummed === ethers.ZeroAddress) throw new Error('DISTRIBUTOR_OWNER must not be the zero address')
  // If the owner were set to the ProxyAdmin or the proxy itself, withdraw() would be
  // permanently uncallable: neither of those addresses can act as a normal EOA/Safe
  // signer against this contract's owner-only sweep.
  if (proxyAdmin && ethers.isAddress(proxyAdmin) && ownerChecksummed === ethers.getAddress(proxyAdmin)) {
    throw new Error('DISTRIBUTOR_OWNER must not equal PROXY_ADMIN; withdraw() would be permanently uncallable')
  }
  if (proxy && ethers.isAddress(proxy) && ownerChecksummed === ethers.getAddress(proxy)) {
    throw new Error('DISTRIBUTOR_OWNER must not equal PROXY; withdraw() would be permanently uncallable')
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) throw new Error('CLAIM_WINDOW_SECONDS must be positive')

  const distribution = JSON.parse(fs.readFileSync(distributionPath, 'utf8'))
  const merkleRoot: string = distribution.merkleRoot
  if (!/^0x[0-9a-f]{64}$/i.test(merkleRoot)) throw new Error(`bad merkleRoot in ${distributionPath}`)
  if (!distribution.claims || typeof distribution.claims !== 'object') {
    throw new Error(`${distributionPath} has no claims object; is this a generate-merkle-root output?`)
  }
  if (typeof distribution.tokenTotal !== 'string' || !/^[0-9]+$/.test(distribution.tokenTotal)) {
    throw new Error(`${distributionPath} has no valid decimal tokenTotal`)
  }
  if (Object.keys(distribution.claims).length === 0) throw new Error(`${distributionPath} contains zero claims`)

  const latest = await ethers.provider.getBlock('latest')
  const endTime = latest!.timestamp + windowSeconds

  const [deployer] = await ethers.getSigners()
  console.log(`network     : ${network.name} (chainId ${(await ethers.provider.getNetwork()).chainId})`)
  console.log(`deployer    : ${deployer.address}`)
  console.log(`merkleRoot  : ${merkleRoot}`)
  console.log(`tokenTotal  : ${distribution.tokenTotal} wei`)
  console.log(`recipients  : ${Object.keys(distribution.claims).length}`)
  console.log(`endTime     : ${endTime} (${new Date(endTime * 1000).toISOString()})`)
  console.log(`owner       : ${owner}`)

  // Last cheap point to catch an underfunded proxy before spending mainnet gas on a
  // deploy that would be followed by claims nobody can fully honour.
  if (fundingAddress) {
    if (!ethers.isAddress(fundingAddress)) throw new Error(`FUNDING_ADDRESS is not an address: ${fundingAddress}`)
    const balance = await ethers.provider.getBalance(fundingAddress)
    const tokenTotal = BigInt(distribution.tokenTotal)
    if (balance < tokenTotal) {
      throw new Error(`FUNDING_ADDRESS ${fundingAddress} holds ${balance} wei, less than tokenTotal ${tokenTotal} wei`)
    }
    console.log(`funding     : ${fundingAddress} holds ${balance} wei, covers tokenTotal (PASS)`)
  } else {
    console.log('funding     : FUNDING_ADDRESS not set, funding balance check SKIPPED')
  }

  const factory = await ethers.getContractFactory('MerkleDistributorETH')
  const distributor = await factory.deploy(merkleRoot, endTime, owner)
  await distributor.waitForDeployment()
  const address = await distributor.getAddress()

  // Recorded so proposeUpgrade can read the address itself. Copying a 42-character
  // address between two commands by hand is exactly how the wrong contract gets
  // installed behind a proxy holding real money.
  const artifact = {
    implementation: address,
    merkleRoot,
    tokenTotal: distribution.tokenTotal,
    recipients: Object.keys(distribution.claims).length,
    endTime,
    owner: ownerChecksummed,
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deploymentTx: distributor.deploymentTransaction()?.hash ?? null,
  }
  fs.mkdirSync('dist', { recursive: true })
  fs.writeFileSync('dist/deployment.json', JSON.stringify(artifact, null, 2) + '\n')

  console.log(`\nimplementation : ${address}`)
  console.log(`wrote          : dist/deployment.json`)
  console.log(
    `\nverify:\n  npx hardhat verify --network ${network.name} ${address} ${merkleRoot} ${endTime} ${ownerChecksummed}`
  )
  console.log(`\nnext:\n  yarn propose-upgrade`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
