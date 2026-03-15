// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./git', () => ({
  findNearestTag: vi.fn(),
  findLatestVersionTag: vi.fn(),
  countCommitsAhead: vi.fn(),
  countUniqueCommits: vi.fn(),
  isAncestorOf: vi.fn(),
  findMergeBase: vi.fn(),
}))

import { findNearestTag, findLatestVersionTag, countCommitsAhead, countUniqueCommits, isAncestorOf, findMergeBase } from './git'
import { resolveLocalVersion, clearVersionCache } from './version-resolve'

const mockedFindNearestTag = vi.mocked(findNearestTag)
const mockedFindLatestVersionTag = vi.mocked(findLatestVersionTag)
const mockedCountCommitsAhead = vi.mocked(countCommitsAhead)
const mockedCountUniqueCommits = vi.mocked(countUniqueCommits)
const mockedIsAncestorOf = vi.mocked(isAncestorOf)
const mockedFindMergeBase = vi.mocked(findMergeBase)

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
    expect(mockedFindMergeBase).not.toHaveBeenCalled()
  })

  it('upgrades to best backport tag when latest has unreachable content', async () => {
    // Scenario: commit is on master (9 ahead of v0.17.0), latest tag v0.17.2
    // is on a release branch.  v0.17.0 IS an ancestor of v0.17.2 but v0.17.2
    // is NOT an ancestor of the commit.  v0.17.2 has 3 unique commits
    // (2 version bumps + 1 content not on master), but v0.17.1 has only 1
    // unique commit (the version bump — its content was cherry-picked from
    // master).  Should upgrade to v0.17.1 (highest tag where all content
    // is represented on master).
    mockedFindNearestTag.mockImplementation(async (_repo, ref) => {
      if (ref === 'abc1234') return 'v0.17.0'
      // Walking the release branch backward
      if (ref === 'v0.17.2') return 'v0.17.2'
      if (ref === 'v0.17.2~1') return 'v0.17.1'
      if (ref === 'v0.17.1~1') return 'v0.17.0'
      return undefined
    })
    mockedFindLatestVersionTag.mockResolvedValue('v0.17.2')
    mockedCountCommitsAhead.mockResolvedValue(9)
    mockedIsAncestorOf.mockImplementation(async (_repo, ancestor, descendant) => {
      if (ancestor === 'v0.17.0' && descendant === 'v0.17.2') return true
      if (ancestor === 'v0.17.2' && descendant === 'abc1234') return false
      return false
    })
    mockedCountUniqueCommits.mockImplementation(async (_repo, ref1, ref2) => {
      // v0.17.2 has 3 unique commits (2 version bumps + 1 extra content);
      // threshold for v0.17.2 (position 2 of 2) = 2, so 3 > 2 → skip
      if (ref1 === 'v0.17.2' && ref2 === 'abc1234') return 3
      // v0.17.1 has 1 unique commit (just version bump);
      // threshold for v0.17.1 (position 1 of 2) = 1, so 1 ≤ 1 → qualifies
      if (ref1 === 'v0.17.1' && ref2 === 'abc1234') return 1
      // master has 8 unique commits vs v0.17.1 (cherry-picked one excluded)
      if (ref1 === 'abc1234' && ref2 === 'v0.17.1') return 8
      return undefined
    })

    const result = await resolveLocalVersion('/repo', 'abc1234')
    expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.17.1', commitsAhead: 8 })
    expect(mockedFindMergeBase).not.toHaveBeenCalled()
  })

  it('upgrades to latest backport tag when all content is on master', async () => {
    // Scenario: commit is further ahead on master — all cherry-picked content
    // from v0.17.2 is now on master.  v0.17.2 has 2 unique commits (both are
    // version bumps: v0.17.1 and v0.17.2).  With 2 tags in the chain,
    // threshold for v0.17.2 = 2, so 2 ≤ 2 → qualifies.
    mockedFindNearestTag.mockImplementation(async (_repo, ref) => {
      if (ref === 'abc1234') return 'v0.17.0'
      if (ref === 'v0.17.2') return 'v0.17.2'
      if (ref === 'v0.17.2~1') return 'v0.17.1'
      if (ref === 'v0.17.1~1') return 'v0.17.0'
      return undefined
    })
    mockedFindLatestVersionTag.mockResolvedValue('v0.17.2')
    mockedCountCommitsAhead.mockResolvedValue(12)
    mockedIsAncestorOf.mockImplementation(async (_repo, ancestor, descendant) => {
      if (ancestor === 'v0.17.0' && descendant === 'v0.17.2') return true
      if (ancestor === 'v0.17.2' && descendant === 'abc1234') return false
      return false
    })
    mockedCountUniqueCommits.mockImplementation(async (_repo, ref1, ref2) => {
      // v0.17.1: 1 unique (version bump); threshold = 1 → qualifies
      if (ref1 === 'v0.17.1' && ref2 === 'abc1234') return 1
      if (ref1 === 'abc1234' && ref2 === 'v0.17.1') return 11
      // v0.17.2: 2 unique (both version bumps); threshold = 2 → qualifies
      if (ref1 === 'v0.17.2' && ref2 === 'abc1234') return 2
      if (ref1 === 'abc1234' && ref2 === 'v0.17.2') return 10
      return undefined
    })

    const result = await resolveLocalVersion('/repo', 'abc1234')
    expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.17.2', commitsAhead: 10 })
  })

  it('falls back to ancestor tag when no backport tag qualifies', async () => {
    // Even the lowest tag on the release branch has content not on master.
    mockedFindNearestTag.mockImplementation(async (_repo, ref) => {
      if (ref === 'abc1234') return 'v0.17.0'
      if (ref === 'v0.17.2') return 'v0.17.2'
      if (ref === 'v0.17.2~1') return 'v0.17.1'
      if (ref === 'v0.17.1~1') return 'v0.17.0'
      return undefined
    })
    mockedFindLatestVersionTag.mockResolvedValue('v0.17.2')
    mockedCountCommitsAhead.mockResolvedValue(9)
    mockedIsAncestorOf.mockImplementation(async (_repo, ancestor, descendant) => {
      if (ancestor === 'v0.17.0' && descendant === 'v0.17.2') return true
      if (ancestor === 'v0.17.2' && descendant === 'abc1234') return false
      return false
    })
    mockedCountUniqueCommits.mockImplementation(async (_repo, ref1, ref2) => {
      // v0.17.1 has 2 unique commits (version bump + content); threshold = 1 → fails
      if (ref1 === 'v0.17.1' && ref2 === 'abc1234') return 2
      return undefined
    })

    const result = await resolveLocalVersion('/repo', 'abc1234')
    expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.17.0', commitsAhead: 9 })
  })

  it('falls back to merge-base when cherry-pick detection is unreliable (shallow clone)', async () => {
    // In a shallow clone, countUniqueCommits returns wildly inflated values
    // because the truncated graph prevents patch-id matching.  The sanity
    // check detects this (unique > ancestorDist) and bails out, falling
    // back to the merge-base approach with the latest tag.
    mockedFindNearestTag.mockImplementation(async (_repo, ref) => {
      if (ref === 'abc1234') return 'v0.17.0'
      if (ref === 'v0.17.2') return 'v0.17.2'
      if (ref === 'v0.17.2~1') return 'v0.17.1'
      if (ref === 'v0.17.1~1') return 'v0.17.0'
      return undefined
    })
    mockedFindLatestVersionTag.mockResolvedValue('v0.17.2')
    mockedCountCommitsAhead.mockImplementation(async (_repo, base, _commit) => {
      if (base === 'v0.17.0') return 12
      if (base === 'merge-base-sha') return 12
      return undefined
    })
    mockedIsAncestorOf.mockImplementation(async (_repo, ancestor, descendant) => {
      if (ancestor === 'v0.17.0' && descendant === 'v0.17.2') return true
      if (ancestor === 'v0.17.2' && descendant === 'abc1234') return false
      return false
    })
    mockedCountUniqueCommits.mockImplementation(async () => {
      // Shallow clone: returns thousands — way more than ancestorDist (12)
      return 4905
    })
    mockedFindMergeBase.mockResolvedValue('merge-base-sha')

    const result = await resolveLocalVersion('/repo', 'abc1234')
    // Falls back to merge-base approach with latest tag name
    expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.17.2', commitsAhead: 12 })
  })

  it('keeps ancestor tag when it is NOT an ancestor of latest (different branch)', async () => {
    mockedFindNearestTag.mockResolvedValue('v0.16.4')
    mockedFindLatestVersionTag.mockResolvedValue('v0.17.1')
    mockedCountCommitsAhead.mockResolvedValue(38)
    mockedIsAncestorOf.mockResolvedValue(false)

    const result = await resolveLocalVersion('/repo', 'abc1234')
    expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.16.4', commitsAhead: 38 })
  })

  it('falls back to ancestor tag when merge-base fails (backport path)', async () => {
    // latestTag is NOT a direct ancestor of the commit (backport branch),
    // the backport walk returns nothing, and findMergeBase also fails
    // → fall back to ancestor tag.
    mockedFindNearestTag.mockImplementation(async (_repo, ref) => {
      if (ref === 'abc1234') return 'v0.16.4'
      // Walk reaches stopTag immediately
      if (ref === 'v0.17.1') return 'v0.17.1'
      if (ref === 'v0.17.1~1') return 'v0.16.4'
      return undefined
    })
    mockedFindLatestVersionTag.mockResolvedValue('v0.17.1')
    mockedCountCommitsAhead.mockResolvedValue(38)
    mockedIsAncestorOf.mockImplementation(async (_repo, ancestor, descendant) => {
      if (ancestor === 'v0.16.4' && descendant === 'v0.17.1') return true
      if (ancestor === 'v0.17.1' && descendant === 'abc1234') return false
      return false
    })
    mockedCountUniqueCommits.mockResolvedValue(undefined)
    mockedFindMergeBase.mockResolvedValue(undefined)

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

  describe('latestTagOverride', () => {
    it('uses override instead of findLatestVersionTag', async () => {
      mockedFindNearestTag.mockResolvedValue('v0.16.4')
      mockedCountCommitsAhead.mockImplementation(async (_repo, tag) => {
        if (tag === 'v0.16.4') return 38
        if (tag === 'sha-of-v0.17.1') return 7
        return undefined
      })
      mockedIsAncestorOf.mockResolvedValue(true)

      const result = await resolveLocalVersion('/repo', 'abc1234', undefined, {
        name: 'v0.17.1',
        sha: 'sha-of-v0.17.1',
      })
      expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.17.1', commitsAhead: 7 })
      expect(mockedFindLatestVersionTag).not.toHaveBeenCalled()
    })

    it('uses SHA for isAncestorOf checks', async () => {
      mockedFindNearestTag.mockResolvedValue('v0.16.4')
      mockedCountCommitsAhead.mockResolvedValue(38)
      mockedIsAncestorOf.mockResolvedValue(true)

      await resolveLocalVersion('/repo', 'abc1234', undefined, {
        name: 'v0.17.1',
        sha: 'sha-of-v0.17.1',
      })
      expect(mockedIsAncestorOf).toHaveBeenCalledWith('/repo', 'v0.16.4', 'sha-of-v0.17.1')
      expect(mockedIsAncestorOf).toHaveBeenCalledWith('/repo', 'sha-of-v0.17.1', 'abc1234')
      expect(mockedFindMergeBase).not.toHaveBeenCalled()
    })

    it('falls back to ancestor tag when override ancestry check fails', async () => {
      mockedFindNearestTag.mockResolvedValue('v0.16.4')
      mockedCountCommitsAhead.mockResolvedValue(38)
      mockedIsAncestorOf.mockResolvedValue(false)

      const result = await resolveLocalVersion('/repo', 'abc1234', undefined, {
        name: 'v0.17.1',
        sha: 'sha-of-v0.17.1',
      })
      expect(result).toEqual({ commit: 'abc1234', baseTag: 'v0.16.4', commitsAhead: 38 })
    })
  })
})
