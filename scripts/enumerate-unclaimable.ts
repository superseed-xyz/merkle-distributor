import { program } from 'commander'
import fs from 'fs'
import { JsonRpcProvider, formatEther } from 'ethers'
import { SnapshotEntry } from '../src/parse-balance-map'

program
  .version('1.0.0')
  .requiredOption('-i, --input <path>', 'merkle input JSON')
  .option('--rpc <url>', 'JSON-RPC endpoint', process.env.MAINNET_RPC_URL)
  .option('--from <address>', 'address the simulated transfer is sent from', '0x' + '1'.repeat(40))
  .option('--concurrency <n>', 'parallel RPC requests', '10')
  .option('-o, --output <path>', 'write the unclaimable list here')

program.parse(process.argv)
const options = program.opts()

if (!options.rpc) throw new Error('no --rpc and no MAINNET_RPC_URL')

const entries: SnapshotEntry[] = JSON.parse(fs.readFileSync(options.input, 'utf8'))
const provider = new JsonRpcProvider(options.rpc)
const concurrency = Number(options.concurrency)

// Heuristic, not proof: estimateGas from an arbitrary --from address only tells us
// whether *this* sender can push a plain, empty-calldata value transfer into the
// address right now. A contract could still accept ETH from some senders and not
// others, or have a receive() that consumes more gas than claim() forwards.
async function canReceive(address: string, amount: bigint): Promise<boolean> {
  try {
    // A plain value transfer with empty calldata. Reverts if there is no payable
    // receive() or fallback().
    await provider.estimateGas({ from: options.from, to: address, value: amount, data: '0x' })
    return true
  } catch {
    return false
  }
}

async function main() {
  const unclaimable: { address: string; amount: string }[] = []
  let contracts = 0
  let checked = 0

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency)
    const results = await Promise.all(
      batch.map(async (e) => {
        const code = await provider.getCode(e.address)
        const isContract = code !== '0x'
        // EOAs (no code) can always receive ETH; only probe contracts.
        const ok = isContract ? await canReceive(e.address, BigInt(e.amount)) : true
        return { entry: e, isContract, ok }
      })
    )
    for (const r of results) {
      checked++
      if (r.isContract) contracts++
      if (!r.ok) unclaimable.push({ address: r.entry.address, amount: r.entry.amount })
    }
    process.stderr.write(`checked ${checked}/${entries.length}\r`)
  }
  process.stderr.write('\n')

  const stranded = unclaimable.reduce((a, e) => a + BigInt(e.amount), 0n)

  console.log(`recipients     : ${entries.length}`)
  console.log(`contracts      : ${contracts}`)
  console.log(`unclaimable    : ${unclaimable.length}`)
  console.log(`stranded       : ${stranded} wei (${formatEther(stranded)} ETH)`)

  if (options.output) {
    fs.writeFileSync(options.output, JSON.stringify(unclaimable, null, 2) + '\n')
    console.log(`wrote          : ${options.output}`)
  } else if (unclaimable.length) {
    for (const u of unclaimable) console.log(`  ${u.address}  ${u.amount}`)
  }

  console.log('\nAdvisory: these recipients cannot accept a plain ETH transfer, so their')
  console.log('claim would revert with TransferFailed. Record this figure in the runbook')
  console.log('before the upgrade is signed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
