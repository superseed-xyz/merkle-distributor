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

// EIP-7702 delegation designator: 0xef0100 followed by a 20-byte address = 23 bytes.
// As of 2026 an ordinary EOA may carry one, so `getCode() !== '0x'` no longer means
// "contract". Whether such an account accepts plain ETH depends on its delegate, so it
// still must be probed — but counting it as a contract would badly misrepresent how much
// manual review a recipient list needs.
const isDelegatedEoa = (code: string) => code.startsWith('0xef0100') && code.length === 2 + 23 * 2

async function main() {
  const unclaimable: { address: string; amount: string }[] = []
  const unknown: { address: string; error: string }[] = []
  let contracts = 0
  let delegated = 0
  let checked = 0

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency)
    const results = await Promise.all(
      batch.map(async (e) => {
        try {
          const code = await provider.getCode(e.address)
          if (code === '0x') return { entry: e, kind: 'eoa' as const, ok: true }
          const kind = isDelegatedEoa(code) ? ('delegated' as const) : ('contract' as const)
          return { entry: e, kind, ok: await canReceive(e.address, BigInt(e.amount)) }
        } catch (err) {
          // A run over 10k+ addresses against a public endpoint WILL hit transient
          // failures. Letting one rejection escape Promise.all would abort the whole
          // run and discard every batch already tallied. Record and carry on.
          return { entry: e, kind: 'unknown' as const, ok: true, error: (err as Error).message }
        }
      })
    )
    for (const r of results) {
      checked++
      if (r.kind === 'contract') contracts++
      if (r.kind === 'delegated') delegated++
      if (r.kind === 'unknown') unknown.push({ address: r.entry.address, error: r.error })
      if (!r.ok) unclaimable.push({ address: r.entry.address, amount: r.entry.amount })
    }
    process.stderr.write(`checked ${checked}/${entries.length}\r`)
  }
  process.stderr.write('\n')

  const stranded = unclaimable.reduce((a, e) => a + BigInt(e.amount), 0n)

  console.log(`recipients     : ${entries.length}`)
  console.log(`contracts      : ${contracts}`)
  console.log(`delegated EOAs : ${delegated} (EIP-7702)`)
  console.log(`unclaimable    : ${unclaimable.length}`)
  console.log(`stranded       : ${stranded} wei (${formatEther(stranded)} ETH)`)
  if (unknown.length) {
    console.log(`NOT CHECKED    : ${unknown.length} (RPC errors — re-run before trusting the figures above)`)
    for (const u of unknown.slice(0, 10)) console.log(`  ${u.address}  ${u.error}`)
  }

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

// JsonRpcProvider retries network detection in the background on a 1s timer until
// destroy() is called (see ethers' JsonRpcApiProvider#_start). An unreachable RPC would
// otherwise leave that retry loop running forever after main() has already printed its
// report, so the process never exits even though the work is done.
main()
  .then(() => {
    provider.destroy()
    process.exit(0)
  })
  .catch((e) => {
    console.error(e)
    provider.destroy()
    process.exit(1)
  })
