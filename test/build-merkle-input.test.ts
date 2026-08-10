import { execFileSync } from 'child_process'
import { expect } from 'chai'
import path from 'path'
import fs from 'fs'
import os from 'os'

const SCRIPT = path.join(__dirname, '../scripts/build-merkle-input.mjs')
const CSV = path.join(__dirname, 'fixtures/snapshot-sample.csv')

const run = (args: string[]) => execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' })
const runExpectingFailure = (args: string[]): string => {
  try {
    execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e: any) {
    return String(e.stderr ?? e.message)
  }
  throw new Error('expected the script to exit non-zero')
}

const writeTemp = (name: string, contents: string) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mi-')), name)
  fs.writeFileSync(p, contents)
  return p
}

describe('build-merkle-input', () => {
  it('converts CSV to the canonical decimal-wei array', () => {
    const out = JSON.parse(run([CSV]))
    expect(out).to.deep.equal([
      { address: '0x1111111111111111111111111111111111111111', amount: '1000000000000000000' },
      { address: '0x2222222222222222222222222222222222222222', amount: '2500000000000000' },
      { address: '0x3333333333333333333333333333333333333333', amount: '50000000000' },
    ])
  })

  it('accepts JSON input', () => {
    const p = writeTemp('in.json', JSON.stringify([{ address: '0x' + '1'.repeat(40), amount: '5' }]))
    expect(JSON.parse(run([p]))).to.deep.equal([{ address: '0x' + '1'.repeat(40), amount: '5' }])
  })

  it('converts hex amounts when told to', () => {
    const p = writeTemp('hex.json', JSON.stringify([{ address: '0x' + '1'.repeat(40), amount: '0x10' }]))
    expect(JSON.parse(run([p, '--amount-format', 'hex']))).to.deep.equal([
      { address: '0x' + '1'.repeat(40), amount: '16' },
    ])
  })

  it('auto-detects hex by the 0x prefix', () => {
    const p = writeTemp('auto.json', JSON.stringify([{ address: '0x' + '1'.repeat(40), amount: '0xff' }]))
    expect(JSON.parse(run([p]))).to.deep.equal([{ address: '0x' + '1'.repeat(40), amount: '255' }])
  })

  it('honours a custom column name', () => {
    const p = writeTemp('cols.csv', 'who,earnings\n0x' + '1'.repeat(40) + ',7\n')
    expect(JSON.parse(run([p, '--address-column', 'who', '--amount-column', 'earnings']))).to.deep.equal([
      { address: '0x' + '1'.repeat(40), amount: '7' },
    ])
  })

  it('applies a dust floor', () => {
    const out = JSON.parse(run([CSV, '--min-wei', '1000000000000000']))
    expect(out.map((e: any) => e.address)).to.deep.equal([
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
    ])
  })

  it('fails on a duplicate address regardless of casing', () => {
    const p = writeTemp('dup.json', JSON.stringify([
      { address: '0x' + 'a'.repeat(40), amount: '1' },
      { address: '0x' + 'A'.repeat(40), amount: '2' },
    ]))
    expect(runExpectingFailure([p])).to.match(/duplicate/i)
  })

  it('fails on a malformed address', () => {
    const p = writeTemp('bad.json', JSON.stringify([{ address: '0xnope', amount: '1' }]))
    expect(runExpectingFailure([p])).to.match(/address/i)
  })

  it('fails on a zero amount', () => {
    const p = writeTemp('zero.json', JSON.stringify([{ address: '0x' + '1'.repeat(40), amount: '0' }]))
    expect(runExpectingFailure([p])).to.match(/positive/i)
  })

  it('fails when --expect-total does not match', () => {
    expect(runExpectingFailure([CSV, '--expect-total', '1'])).to.match(/total mismatch/i)
  })

  it('fails when --expect-count does not match', () => {
    expect(runExpectingFailure([CSV, '--expect-count', '99'])).to.match(/count mismatch/i)
  })

  it('passes when --expect-total and --expect-count both match', () => {
    // 1000000000000000000 + 2500000000000000 + 50000000000 = 1002500050000000000
    const out = JSON.parse(run([CSV, '--expect-total', '1002500050000000000', '--expect-count', '3']))
    expect(out).to.have.length(3)
  })
})
