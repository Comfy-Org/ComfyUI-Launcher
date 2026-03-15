// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./git', () => ({
  findNearestTag: vi.fn(),
  findLatestVersionTag: vi.fn(),
  countCommitsAhead: vi.fn(),
  isAncestorOf: vi.fn(),
}))

import { findNearestTag, findLatestVersionTag, countCommitsAhead, isAncestorOf } from './git'
import { resolveLocalVersion, clearVersionCache } from './version-resolve'

const mockedFindNearestTag = vi.mocked(findNearestTag)
const mockedFindLatestVersionTag = vi.mocked(findLatestVersionTag)
const mockedCountCommitsAhead = vi.mocked(countCommitsAhead)
const mockedIsAncestorOf = vi.mocked(isAncestorOf)

describe('resolveLocalVersion', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    clearVersionCache()
  })

  it('returns ancestor tag when HEAD is exactly on it (stable channel)', async () => {
    mockedFindNearestTag.mockResolvedValue('v0.17.0')
    mockedFindLatestVersionTag.mockResolvedValue('v0.17.0')
    mockedCountCommitsAhead.mockResolvedValue(0)

    const result = await resolveLocalVersion('/repo', 'abc1234')
    expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.17.0', commitsAhead: 0 })
  })

  it('upgrades to latest tag when ancestor is behind and is an ancestor of latest', async () => {
    mockedFindNearestTag.mockResolvedValue('v0.16.4')
    mockedFindLatestVersionTag.mockResolvedValue('v0.17.1')
    mockedCountCommitsAhead.mockImplementation(async (_repo, tag) => {
      if (tag === 'v0.16.4') return 38
      if (tag === 'v0.17.1') return 7
      return undefined
    })
    mockedIsAncestorOf.mockResolvedValue(true)

    const result = await resolveLocalVersion('/repo', 'abc1234')
    expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.17.1', commitsAhead: 7 })
  })

  it('keeps ancestor tag when it is NOT an ancestor of latest (different branch)', async () => {
    mockedFindNearestTag.mockResolvedValue('v0.16.4')
    mockedFindLatestVersionTag.mockResolvedValue('v0.17.1')
    mockedCountCommitsAhead.mockResolvedValue(38)
    mockedIsAncestorOf.mockResolvedValue(false)

    const result = await resolveLocalVersion('/repo', 'abc1234')
    expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.16.4', commitsAhead: 38 })
  })

  it('falls back to ancestor tag when countCommitsAhead for latest tag fails', async () => {
    mockedFindNearestTag.mockResolvedValue('v0.16.4')
    mockedFindLatestVersionTag.mockResolvedValue('v0.17.1')
    mockedCountCommitsAhead.mockImplementation(async (_repo, tag) => {
      if (tag === 'v0.16.4') return 38
      if (tag === 'v0.17.1') return undefined
      return undefined
    })
    mockedIsAncestorOf.mockResolvedValue(true)

    const result = await resolveLocalVersion('/repo', 'abc1234')
    expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.16.4', commitsAhead: 38 })
  })

  it('uses fallbackTag when no git tags exist', async () => {
    mockedFindNearestTag.mockResolvedValue(undefined)
    mockedFindLatestVersionTag.mockResolvedValue(undefined)

    const result = await resolveLocalVersion('/repo', 'abc1234', 'v0.14.0')
    expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.14.0', commitsAhead: undefined })
  })

  it('returns no baseTag when no tags and no fallback', async () => {
    mockedFindNearestTag.mockResolvedValue(undefined)
    mockedFindLatestVersionTag.mockResolvedValue(undefined)

    const result = await resolveLocalVersion('/repo', 'abc1234')
    expect(result).toEqual({ commit: 'abc1234', baseTag: undefined, commitsAhead: undefined })
  })

  it('does not upgrade when ancestor and latest are the same tag', async () => {
    mockedFindNearestTag.mockResolvedValue('v0.17.1')
    mockedFindLatestVersionTag.mockResolvedValue('v0.17.1')
    mockedCountCommitsAhead.mockResolvedValue(3)

    const result = await resolveLocalVersion('/repo', 'abc1234')
    expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.17.1', commitsAhead: 3 })
    expect(mockedIsAncestorOf).not.toHaveBeenCalled()
  })

  describe('caching', () => {
    it('returns cached result on second call', async () => {
      mockedFindNearestTag.mockResolvedValue('v0.17.0')
      mockedFindLatestVersionTag.mockResolvedValue('v0.17.0')
      mockedCountCommitsAhead.mockResolvedValue(0)

      await resolveLocalVersion('/repo', 'abc1234')
      vi.resetAllMocks()

      const result = await resolveLocalVersion('/repo', 'abc1234')
      expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.17.0', commitsAhead: 0 })
      expect(mockedFindNearestTag).not.toHaveBeenCalled()
    })

    it('does not bake fallbackTag into cache', async () => {
      mockedFindNearestTag.mockResolvedValue(undefined)
      mockedFindLatestVersionTag.mockResolvedValue(undefined)

      const r1 = await resolveLocalVersion('/repo', 'abc1234', 'v0.14.0')
      expect(r1.baseTag).toBe('v0.14.0')

      // Second call without fallback should NOT get the previous fallback
      const r2 = await resolveLocalVersion('/repo', 'abc1234')
      expect(r2.baseTag).toBeUndefined()
    })

    it('applies different fallbackTags to the same cached entry', async () => {
      mockedFindNearestTag.mockResolvedValue(undefined)
      mockedFindLatestVersionTag.mockResolvedValue(undefined)

      await resolveLocalVersion('/repo', 'abc1234')

      const r1 = await resolveLocalVersion('/repo', 'abc1234', 'v0.14.0')
      expect(r1.baseTag).toBe('v0.14.0')

      const r2 = await resolveLocalVersion('/repo', 'abc1234', 'v0.15.0')
      expect(r2.baseTag).toBe('v0.15.0')
    })

    it('clears cache on clearVersionCache', async () => {
      mockedFindNearestTag.mockResolvedValue('v0.17.0')
      mockedFindLatestVersionTag.mockResolvedValue('v0.17.0')
      mockedCountCommitsAhead.mockResolvedValue(0)

      await resolveLocalVersion('/repo', 'abc1234')
      clearVersionCache()

      await resolveLocalVersion('/repo', 'abc1234')
      expect(mockedFindNearestTag).toHaveBeenCalledTimes(2)
    })
  })

  describe('latest tag caching', () => {
    it('reuses findLatestVersionTag result for same repo within TTL', async () => {
      mockedFindNearestTag.mockResolvedValue('v0.16.4')
      mockedFindLatestVersionTag.mockResolvedValue('v0.17.1')
      mockedCountCommitsAhead.mockResolvedValue(0)

      // Two different commits in the same repo
      await resolveLocalVersion('/repo', 'aaa1111')
      await resolveLocalVersion('/repo', 'bbb2222')

      // findLatestVersionTag should only be called once (cached for same repo)
      expect(mockedFindLatestVersionTag).toHaveBeenCalledTimes(1)
    })
  })
})
