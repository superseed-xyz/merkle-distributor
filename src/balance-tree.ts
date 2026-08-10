import { solidityPackedKeccak256 } from 'ethers'
import MerkleTree from './merkle-tree'

export default class BalanceTree {
  private readonly tree: MerkleTree

  constructor(balances: { account: string; amount: bigint }[]) {
    this.tree = new MerkleTree(balances.map(({ account, amount }, index) => BalanceTree.toNode(index, account, amount)))
  }

  public static verifyProof(
    index: number | bigint,
    account: string,
    amount: bigint,
    proof: Buffer[],
    root: Buffer
  ): boolean {
    let pair = BalanceTree.toNode(index, account, amount)
    for (const item of proof) {
      pair = MerkleTree.combinedHash(pair, item)
    }
    return pair.equals(root)
  }

  // keccak256(abi.encodePacked(index, account, amount)) — must match the contract.
  public static toNode(index: number | bigint, account: string, amount: bigint): Buffer {
    const hex = solidityPackedKeccak256(['uint256', 'address', 'uint256'], [index, account, amount])
    return Buffer.from(hex.slice(2), 'hex')
  }

  public getHexRoot(): string {
    return this.tree.getHexRoot()
  }

  public getProof(index: number | bigint, account: string, amount: bigint): string[] {
    return this.tree.getHexProof(BalanceTree.toNode(index, account, amount))
  }
}
