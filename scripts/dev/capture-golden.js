// Run with: npx ts-node scripts/dev/capture-golden.js
// Captures the ethers-v5 output of parseBalanceMap so the v6 port can be proven identical.
const fs = require('fs')
const path = require('path')
const { BigNumber } = require('ethers')
const { parseBalanceMap } = require('../../src/parse-balance-map')

// new_example.json — 34 entries in NewFormat. Use this one, NOT example.json:
// example.json is a single-entry OldFormat map, which yields a one-leaf tree with an
// empty proof and would make this fixture worthless as a regression guard.
const source = JSON.parse(fs.readFileSync(path.join(__dirname, '../../test/fixtures/new_example.json'), 'utf8'))
if (!Array.isArray(source)) throw new Error('expected the NewFormat array fixture')

// The v5 pipeline consumes [{address, earnings (hex), reasons}]. Capture its result...
const result = parseBalanceMap(source)

// ...and emit the same data in the NEW canonical input shape, so the v6 code can be fed
// an equivalent input and must produce a byte-identical root.
const input = source.map((e) => ({
  address: e.address,
  amount: BigNumber.from(e.earnings).toString(),
}))

const golden = {
  merkleRoot: result.merkleRoot,
  claims: Object.fromEntries(
    Object.entries(result.claims).map(([address, c]) => [
      address,
      { index: c.index, amount: BigNumber.from(c.amount).toString(), proof: c.proof },
    ])
  ),
}

const outDir = path.join(__dirname, '../../test/fixtures')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'example-input.json'), JSON.stringify(input, null, 2) + '\n')
fs.writeFileSync(path.join(outDir, 'golden-example-result.json'), JSON.stringify(golden, null, 2) + '\n')

console.log('merkleRoot   :', golden.merkleRoot)
console.log('claims       :', Object.keys(golden.claims).length)
