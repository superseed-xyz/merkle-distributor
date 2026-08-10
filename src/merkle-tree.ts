import { keccak256 } from 'ethers'

export default class MerkleTree {
  private readonly elements: Buffer[]
  private readonly bufferElementPositionIndex: { [hexElement: string]: number }
  private readonly layers: Buffer[][]

  constructor(elements: Buffer[]) {
    this.elements = [...elements]
    // Sort elements, then remove duplicates.
    this.elements.sort(Buffer.compare)
    this.elements = this.elements.filter((el, idx) => idx === 0 || !this.elements[idx - 1].equals(el))

    this.bufferElementPositionIndex = this.elements.reduce<{ [hexElement: string]: number }>((memo, el, index) => {
      memo[bufferToHex(el)] = index
      return memo
    }, {})

    this.layers = this.getLayers(this.elements)
  }

  getLayers(elements: Buffer[]): Buffer[][] {
    if (elements.length === 0) {
      throw new Error('empty tree')
    }
    const layers: Buffer[][] = [elements]
    while (layers[layers.length - 1].length > 1) {
      layers.push(MerkleTree.getNextLayer(layers[layers.length - 1]))
    }
    return layers
  }

  static getNextLayer(elements: Buffer[]): Buffer[] {
    return elements.reduce<Buffer[]>((layer, el, idx, arr) => {
      if (idx % 2 === 0) {
        layer.push(MerkleTree.combinedHash(el, arr[idx + 1]))
      }
      return layer
    }, [])
  }

  static combinedHash(first: Buffer | null | undefined, second: Buffer | null | undefined): Buffer {
    if (!first) return second as Buffer
    if (!second) return first as Buffer
    const sorted = [first, second].sort(Buffer.compare)
    return Buffer.from(keccak256(Buffer.concat(sorted)).slice(2), 'hex')
  }

  getRoot(): Buffer {
    return this.layers[this.layers.length - 1][0]
  }

  getHexRoot(): string {
    return bufferToHex(this.getRoot())
  }

  getProof(el: Buffer): Buffer[] {
    let idx = this.bufferElementPositionIndex[bufferToHex(el)]
    if (typeof idx !== 'number') {
      throw new Error('Element does not exist in Merkle tree')
    }
    return this.layers.reduce<Buffer[]>((proof, layer) => {
      const pairElement = MerkleTree.getPairElement(idx, layer)
      if (pairElement) proof.push(pairElement)
      idx = Math.floor(idx / 2)
      return proof
    }, [])
  }

  getHexProof(el: Buffer): string[] {
    return this.getProof(el).map(bufferToHex)
  }

  private static getPairElement(idx: number, layer: Buffer[]): Buffer | null {
    const pairIdx = idx % 2 === 0 ? idx + 1 : idx - 1
    return pairIdx < layer.length ? layer[pairIdx] : null
  }
}

function bufferToHex(buf: Buffer): string {
  return '0x' + buf.toString('hex')
}
