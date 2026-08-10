import { execFileSync } from 'child_process'
import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseBalanceMap } from '../src/parse-balance-map'

const SCRIPT = path.join(__dirname, '../scripts/check-distribution.ts')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cd-'))
const write = (dir: string, name: string, data: unknown) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
  return p
}
const run = (args: string[]) =>
  execFileSync('npx', ['ts-node', SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' })
const runExpectingFailure = (args: string[]): string => {
  try {
    execFileSync('npx', ['ts-node', SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e: any) {
    return String(e.stdout ?? '') + String(e.stderr ?? '')
  }
  throw new Error('expected a non-zero exit')
}

const input = [
  { address: '0x' + '1'.repeat(40), amount: '100' },
  { address: '0x' + '2'.repeat(40), amount: '250' },
]

describe('check-distribution', () => {
  it('passes for a matching input and result', () => {
    const dir = tmp()
    const i = write(dir, 'input.json', input)
    const r = write(dir, 'result.json', parseBalanceMap(input))
    expect(run(['-i', i, '-r', r])).to.match(/all checks passed/i)
  })

  it('fails when an address is missing from the result', () => {
    const dir = tmp()
    const result = parseBalanceMap(input)
    delete (result.claims as any)[Object.keys(result.claims)[0]]
    const i = write(dir, 'input.json', input)
    const r = write(dir, 'result.json', result)
    expect(runExpectingFailure(['-i', i, '-r', r])).to.match(/missing/i)
  })

  it('fails when an amount disagrees', () => {
    const dir = tmp()
    const result = parseBalanceMap(input)
    const first = Object.keys(result.claims)[0]
    result.claims[first].amount = '999'
    const i = write(dir, 'input.json', input)
    const r = write(dir, 'result.json', result)
    expect(runExpectingFailure(['-i', i, '-r', r])).to.match(/amount/i)
  })

  it('fails when tokenTotal disagrees with the input sum', () => {
    const dir = tmp()
    const result = parseBalanceMap(input)
    result.tokenTotal = '1'
    const i = write(dir, 'input.json', input)
    const r = write(dir, 'result.json', result)
    expect(runExpectingFailure(['-i', i, '-r', r])).to.match(/tokenTotal/i)
  })

  it('fails when indices are not contiguous', () => {
    const dir = tmp()
    const result = parseBalanceMap(input)
    result.claims[Object.keys(result.claims)[1]].index = 7
    const i = write(dir, 'input.json', input)
    const r = write(dir, 'result.json', result)
    expect(runExpectingFailure(['-i', i, '-r', r])).to.match(/contiguous/i)
  })

  it('fails when the result contains an address not in the input', () => {
    const dir = tmp()
    const result = parseBalanceMap([...input, { address: '0x' + '3'.repeat(40), amount: '1' }])
    const i = write(dir, 'input.json', input)
    const r = write(dir, 'result.json', result)
    expect(runExpectingFailure(['-i', i, '-r', r])).to.match(/not in the input/i)
  })

  it('reports data failures even when the balance check cannot reach the RPC', () => {
    const dir = tmp()
    const result = parseBalanceMap(input)
    result.tokenTotal = '1'
    const i = write(dir, 'input.json', input)
    const r = write(dir, 'result.json', result)
    const out = runExpectingFailure([
      '-i', i, '-r', r,
      '--address', '0x0000000000000000000000000000000000000001',
      '--rpc', 'http://127.0.0.1:1/unreachable',
    ])
    // Both the data problem AND the RPC problem must be visible.
    expect(out).to.match(/tokenTotal/i)
    expect(out).to.match(/balance check/i)
  })
})
