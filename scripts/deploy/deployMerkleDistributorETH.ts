import { ethers, network, run } from 'hardhat'
import fs from 'fs'

/**
 * Deploys the MerkleDistributorETH implementation.
 *
 *   MERKLE_RESULT=./result.json \
 *   DISTRIBUTOR_OWNER=0x… \
 *   CLAIM_WINDOW_SECONDS=31536000 \
 *   npx hardhat run scripts/deploy/deployMerkleDistributorETH.ts --network mainnet
 *
 * This only deploys the implementation. Installing it behind a proxy is a separate,
 * multisig-gated step — see proposeUpgrade.ts.
 */
async function main() {
  const resultPath = process.env.MERKLE_RESULT
  const owner = process.env.DISTRIBUTOR_OWNER
  const windowSeconds = Number(process.env.CLAIM_WINDOW_SECONDS ?? 31536000)

  if (!resultPath) throw new Error('MERKLE_RESULT is required')
  if (!owner) throw new Error('DISTRIBUTOR_OWNER is required')
  if (!ethers.isAddress(owner)) throw new Error(`DISTRIBUTOR_OWNER is not an address: ${owner}`)
  // The constructor reverts with ZeroOwner, but catching it here costs nothing,
  // whereas discovering it on-chain burns real mainnet gas on a doomed deploy.
  if (ethers.getAddress(owner) === ethers.ZeroAddress) throw new Error('DISTRIBUTOR_OWNER must not be the zero address')
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) throw new Error('CLAIM_WINDOW_SECONDS must be positive')

  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  const merkleRoot: string = result.merkleRoot
  if (!/^0x[0-9a-f]{64}$/i.test(merkleRoot)) throw new Error(`bad merkleRoot in ${resultPath}`)
  if (!result.claims || typeof result.claims !== 'object') {
    throw new Error(`${resultPath} has no claims object — is this a generate-merkle-root output?`)
  }
  if (typeof result.tokenTotal !== 'string' || !/^[0-9]+$/.test(result.tokenTotal)) {
    throw new Error(`${resultPath} has no valid decimal tokenTotal`)
  }
  if (Object.keys(result.claims).length === 0) throw new Error(`${resultPath} contains zero claims`)

  const latest = await ethers.provider.getBlock('latest')
  const endTime = latest!.timestamp + windowSeconds

  const [deployer] = await ethers.getSigners()
  console.log(`network     : ${network.name} (chainId ${(await ethers.provider.getNetwork()).chainId})`)
  console.log(`deployer    : ${deployer.address}`)
  console.log(`merkleRoot  : ${merkleRoot}`)
  console.log(`tokenTotal  : ${result.tokenTotal} wei`)
  console.log(`recipients  : ${Object.keys(result.claims).length}`)
  console.log(`endTime     : ${endTime} (${new Date(endTime * 1000).toISOString()})`)
  console.log(`owner       : ${owner}`)

  const factory = await ethers.getContractFactory('MerkleDistributorETH')
  const distributor = await factory.deploy(merkleRoot, endTime, owner)
  await distributor.waitForDeployment()
  const address = await distributor.getAddress()

  console.log(`\nimplementation deployed: ${address}`)
  console.log(`\nverify with:\n  npx hardhat verify --network ${network.name} ${address} ${merkleRoot} ${endTime} ${owner}`)
  console.log(`\nnext: build the upgrade transaction\n  IMPLEMENTATION=${address} npx ts-node scripts/deploy/proposeUpgrade.ts`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
