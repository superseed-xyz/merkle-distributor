import fs from 'fs'
import { Interface, getAddress, isAddress } from 'ethers'

/**
 * Emits a Safe Transaction Builder JSON for installing an implementation behind an
 * OP-Stack proxy via its ProxyAdmin. Nothing is broadcast — a multisig executes it.
 *
 *   PROXY=0x… PROXY_ADMIN=0x… IMPLEMENTATION=0x… CHAIN_ID=1 \
 *   npx ts-node scripts/deploy/proposeUpgrade.ts -o upgrade.json
 */
const PROXY_ADMIN_ABI = ['function upgrade(address _proxy, address _implementation) external']

function requireAddress(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  if (!isAddress(value)) throw new Error(`${name} is not an address: ${value}`)
  return getAddress(value)
}

const proxy = requireAddress('PROXY')
const proxyAdmin = requireAddress('PROXY_ADMIN')
const implementation = requireAddress('IMPLEMENTATION')
const chainId = process.env.CHAIN_ID ?? '1'

const outIndex = process.argv.indexOf('-o')
const outPath = outIndex === -1 ? 'upgrade.json' : process.argv[outIndex + 1]

const iface = new Interface(PROXY_ADMIN_ABI)
const data = iface.encodeFunctionData('upgrade', [proxy, implementation])

const batch = {
  version: '1.0',
  chainId,
  createdAt: 0,
  meta: {
    name: 'Install MerkleDistributorETH implementation',
    description: `ProxyAdmin ${proxyAdmin}.upgrade(${proxy}, ${implementation})`,
    txBuilderVersion: '1.16.5',
  },
  transactions: [
    {
      to: proxyAdmin,
      value: '0',
      data,
      contractMethod: {
        inputs: [
          { internalType: 'address', name: '_proxy', type: 'address' },
          { internalType: 'address', name: '_implementation', type: 'address' },
        ],
        name: 'upgrade',
        payable: false,
      },
      contractInputsValues: { _proxy: proxy, _implementation: implementation },
    },
  ],
}

fs.writeFileSync(outPath, JSON.stringify(batch, null, 2) + '\n')

console.log(`wrote          : ${outPath}`)
console.log(`chainId        : ${chainId}`)
console.log(`to             : ${proxyAdmin}`)
console.log(`calldata       : ${data}`)
console.log(`\nSigners must confirm before signing:`)
console.log(`  - "to" is the ProxyAdmin, not the proxy`)
console.log(`  - _proxy         == ${proxy}`)
console.log(`  - _implementation == ${implementation}`)
console.log(`  - the implementation is verified on Etherscan and its merkleRoot matches the published result`)
