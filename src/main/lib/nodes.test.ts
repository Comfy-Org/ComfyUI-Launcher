import { describe, it, expect } from 'vitest'
import { nodeKey } from './nodes'
import type { ScannedNode } from './nodes'

describe('nodeKey', () => {
  it('returns type:dirName format', () => {
    const node: ScannedNode = { id: 'my-node', type: 'cnr', dirName: 'my-node', enabled: true, version: '1.0' }
    expect(nodeKey(node)).toBe('cnr:my-node')
  })

  it('uses dirName not id for uniqueness', () => {
    const a: ScannedNode = { id: 'display-name', type: 'git', dirName: 'actual-dir', enabled: true }
    const b: ScannedNode = { id: 'other-name', type: 'git', dirName: 'actual-dir', enabled: true }
    expect(nodeKey(a)).toBe(nodeKey(b))
  })

  it('distinguishes nodes by type', () => {
    const cnr: ScannedNode = { id: 'node', type: 'cnr', dirName: 'node', enabled: true }
    const git: ScannedNode = { id: 'node', type: 'git', dirName: 'node', enabled: true }
    expect(nodeKey(cnr)).not.toBe(nodeKey(git))
  })
})
