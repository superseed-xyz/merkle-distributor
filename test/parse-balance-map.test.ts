import { expect } from 'chai'
import { parseBalanceMap } from '../src/parse-balance-map'
import input from './fixtures/example-input.json'
import golden from './fixtures/golden-example-distribution.json'

describe('parseBalanceMap', () => {
  it('reproduces the ethers v5 merkle root exactly', () => {
    const result = parseBalanceMap(input)
    expect(result.merkleRoot).to.equal(golden.merkleRoot)
  })

  it('reproduces every index, amount and proof exactly', () => {
    const result = parseBalanceMap(input)
    expect(Object.keys(result.claims)).to.have.length(Object.keys(golden.claims).length)
    for (const [address, expected] of Object.entries(golden.claims)) {
      const actual = result.claims[address]
      expect(actual, `missing claim for ${address}`).to.not.equal(undefined)
      expect(actual.index, `index for ${address}`).to.equal(expected.index)
      expect(actual.amount, `amount for ${address}`).to.equal(expected.amount)
      expect(actual.proof, `proof for ${address}`).to.deep.equal(expected.proof)
    }
  })

  it('reports tokenTotal as a decimal wei string equal to the input sum', () => {
    const result = parseBalanceMap(input)
    const sum = input.reduce((acc, e) => acc + BigInt(e.amount), 0n)
    expect(result.tokenTotal).to.equal(sum.toString())
  })

  it('rejects a duplicate address regardless of casing', () => {
    const entry = input[0]
    expect(() =>
      parseBalanceMap([
        { address: entry.address.toLowerCase(), amount: '1' },
        { address: entry.address.toUpperCase().replace('0X', '0x'), amount: '1' },
      ])
    ).to.throw(/[Dd]uplicate/)
  })

  it('rejects a zero amount', () => {
    expect(() => parseBalanceMap([{ address: input[0].address, amount: '0' }])).to.throw(/[Ii]nvalid amount/)
  })

  it('rejects a malformed address', () => {
    expect(() => parseBalanceMap([{ address: '0xnothex', amount: '1' }])).to.throw(/[Ii]nvalid address/)
  })

  it('rejects a hex amount, which would be silently misread', () => {
    expect(() => parseBalanceMap([{ address: input[0].address, amount: '0x10' }])).to.throw(/decimal/)
  })
})
