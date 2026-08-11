import 'dotenv/config'
import { program } from 'commander'
import fs from 'fs'
import { getAddress, JsonRpcProvider } from 'ethers'
import { Distribution, SnapshotEntry } from '../src/parse-balance-map'

program
  .version('1.0.0')
  .requiredOption('-i, --input <path>', 'the merkle input that was fed to generate-merkle-root')
  .requiredOption('-d, --distribution <path>', 'the generate-merkle-root output')
  .option('-a, --address <address>', 'on-chain address that must hold at least tokenTotal')
  .option('--rpc <url>', 'JSON-RPC endpoint for the balance check', process.env.MAINNET_RPC_URL)

program.parse(process.argv)
const options = program.opts()

const input: SnapshotEntry[] = JSON.parse(fs.readFileSync(options.input, 'utf8'))
const distribution: Distribution = JSON.parse(fs.readFileSync(options.distribution, 'utf8'))

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
  const claim = distribution.claims[address]
  if (!claim) {
    fail(`missing claim for ${address}`)
    continue
  }
  if (BigInt(claim.amount) !== amount) {
    fail(`amount mismatch for ${address}: input ${amount}, distribution ${claim.amount}`)
  }
}

// 2. No extras in the distribution.
for (const address of Object.keys(distribution.claims)) {
  if (!inputByAddress.has(address)) fail(`distribution contains ${address}, which is not in the input`)
}

// 3. tokenTotal equals the input sum.
const inputSum = [...inputByAddress.values()].reduce((a, b) => a + b, 0n)
if (BigInt(distribution.tokenTotal) !== inputSum) {
  fail(`tokenTotal mismatch: input sums to ${inputSum}, distribution reports ${distribution.tokenTotal}`)
}

// 4. Indices form a contiguous 0..n-1.
const indices = Object.values(distribution.claims)
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
      // Held so it can be destroyed: ethers v6 keeps a background network-detection
      // timer alive, which would stop the process exiting on the clean path. Today the
      // explicit process.exit() calls below happen to mask that, but relying on them
      // makes termination an accident rather than a guarantee.
      const provider = new JsonRpcProvider(options.rpc)
      try {
        const balance = await provider.getBalance(options.address)
        if (balance < inputSum) {
          fail(`${options.address} holds ${balance} wei, less than tokenTotal ${inputSum} wei`)
        } else {
          console.log(`balance      : ${balance} wei at ${options.address} (covers tokenTotal)`)
        }
      } catch (e) {
        fail(`balance check against ${options.rpc} failed: ${(e as Error).message}`)
      } finally {
        provider.destroy()
      }
    }
  }

  console.log(`recipients   : ${inputByAddress.size}`)
  console.log(`tokenTotal   : ${distribution.tokenTotal} wei`)
  console.log(`merkleRoot   : ${distribution.merkleRoot}`)

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
