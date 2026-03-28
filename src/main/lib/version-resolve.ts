import { findNearestTag, findLatestVersionTag, countCommitsAhead, countUniqueCommits, isAncestorOf, findMergeBase } from './git'
import type { ComfyVersion } from './version'

/** Pre-resolved latest tag info, shared across repos with the same origin. */
export interface LatestTagOverride {
  /** Tag name, e.g. "v0.17.1". */
  name: string
  /** Full commit SHA the tag points to. */
  sha: string
}

/**
 * In-memory cache for resolved versions, keyed by "repoPath\0commitSha".
 * Stores only git-derived data (no fallbackTag) so callers with different
 * fallbacks share the same cache entry safely.
 */
const _cache = new Map<string, ComfyVersion>()

/** Short-lived cache for the latest version tag per repo path. */
let _latestTagCache: { repoPath: string; tag: string | undefined; ts: number } | null = null
const LATEST_TAG_TTL_MS = 5_000

async function getCachedLatestTag(repoPath: string): Promise<string | undefined> {
  if (_latestTagCache && _latestTagCache.repoPath === repoPath && Date.now() - _latestTagCache.ts < LATEST_TAG_TTL_MS) {
    return _latestTagCache.tag
  }
  const tag = await findLatestVersionTag(repoPath)
  _latestTagCache = { repoPath, tag, ts: Date.now() }
  return tag
}

/** Maximum number of tags to walk backward on a release branch. */
const MAX_BACKPORT_WALK = 10

/**
 * Walk the release branch backward from `startRef` to find the highest tag
 * whose content is fully represented in `commit` (cherry-pick–aware).
 *
 * Collects candidate tags by walking backward, then evaluates from lowest
 * to highest.  A tag at position N (1-based, counting from `stopTag`)
 * qualifies when `countUniqueCommits(tag, commit) ≤ N` — each tag in the
 * chain is expected to contribute one version-bump commit that has no
 * equivalent on the commit's branch.
 *
 * @returns The qualifying tag name and cherry-pick–aware "+N" count, or
 *          undefined if no qualifying tag is found before reaching `stopTag`.
 */
async function findBestBackportTag(
  repoPath: string,
  startRef: string,
  commit: string,
  stopTag: string,
  ancestorDist?: number,
): Promise<{ tag: string; commitsAhead: number } | undefined> {
  // Phase 1: collect candidate tags by walking backward.
  const candidates: string[] = []
  let ref = startRef
  for (let i = 0; i < MAX_BACKPORT_WALK; i++) {
    const tag = await findNearestTag(repoPath, ref)
    if (!tag || tag === stopTag) break
    candidates.push(tag)
    ref = `${tag}~1`
  }
  if (candidates.length === 0) return undefined

  // Phase 2: evaluate from lowest (closest to stopTag) to highest.
  // Each tag adds one version-bump commit, so the threshold grows with
  // the tag's position in the chain.
  //
  // Sanity check: in shallow clones, countUniqueCommits can return wildly
  // inflated values because the truncated graph prevents patch-id matching.
  // If any result exceeds ancestorDist (the total commits from ancestor tag
  // to the commit on master), the data is unreliable — bail out entirely
  // so the caller can fall back to the merge-base approach.
  let best: { tag: string; commitsAhead: number } | undefined
  for (let pos = candidates.length - 1; pos >= 0; pos--) {
    const tag = candidates[pos]!
    const threshold = candidates.length - pos
    const unique = await countUniqueCommits(repoPath, tag, commit)
    if (unique === undefined) break
    if (ancestorDist !== undefined && unique > ancestorDist) return undefined
    // This tag has too many unique commits — stop ascending the chain
    // (higher tags will have even more).  Any previously found `best` from
    // a lower tag is still valid and will be returned.
    if (unique > threshold) break
    const ahead = await countUniqueCommits(repoPath, commit, tag)
    if (ahead === undefined) break
    best = { tag, commitsAhead: ahead }
  }
  return best
}

/**
 * @internal Use {@link resolveInstalledVersion} instead — it guards against
 * re-resolving when stored metadata is already authoritative.
 *
 * Resolve a {@link ComfyVersion} from local git state.  Uses the nearest
 * ancestor tag as a base, upgrading to a newer version tag when possible.
 *
 * When the latest version tag is a direct ancestor of the commit, it is
 * used directly.  When the latest tag is on a parallel release branch
 * (backport), the release branch is walked backward to find the highest
 * tag whose cherry-picked content is fully represented in the commit
 * (via patch-id comparison).  The "+N" count is also cherry-pick–aware,
 * excluding commits already present via cherry-pick.
 *
 * Results are cached by (repoPath, commit) so repeated calls (e.g. for
 * multiple snapshots sharing the same commit) only spawn git once.
 *
 * @param comfyuiDir         Path to the ComfyUI git working tree.
 * @param commit             The commit SHA to resolve.
 * @param fallbackTag        Optional tag to use when no git tags exist (e.g. manifest comfyui_ref).
 * @param latestTagOverride  Pre-resolved latest tag info from a sibling repo
 *                           that shares the same origin.  When provided, skips
 *                           findLatestVersionTag and uses the SHA directly
 *                           (works even if the tag ref doesn't exist locally).
 */
