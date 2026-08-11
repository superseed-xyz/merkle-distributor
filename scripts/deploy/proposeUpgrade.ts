import fs from 'fs'
import { Interface, getAddress, isAddress, ZeroAddress } from 'ethers'

/**
 * Emits a Safe Transaction Builder JSON for installing an implementation behind an
 * OP-Stack proxy via its ProxyAdmin. Nothing is broadcast; a multisig executes it.
 *
 *   PROXY=0x… PROXY_ADMIN=0x… IMPLEMENTATION=0x… CHAIN_ID=1 \
 *   npx ts-node scripts/deploy/proposeUpgrade.ts -o upgrade.json
 */
const PROXY_ADMIN_ABI = ['function upgrade(address _proxy, address _implementation) external']

function requireAddress(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  if (!isAddress(value)) throw new Error(`${name} is not an address: ${value}`)
  const parsed = getAddress(value)
  // A well-formed batch built from a zero address is the dangerous case: it looks
  // completely normal and four people sign it. Refuse rather than emit it.
  if (parsed === ZeroAddress) throw new Error(`${name} must not be the zero address`)
  return parsed
}

const proxy = requireAddress('PROXY')
const proxyAdmin = requireAddress('PROXY_ADMIN')
const implementation = requireAddress('IMPLEMENTATION')

if (proxy === implementation) {
  throw new Error('PROXY and IMPLEMENTATION are the same address; a proxy cannot be its own implementation')
}
if (proxy === proxyAdmin) {
  throw new Error('PROXY and PROXY_ADMIN are the same address; check which is which')
}
if (implementation === proxyAdmin) {
  throw new Error('IMPLEMENTATION and PROXY_ADMIN are the same address; check which is which')
}

const chainId = process.env.CHAIN_ID ?? '1'

// This script emits the payload a multisig signs to move ~85 ETH, so a mistyped
// invocation must fail loudly rather than with a low-signal Node type error.
const outIndex = process.argv.indexOf('-o')
let outPath = 'upgrade.json'
if (outIndex !== -1) {
  const candidate = process.argv[outIndex + 1]
  if (!candidate || candidate.startsWith('-')) {
    throw new Error('-o requires a file path, e.g. -o upgrade.json')
  }
  outPath = candidate
}

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
