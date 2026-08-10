// Run with: npx ts-node scripts/dev/capture-golden.js
// Captures the ethers-v5 output of parseBalanceMap so the v6 port can be proven identical.
const fs = require('fs')
const path = require('path')
const { BigNumber } = require('ethers')
const { parseBalanceMap } = require('../../src/parse-balance-map')

const source = JSON.parse(fs.readFileSync(path.join(__dirname, '../example.json'), 'utf8'))

// The v5 pipeline consumes the old format. Capture its result...
const result = parseBalanceMap(source)

// ...and emit the same data in the NEW canonical input shape, so the v6 code can be fed
// an equivalent input and must produce a byte-identical root.
const input = Object.keys(source).map((address) => ({
  address: address,
  amount: BigNumber.from(source[address]).toString(),
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