export async function resolveLocalVersion(
  comfyuiDir: string,
  commit: string,
  fallbackTag?: string,
  latestTagOverride?: LatestTagOverride,
): Promise<ComfyVersion> {
  const overrideKey = latestTagOverride ? `\0${latestTagOverride.name}\0${latestTagOverride.sha}` : ''
  const cacheKey = `${comfyuiDir}\0${commit}${overrideKey}`
  const cached = _cache.get(cacheKey)
  if (cached) {
    // Cache stores git-only data; apply fallbackTag at read time without
    // mutating the cached entry.
    if (fallbackTag && !cached.baseTag) {
      return { ...cached, baseTag: fallbackTag }
    }
    return cached
  }

  // When an override is provided, use its SHA for git operations (works
  // in any clone of the same repo, even without the tag ref locally).
  // Otherwise fall back to the per-repo tag lookup.
  const latestTagName = latestTagOverride?.name ?? await getCachedLatestTag(comfyuiDir)
  const latestTagRef = latestTagOverride?.sha ?? latestTagName

  const ancestorTag = await findNearestTag(comfyuiDir, commit)
  const ancestorDist = ancestorTag ? await countCommitsAhead(comfyuiDir, ancestorTag, commit) : undefined

  // Try to upgrade from the ancestor tag to a newer version tag.
  // The latest tag may be a direct ancestor of the commit (same branch) or
  // on a parallel release branch with cherry-picked backports.
  //
  // Direct ancestor case:  latestTag → … → commit   (isAncestorOf = true)
  //   → use latestTag directly, count = commits from tag to commit.
  //
  // Backport case:  latestTag is NOT an ancestor, but ancestorTag IS an
  //   ancestor of latestTag (the release branch was cut from a point the
  //   commit has already passed).  Walk the release branch backward from
  //   latestTag to find the highest tag whose content is fully represented
  //   in the commit (cherry-pick–aware via countUniqueCommits ≤ 1, i.e.
  //   only the version-bump commit is unique to the release branch).
  //   The "+N" count uses the same cherry-pick–aware logic in the reverse
  //   direction, excluding commits already present via cherry-pick.
  let baseTag: string | undefined
  let commitsAhead: number | undefined

  const shouldUpgrade = latestTagName && latestTagName !== ancestorTag && ancestorDist !== undefined && ancestorDist > 0
  let upgraded = false

  if (shouldUpgrade) {
    const ancestorIsParent = ancestorTag ? await isAncestorOf(comfyuiDir, ancestorTag, latestTagRef!) : false

    if (ancestorIsParent && await isAncestorOf(comfyuiDir, latestTagRef!, commit)) {
      // Direct ancestor — latestTag is in the commit's history.
      // Since latestTagRef is an ancestor of commit, we can count directly.
      const dist = await countCommitsAhead(comfyuiDir, latestTagRef!, commit)
      if (dist !== undefined) {
        baseTag = latestTagName
        commitsAhead = dist
        upgraded = true
      }
    } else if (ancestorIsParent) {
      // Backport branch — walk backward to find the highest qualifying tag
      // using cherry-pick–aware comparison.
      const found = await findBestBackportTag(comfyuiDir, latestTagRef!, commit, ancestorTag!, ancestorDist)
      if (found) {
        baseTag = found.tag
        commitsAhead = found.commitsAhead
        upgraded = true
      } else {
        // Cherry-pick detection may fail in shallow clones where the commit
        // graph is incomplete.  Fall back to the merge-base approach: use
        // the latest tag name with a count from the merge-base.  This is
        // less precise (doesn't exclude cherry-picked commits from +N) but
        // still gives a reasonable display.
        const mergeBase = await findMergeBase(comfyuiDir, latestTagRef!, commit)
        const dist = mergeBase ? await countCommitsAhead(comfyuiDir, mergeBase, commit) : undefined
        if (dist !== undefined) {
          baseTag = latestTagName
          commitsAhead = dist
          upgraded = true
        }
      }
    }
  }

  if (!upgraded) {
    baseTag = ancestorTag
    commitsAhead = ancestorDist
  }

  // Cache stores git-only data (no fallbackTag) so different callers
  // sharing the same (repoPath, commit) don't poison each other.
  const result: ComfyVersion = { commit, baseTag, commitsAhead }
  _cache.set(cacheKey, result)

  // Apply fallbackTag for the caller if git found no tag.
  if (fallbackTag && !baseTag) {
    return { ...result, baseTag: fallbackTag }
  }
  return result
}

/**
 * Single write-gate for resolving the version to store on an installation.
 *
 * When the commit hasn't changed and the stored version already has a
 * baseTag, returns the stored version as-is — re-resolving against the
 * current git state can produce wrong results when newer tags exist
 * (e.g. a snapshot-restored v0.17.2+12 re-resolving to v0.18.3).
 *
 * Only re-resolves from git when:
 * - No stored version exists (fresh install)
 * - The commit has changed (update / restore that moved HEAD)
 * - The stored version lacks a baseTag (legacy migration)
 */
export async function resolveInstalledVersion(
  comfyuiDir: string,
  commit: string,
  storedVersion: ComfyVersion | undefined,
  hint?: string,
  latestTagOverride?: LatestTagOverride,
): Promise<ComfyVersion> {
  if (storedVersion?.baseTag && storedVersion.commit === commit) {
    return storedVersion
  }
  return resolveLocalVersion(comfyuiDir, commit, hint, latestTagOverride)
}

/** Clear the version cache (e.g. after an update changes tags). */
export function clearVersionCache(): void {
  _cache.clear()
  _latestTagCache = null
}
