import { describe, it, expect } from 'vitest'
import { formatComfyVersion } from './version'
import type { ComfyVersion } from './version'

describe('formatComfyVersion', () => {
  it('returns legacy string when no structured version', () => {
    expect(formatComfyVersion(undefined, 'short', 'v0.14.2 + 21 commits (abc1234)')).toBe('v0.14.2 + 21 commits (abc1234)')
  })

  it('returns "unknown" when no data at all', () => {
    expect(formatComfyVersion(undefined, 'short')).toBe('unknown')
    expect(formatComfyVersion(undefined, 'detail')).toBe('unknown')
  })

  it('returns short SHA when no baseTag and no legacy string', () => {
    const v: ComfyVersion = { commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' }
    expect(formatComfyVersion(v, 'short')).toBe('a1b2c3d')
    expect(formatComfyVersion(v, 'detail')).toBe('a1b2c3d')
  })

  it('returns legacy string when baseTag is missing but legacy version exists', () => {
    const v: ComfyVersion = { commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' }
    expect(formatComfyVersion(v, 'short', 'v0.14.2+5')).toBe('v0.14.2+5')
    expect(formatComfyVersion(v, 'detail', 'v0.14.2 + 5 commits (a1b2c3d)')).toBe('v0.14.2 + 5 commits (a1b2c3d)')
  })

  it('returns baseTag when commitsAhead is 0', () => {
    const v: ComfyVersion = { commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', baseTag: 'v0.14.2', commitsAhead: 0 }
    expect(formatComfyVersion(v, 'short')).toBe('v0.14.2')
    expect(formatComfyVersion(v, 'detail')).toBe('v0.14.2')
  })

  it('returns baseTag when commitsAhead is undefined', () => {
    const v: ComfyVersion = { commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', baseTag: 'v0.14.2' }
    expect(formatComfyVersion(v, 'short')).toBe('v0.14.2')
    expect(formatComfyVersion(v, 'detail')).toBe('v0.14.2')
  })

  it('returns short format with commits ahead', () => {
    const v: ComfyVersion = { commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', baseTag: 'v0.14.2', commitsAhead: 21 }
    expect(formatComfyVersion(v, 'short')).toBe('v0.14.2+21')
  })

  it('returns detail format with commits ahead', () => {
    const v: ComfyVersion = { commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', baseTag: 'v0.14.2', commitsAhead: 21 }
    expect(formatComfyVersion(v, 'detail')).toBe('v0.14.2 + 21 commits (a1b2c3d)')
  })

  it('uses singular "commit" for commitsAhead === 1', () => {
    const v: ComfyVersion = { commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', baseTag: 'v0.14.2', commitsAhead: 1 }
    expect(formatComfyVersion(v, 'detail')).toBe('v0.14.2 + 1 commit (a1b2c3d)')
    expect(formatComfyVersion(v, 'short')).toBe('v0.14.2+1')
  })
})
