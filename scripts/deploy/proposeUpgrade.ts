import 'dotenv/config'
import fs from 'fs'
import { Interface, getAddress, isAddress, ZeroAddress } from 'ethers'
import { env } from '../env'

/**
 * Emits a Safe Transaction Builder JSON for installing an implementation behind an
 * OP-Stack proxy via its ProxyAdmin. Nothing is broadcast; a multisig executes it.
 *
 *   PROXY=0x… PROXY_ADMIN=0x… IMPLEMENTATION=0x… CHAIN_ID=1 \
 *   npx ts-node scripts/deploy/proposeUpgrade.ts -o upgrade.json
 */
const PROXY_ADMIN_ABI = ['function upgrade(address _proxy, address _implementation) external']

const ARTIFACT_PATH = 'dist/deployment.json'

type DeploymentArtifact = { implementation?: unknown; chainId?: unknown; network?: unknown }

/**
 * IMPLEMENTATION defaults to whatever `yarn deploy:mainnet` recorded, so the operator
 * never retypes a 42-character address between two commands. Set the env var to
 * override (e.g. proposing an upgrade to a contract deployed earlier).
 */
function readArtifact(): DeploymentArtifact | undefined {
  if (!fs.existsSync(ARTIFACT_PATH)) return undefined
  try {
    return JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8')) as DeploymentArtifact
  } catch {
    return undefined
  }
}

function requireAddress(name: string, fallback?: string): string {
  const value = env(name) ?? fallback
  if (!value) throw new Error(`${name} is required`)
  if (!isAddress(value)) throw new Error(`${name} is not an address: ${value}`)
  const parsed = getAddress(value)
  // A well-formed batch built from a zero address is the dangerous case: it looks
  // completely normal and four people sign it. Refuse rather than emit it.
  if (parsed === ZeroAddress) throw new Error(`${name} must not be the zero address`)
  return parsed
}

const artifact = readArtifact()
const artifactImplementation = typeof artifact?.implementation === 'string' ? artifact.implementation : undefined

const proxy = requireAddress('PROXY')
const proxyAdmin = requireAddress('PROXY_ADMIN')
const implementation = requireAddress('IMPLEMENTATION', artifactImplementation)

const chainId = env('CHAIN_ID') ?? '1'
// chainId goes into the batch verbatim and is what a signer reads to confirm which
// network they are authorising. Garbage here produces a misleading file rather than
// an error, so reject anything that is not a positive integer.
if (!/^[0-9]+$/.test(chainId) || Number(chainId) <= 0 || !Number.isSafeInteger(Number(chainId))) {
  throw new Error(`CHAIN_ID must be a positive integer; got: ${chainId}`)
}

/** Accepts the number our deploy script writes, and a numeric string from a hand-edited artifact. */
function parseChainId(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : undefined
  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
  }
  return undefined
}

// The artifact records which chain its implementation was actually deployed to. A
// local `--network hardhat` run leaves chainId 31337 behind, and the fallback above
// would then feed that address into a batch stamped chainId 1: a well-formed,
// signable transaction pointing the ProxyAdmin at an address holding no code on
// mainnet. Only enforced when the address came from the artifact; setting
// IMPLEMENTATION explicitly is the operator taking responsibility for the pairing.
if (!env('IMPLEMENTATION') && artifact) {
  const recorded = parseChainId(artifact.chainId)
  const where = typeof artifact.network === 'string' ? ` (network "${artifact.network}")` : ''
  if (artifact.chainId === undefined || artifact.chainId === null) {
    console.warn(
      `warning: ${ARTIFACT_PATH} records no chainId; cannot confirm ${implementation} was deployed to chain ${chainId}`
    )
  } else if (recorded === undefined) {
    // Present but unreadable. Refusing beats warning: the guard cannot do its job, and
    // a malformed artifact is itself reason to stop before a multisig signs anything.
    throw new Error(
      `${ARTIFACT_PATH} records an unreadable chainId (${JSON.stringify(artifact.chainId)})${where}; ` +
        `fix the artifact, or set IMPLEMENTATION explicitly to bypass this check.`
    )
  } else if (recorded !== Number(chainId)) {
    throw new Error(
      `${ARTIFACT_PATH} records an implementation deployed to chainId ${recorded}${where}, ` +
        `but this batch targets chainId ${chainId}. Re-run \`yarn deploy:mainnet\` to deploy to the ` +
        `target chain, or set IMPLEMENTATION explicitly to an address deployed there.`
    )
  }
}

if (proxy === implementation) {
  throw new Error('PROXY and IMPLEMENTATION are the same address; a proxy cannot be its own implementation')
}
if (proxy === proxyAdmin) {
  throw new Error('PROXY and PROXY_ADMIN are the same address; check which is which')
}
if (implementation === proxyAdmin) {
  throw new Error('IMPLEMENTATION and PROXY_ADMIN are the same address; check which is which')
}

// This script emits the payload a multisig signs to move ~85 ETH, so a mistyped
// invocation must fail loudly rather than with a low-signal Node type error.
const outIndex = process.argv.indexOf('-o')
let outPath = 'dist/upgrade.json'
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
console.log(`  - the implementation is verified on Etherscan and its merkleRoot matches the published distribution`)
