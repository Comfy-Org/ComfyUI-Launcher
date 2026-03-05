import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  net: { fetch: vi.fn() },
}))

import { isSafePathComponent } from './cnr'

describe('isSafePathComponent', () => {
  it('accepts simple names', () => {
    expect(isSafePathComponent('my-node')).toBe(true)
    expect(isSafePathComponent('node_v2')).toBe(true)
    expect(isSafePathComponent('ComfyUI-Manager')).toBe(true)
    expect(isSafePathComponent('a')).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isSafePathComponent('')).toBe(false)
  })

  it('rejects dot and double-dot', () => {
    expect(isSafePathComponent('.')).toBe(false)
    expect(isSafePathComponent('..')).toBe(false)
  })

  it('rejects path traversal', () => {
    expect(isSafePathComponent('../escape')).toBe(false)
    if (process.platform === 'win32') {
      expect(isSafePathComponent('..\\escape')).toBe(false)
    }
  })

  it('rejects paths with separators', () => {
    expect(isSafePathComponent('foo/bar')).toBe(false)
    if (process.platform === 'win32') {
      expect(isSafePathComponent('foo\\bar')).toBe(false)
    }
  })

  it('rejects names that differ from their basename', () => {
    expect(isSafePathComponent('subdir/file')).toBe(false)
  })
})
