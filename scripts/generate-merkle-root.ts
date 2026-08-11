import { program } from 'commander'
import fs from 'fs'
import { parseBalanceMap, SnapshotEntry } from '../src/parse-balance-map'

program
  .version('1.0.0')
  .requiredOption('-i, --input <path>', 'merkle input JSON: [{ address, amount }] with decimal wei amounts')
  .option('-o, --output <path>', 'write the result here instead of stdout')

program.parse(process.argv)
const options = program.opts()

const json: SnapshotEntry[] = JSON.parse(fs.readFileSync(options.input, { encoding: 'utf8' }))
if (!Array.isArray(json)) throw new Error('Expected an array of { address, amount }')

const result = parseBalanceMap(json)
const serialised = JSON.stringify(result, null, 2) + '\n'

if (options.output) fs.writeFileSync(options.output, serialised)
else process.stdout.write(serialised)

process.stderr.write(
  `merkleRoot : ${result.merkleRoot}\n` +
    `recipients : ${Object.keys(result.claims).length}\n` +
    `tokenTotal : ${result.tokenTotal} wei\n`
)
