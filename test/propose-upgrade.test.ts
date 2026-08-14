import { spawnSync } from 'child_process'
import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SCRIPT = path.join(__dirname, '../scripts/deploy/proposeUpgrade.ts')

const PROXY = '0x' + '1'.repeat(40)
const PROXY_ADMIN = '0x' + '2'.repeat(40)
const IMPLEMENTATION = '0x' + '3'.repeat(40)

/**
 * The script resolves dist/deployment.json relative to the working directory, so each
 * case runs in its own temp dir and writes whatever artifact it wants to exercise.
 */
const workdir = (artifact?: Record<string, unknown>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pu-'))
  if (artifact) {
    fs.mkdirSync(path.join(dir, 'dist'))
    fs.writeFileSync(path.join(dir, 'dist/deployment.json'), JSON.stringify(artifact, null, 2))
  }
  return dir
}

/**
 * hardhat.config.ts calls dotenv.config() when mocha loads, so the real .env is already
 * in process.env by the time these run. Strip every variable the script reads and pass
 * back only what each case sets, or a stale local .env would decide the results.
 */
const run = (dir: string, vars: Record<string, string>) => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['PROXY', 'PROXY_ADMIN', 'IMPLEMENTATION', 'CHAIN_ID']) delete env[k]
  const out = path.join(dir, 'upgrade.json')
  // spawnSync rather than execFileSync: the no-chainId case warns on stderr and still
  // exits 0, and execFileSync only hands back stderr when the child fails.
  const r = spawnSync('npx', ['ts-node', SCRIPT, '-o', out], {
    cwd: dir,
    env: { ...env, ...vars },
    encoding: 'utf8',
  })
  return { ok: r.status === 0, output: (r.stdout ?? '') + (r.stderr ?? ''), out }
}

const base = { PROXY, PROXY_ADMIN }

describe('proposeUpgrade chainId guard', () => {
  it('refuses an artifact deployed to a different chain than the batch targets', () => {
    const dir = workdir({ implementation: IMPLEMENTATION, chainId: 31337, network: 'hardhat' })
    const r = run(dir, { ...base, CHAIN_ID: '1' })
    expect(r.ok, 'expected a non-zero exit').to.equal(false)
    expect(r.output).to.match(/chainId 31337/)
    expect(r.output).to.match(/targets chainId 1/)
    expect(fs.existsSync(r.out), 'no batch should be written').to.equal(false)
  })

  it('refuses a hardhat artifact against the default chainId of 1', () => {
    const dir = workdir({ implementation: IMPLEMENTATION, chainId: 31337, network: 'hardhat' })
    const r = run(dir, base)
    expect(r.ok).to.equal(false)
    expect(r.output).to.match(/network "hardhat"/)
  })

  it('accepts an artifact whose chainId matches', () => {
    const dir = workdir({ implementation: IMPLEMENTATION, chainId: 1, network: 'mainnet' })
    const r = run(dir, { ...base, CHAIN_ID: '1' })
    expect(r.ok, r.output).to.equal(true)
    const batch = JSON.parse(fs.readFileSync(r.out, 'utf8'))
    expect(batch.chainId).to.equal('1')
    expect(batch.transactions[0].contractInputsValues._implementation).to.equal(IMPLEMENTATION)
  })

  it('lets an explicit IMPLEMENTATION override a mismatched artifact', () => {
    const dir = workdir({ implementation: IMPLEMENTATION, chainId: 31337, network: 'hardhat' })
    const other = '0x' + '4'.repeat(40)
    const r = run(dir, { ...base, IMPLEMENTATION: other, CHAIN_ID: '1' })
    expect(r.ok, r.output).to.equal(true)
    const batch = JSON.parse(fs.readFileSync(r.out, 'utf8'))
    expect(batch.transactions[0].contractInputsValues._implementation).to.equal(other)
  })

  it('warns rather than refusing when the artifact records no chainId', () => {
    const dir = workdir({ implementation: IMPLEMENTATION })
    const r = run(dir, { ...base, CHAIN_ID: '1' })
    expect(r.ok, r.output).to.equal(true)
    expect(r.output).to.match(/records no chainId/)
  })

  it('enforces the guard when the artifact records chainId as a numeric string', () => {
    const dir = workdir({ implementation: IMPLEMENTATION, chainId: '31337', network: 'hardhat' })
    const r = run(dir, { ...base, CHAIN_ID: '1' })
    expect(r.ok, 'a stringified chainId must not bypass the guard').to.equal(false)
    expect(r.output).to.match(/chainId 31337/)
    expect(fs.existsSync(r.out)).to.equal(false)
  })

  it('accepts a matching chainId recorded as a numeric string', () => {
    const dir = workdir({ implementation: IMPLEMENTATION, chainId: '1', network: 'mainnet' })
    const r = run(dir, { ...base, CHAIN_ID: '1' })
    expect(r.ok, r.output).to.equal(true)
  })

  it('refuses an artifact whose chainId is present but unreadable', () => {
    const dir = workdir({ implementation: IMPLEMENTATION, chainId: 'mainnet' })
    const r = run(dir, { ...base, CHAIN_ID: '1' })
    expect(r.ok).to.equal(false)
    expect(r.output).to.match(/unreadable chainId/)
    expect(fs.existsSync(r.out)).to.equal(false)
  })

  it('refuses a CHAIN_ID that is not a positive integer', () => {
    for (const bad of ['abc', '0', '-1', '1.5']) {
      const dir = workdir({ implementation: IMPLEMENTATION, chainId: 1 })
      const r = run(dir, { ...base, CHAIN_ID: bad })
      expect(r.ok, `CHAIN_ID=${bad} should be refused`).to.equal(false)
      expect(r.output).to.match(/CHAIN_ID must be a positive integer/)
      expect(fs.existsSync(r.out), `CHAIN_ID=${bad} wrote a batch`).to.equal(false)
    }
  })
})
