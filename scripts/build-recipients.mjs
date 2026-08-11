#!/usr/bin/env node
/**
 * Converts any snapshot export into the canonical merkle input:
 *
 *   [{ "address": "0x…", "amount": "<decimal wei>" }, …]
 *
 * Accepts CSV or JSON. Every amount stays a string end to end; nothing is ever
 * put through a JS Number, so no wei value can be rounded.
 *
 *   node scripts/build-recipients.mjs snapshot.csv > recipients.json
 *   node scripts/build-recipients.mjs snapshot.json --min-eth 0.0001 --expect-count 10518
 */
import { readFileSync } from 'node:fs'
import { getAddress } from 'ethers'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const opt = (n, d = null) => {
  const i = argv.indexOf(n)
  return i === -1 ? d : argv[i + 1]
}

// Every option below takes exactly one value; anything not a flag and not a flag's value
// is the positional input path.
const VALUED_FLAGS = new Set([
  '--address-column',
  '--amount-column',
  '--amount-format',
  '--min-wei',
  '--min-eth',
  '--expect-total',
  '--expect-count',
])
const BOOLEAN_FLAGS = new Set(['--help'])
let inputPath = null
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    if (!VALUED_FLAGS.has(argv[i]) && !BOOLEAN_FLAGS.has(argv[i])) {
      throw new Error(`unknown flag: ${argv[i]}`)
    }
    if (VALUED_FLAGS.has(argv[i])) {
      if (i + 1 >= argv.length) throw new Error(`${argv[i]} requires a value`)
      i++ // skip its value
    }
    continue
  }
  if (inputPath !== null) throw new Error(`unexpected extra argument: ${argv[i]}`)
  inputPath = argv[i]
}

if (!inputPath || flag('--help')) {
  process.stderr.write(
    `usage: node build-recipients.mjs <input.csv|input.json> [options] > recipients.json\n` +
      `  --address-column <name>            default: address\n` +
      `  --amount-column <name>             default: amount\n` +
      `  --amount-format decimal|hex|auto   default: auto (0x prefix means hex)\n` +
      `  --min-wei <n>                      drop entries below this\n` +
      `  --min-eth <n>                      same, expressed in ETH\n` +
      `  --expect-total <wei>               fail unless the sum matches exactly\n` +
      `  --expect-count <n>                 fail unless the entry count matches\n`
  )
  process.exit(inputPath ? 0 : 1)
}

const addressColumn = opt('--address-column', 'address')
const amountColumn = opt('--amount-column', 'amount')
const amountFormat = opt('--amount-format', 'auto')
if (!['decimal', 'hex', 'auto'].includes(amountFormat)) {
  throw new Error(`--amount-format must be decimal, hex or auto; got ${amountFormat}`)
}

const minEth = opt('--min-eth')
const minWeiOpt = opt('--min-wei')
if (minEth !== null && minWeiOpt !== null) throw new Error('use --min-wei or --min-eth, not both')
const minWei =
  minWeiOpt !== null
    ? BigInt(minWeiOpt)
    : minEth !== null
      ? (() => {
          // Parse the decimal ETH string without floating point.
          const [whole, frac = ''] = String(minEth).split('.')
          if (frac.length > 18) throw new Error('--min-eth has more than 18 decimals')
          return BigInt(whole + frac.padEnd(18, '0'))
        })()
      : 0n

/** Minimal RFC-4180 parser: quoted fields, escaped quotes, CRLF. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  const kept = rows.filter((r) => r.length > 1 || r[0] !== '')
  if (kept.length < 2) throw new Error('CSV has no data rows')
  const header = kept[0].map((h) => h.replace(/^﻿/, '').trim())
  const dupes = header.filter((h, i) => header.indexOf(h) !== i)
  if (dupes.length) throw new Error(`duplicate column name(s) in CSV header: ${[...new Set(dupes)].join(', ')}`)
  return kept.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])))
}

const raw = readFileSync(inputPath, 'utf8')
const rows = raw.trimStart().startsWith('[') || raw.trimStart().startsWith('{') ? JSON.parse(raw) : parseCsv(raw)
if (!Array.isArray(rows)) throw new Error('JSON input must be an array of objects')
if (rows.length === 0) throw new Error('input has no rows')

if (!(addressColumn in rows[0])) {
  throw new Error(`input is missing the "${addressColumn}" column; found: ${Object.keys(rows[0]).join(', ')}`)
}
if (!(amountColumn in rows[0])) {
  throw new Error(`input is missing the "${amountColumn}" column; found: ${Object.keys(rows[0]).join(', ')}`)
}

const MAX_UINT256 = (1n << 256n) - 1n

const seen = new Set()
const out = []
let sum = 0n
let dropped = 0

for (const [i, row] of rows.entries()) {
  if (typeof row[amountColumn] === 'number') {
    throw new Error(
      `row ${i}: amount must be a STRING, not a JSON number; ` +
        `numeric literals lose precision above 2^53 (got ${row[amountColumn]})`
    )
  }

  const rawAddress = String(row[addressColumn]).trim()
  const lower = rawAddress.toLowerCase()
  const isMixedCase = rawAddress !== lower && rawAddress !== rawAddress.toUpperCase()
  if (isMixedCase) {
    // A mixed-case address carries an EIP-55 checksum. Lowercasing it first would
    // discard that protection and let a one-character typo through silently.
    try {
      getAddress(rawAddress)
    } catch {
      throw new Error(`row ${i}: bad EIP-55 checksum: ${rawAddress}`)
    }
  }
  const address = lower
  const rawAmount = String(row[amountColumn]).trim().toLowerCase()

  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`row ${i}: malformed address ${address}`)
  if (seen.has(address)) throw new Error(`row ${i}: duplicate address ${address}`)
  seen.add(address)

  const isHex = amountFormat === 'hex' || (amountFormat === 'auto' && rawAmount.startsWith('0x'))
  if (isHex) {
    if (!/^(0x)?[0-9a-f]+$/.test(rawAmount)) throw new Error(`row ${i}: malformed hex amount ${rawAmount}`)
  } else if (!/^[0-9]+$/.test(rawAmount)) {
    throw new Error(`row ${i}: malformed decimal amount ${rawAmount}`)
  }

  const wei = BigInt(isHex && !rawAmount.startsWith('0x') ? '0x' + rawAmount : rawAmount)
  if (wei <= 0n) throw new Error(`row ${i}: amount must be positive for ${address}`)
  if (wei > MAX_UINT256) throw new Error(`row ${i}: amount exceeds uint256 for ${address}`)

  if (wei < minWei) {
    dropped++
    continue
  }

  sum += wei
  out.push({ address, amount: wei.toString() })
}

const expectTotal = opt('--expect-total')
if (expectTotal !== null && BigInt(expectTotal) !== sum) {
  throw new Error(`total mismatch: computed ${sum} wei, expected ${BigInt(expectTotal)} wei`)
}
const expectCount = opt('--expect-count')
if (expectCount !== null && Number(expectCount) !== out.length) {
  throw new Error(`count mismatch: computed ${out.length} entries, expected ${Number(expectCount)}`)
}

process.stderr.write(
  `recipients : ${out.length}${dropped ? ` (${dropped} below the floor, dropped)` : ''}\n` +
    `total      : ${sum} wei\n` +
    `fund the distributor with at least this amount\n`
)

process.stdout.write(JSON.stringify(out, null, 2) + '\n')
