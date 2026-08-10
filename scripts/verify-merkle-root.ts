import { program } from 'commander'
import fs from 'fs'
import { solidityPackedKeccak256, keccak256 } from 'ethers'

program.version('1.0.0').requiredOption('-i, --input <path>', 'the generate-merkle-root output to verify')

program.parse(process.argv)

const json = JSON.parse(fs.readFileSync(program.opts().input, { encoding: 'utf8' }))
if (typeof json !== 'object') throw new Error('Invalid JSON')

const combinedHash = (first: Buffer | null, second: Buffer | null): Buffer => {
  if (!first) return second as Buffer
  if (!second) return first as Buffer
  return Buffer.from(keccak256(Buffer.concat([first, second].sort(Buffer.compare))).slice(2), 'hex')
}

const toNode = (index: number, account: string, amount: bigint): Buffer =>
  Buffer.from(solidityPackedKeccak256(['uint256', 'address', 'uint256'], [index, account, amount]).slice(2), 'hex')

const verifyProof = (index: number, account: string, amount: bigint, proof: Buffer[], root: Buffer): boolean => {
  let pair = toNode(index, account, amount)
  for (const item of proof) pair = combinedHash(pair, item)
  return pair.equals(root)
}

const getNextLayer = (elements: Buffer[]): Buffer[] =>
  elements.reduce<Buffer[]>((layer, el, idx, arr) => {
    if (idx % 2 === 0) layer.push(combinedHash(el, arr[idx + 1]))
    return layer
  }, [])

const getRoot = (balances: { account: string; amount: bigint; index: number }[]): Buffer => {
  let nodes = balances.map(({ account, amount, index }) => toNode(index, account, amount)).sort(Buffer.compare)
  nodes = nodes.filter((el, idx) => idx === 0 || !nodes[idx - 1].equals(el))
  const layers: Buffer[][] = [nodes]
  while (layers[layers.length - 1].length > 1) layers.push(getNextLayer(layers[layers.length - 1]))
  return layers[layers.length - 1][0]
}

const merkleRootHex: string = json.merkleRoot
const merkleRoot = Buffer.from(merkleRootHex.slice(2), 'hex')

const balances: { index: number; account: string; amount: bigint }[] = []
let valid = true

for (const address of Object.keys(json.claims)) {
  const claim = json.claims[address]
  const proof = claim.proof.map((p: string) => Buffer.from(p.slice(2), 'hex'))
  const amount = BigInt(claim.amount)
  balances.push({ index: claim.index, account: address, amount })
  if (!verifyProof(claim.index, address, amount, proof, merkleRoot)) {
    console.error('Verification FAILED for', address)
    valid = false
  }
}

if (!valid) {
  console.error('Failed validation for 1 or more proofs')
  process.exit(1)
}

const reconstructed = '0x' + getRoot(balances).toString('hex')
console.log('proofs verified   :', balances.length)
console.log('reconstructed root:', reconstructed)

if (reconstructed !== merkleRootHex) {
  console.error('Reconstructed root does NOT match the recorded root')
  process.exit(1)
}
console.log('root matches      : yes')
