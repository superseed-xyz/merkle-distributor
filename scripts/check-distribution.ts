import 'dotenv/config'
import { program } from 'commander'
import fs from 'fs'
import { getAddress, JsonRpcProvider } from 'ethers'
import { MerkleDistributorInfo, SnapshotEntry } from '../src/parse-balance-map'

program
  .version('1.0.0')
  .requiredOption('-i, --input <path>', 'the merkle input that was fed to generate-merkle-root')
  .requiredOption('-r, --result <path>', 'the generate-merkle-root output')
  .option('-a, --address <address>', 'on-chain address that must hold at least tokenTotal')
  .option('--rpc <url>', 'JSON-RPC endpoint for the balance check', process.env.MAINNET_RPC_URL)

program.parse(process.argv)
const options = program.opts()

const input: SnapshotEntry[] = JSON.parse(fs.readFileSync(options.input, 'utf8'))
const result: MerkleDistributorInfo = JSON.parse(fs.readFileSync(options.result, 'utf8'))

const failures: string[] = []
const fail = (message: string) => failures.push(message)

// 1. Every input address appears exactly once, with the right amount.
const inputByAddress = new Map<string, bigint>()
for (const entry of input) {
  const checksummed = getAddress(entry.address)
  if (inputByAddress.has(checksummed)) fail(`duplicate address in the input: ${checksummed}`)
  inputByAddress.set(checksummed, BigInt(entry.amount))
}

for (const [address, amount] of inputByAddress) {
  const claim = result.claims[address]
  if (!claim) {
    fail(`missing claim for ${address}`)
    continue
  }
  if (BigInt(claim.amount) !== amount) {
    fail(`amount mismatch for ${address}: input ${amount}, result ${claim.amount}`)
  }
}

// 2. No extras in the result.
for (const address of Object.keys(result.claims)) {
  if (!inputByAddress.has(address)) fail(`result contains ${address}, which is not in the input`)
}

// 3. tokenTotal equals the input sum.
const inputSum = [...inputByAddress.values()].reduce((a, b) => a + b, 0n)
if (BigInt(result.tokenTotal) !== inputSum) {
  fail(`tokenTotal mismatch: input sums to ${inputSum}, result reports ${result.tokenTotal}`)
}

// 4. Indices form a contiguous 0..n-1.
const indices = Object.values(result.claims)
  .map((c) => c.index)
  .sort((a, b) => a - b)
for (let i = 0; i < indices.length; i++) {
  if (indices[i] !== i) {
    fail(`indices are not contiguous: expected ${i} at position ${i}, got ${indices[i]}`)
    break
  }
}

async function main() {
  // 5. Optional: the funding address actually holds enough.
  if (options.address) {
    if (!options.rpc) fail('--address given but no --rpc / MAINNET_RPC_URL to check it against')
    else {
      // The RPC call must not be allowed to escape main(): if it threw, every
      // synchronous failure already accumulated above would go unprinted, and an
      // operator would fix their connectivity, re-run, and never learn the data
      // was also wrong. Degrade it to just another entry in the failure list.
      try {
        const balance = await new JsonRpcProvider(options.rpc).getBalance(options.address)
        if (balance < inputSum) {
          fail(`${options.address} holds ${balance} wei, less than tokenTotal ${inputSum} wei`)
        } else {
          console.log(`balance      : ${balance} wei at ${options.address} (covers tokenTotal)`)
        }
      } catch (e) {
        fail(`balance check against ${options.rpc} failed: ${(e as Error).message}`)
      }
    }
  }

  console.log(`recipients   : ${inputByAddress.size}`)
  console.log(`tokenTotal   : ${result.tokenTotal} wei`)
  console.log(`merkleRoot   : ${result.merkleRoot}`)

  if (failures.length) {
    console.error(`\n${failures.length} check(s) FAILED:`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
