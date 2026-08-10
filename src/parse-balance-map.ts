import { getAddress, isAddress } from 'ethers'
import BalanceTree from './balance-tree'

/** One snapshot row. `amount` is wei as a DECIMAL string — never hex, never a number. */
export interface SnapshotEntry {
  address: string
  amount: string
}

/** The blob that fully describes a distribution. Sufficient to rebuild the whole tree. */
export interface MerkleDistributorInfo {
  merkleRoot: string
  /** Sum of all amounts, wei as a decimal string. */
  tokenTotal: string
  claims: {
    [account: string]: {
      index: number
      /** wei as a decimal string */
      amount: string
      proof: string[]
    }
  }
}

const DECIMAL = /^[0-9]+$/

export function parseBalanceMap(entries: SnapshotEntry[]): MerkleDistributorInfo {
  if (!Array.isArray(entries)) throw new Error('Expected an array of { address, amount }')
  if (entries.length === 0) throw new Error('Expected at least one entry')

  const dataByAddress: { [address: string]: bigint } = {}

  for (const { address, amount } of entries) {
    if (typeof address !== 'string' || !isAddress(address)) {
      throw new Error(`Invalid address: ${address}`)
    }
    if (typeof amount !== 'string' || !DECIMAL.test(amount)) {
      throw new Error(`Amount for ${address} must be a decimal wei string, got: ${amount}`)
    }

    const parsed = getAddress(address)
    if (dataByAddress[parsed] !== undefined) throw new Error(`Duplicate address: ${parsed}`)

    const value = BigInt(amount)
    if (value <= 0n) throw new Error(`Invalid amount for account: ${parsed}`)

    dataByAddress[parsed] = value
  }

  const sortedAddresses = Object.keys(dataByAddress).sort()

  const tree = new BalanceTree(sortedAddresses.map((account) => ({ account, amount: dataByAddress[account] })))

  const claims = sortedAddresses.reduce<MerkleDistributorInfo['claims']>((memo, address, index) => {
    const amount = dataByAddress[address]
    memo[address] = {
      index,
      amount: amount.toString(),
      proof: tree.getProof(index, address, amount),
    }
    return memo
  }, {})

  const tokenTotal = sortedAddresses.reduce<bigint>((memo, key) => memo + dataByAddress[key], 0n)

  return { merkleRoot: tree.getHexRoot(), tokenTotal: tokenTotal.toString(), claims }
}
