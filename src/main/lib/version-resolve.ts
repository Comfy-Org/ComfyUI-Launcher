import { findNearestTag, findLatestVersionTag, countCommitsAhead, isAncestorOf } from './git'
import type { ComfyVersion } from './version'

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

/**
 * Resolve a {@link ComfyVersion} from local git state.  Uses the nearest
 * ancestor tag as a base, upgrading to the repo-wide latest version tag
 * when the commit is ahead (latest/master channel) AND the ancestor tag is
 * an ancestor of that latest tag — meaning the backport branched from a
 * point the commit has already passed.
 *
 * Results are cached by (repoPath, commit) so repeated calls (e.g. for
 * multiple snapshots sharing the same commit) only spawn git once.
 *
 * @param comfyuiDir  Path to the ComfyUI git working tree.
 * @param commit      The commit SHA to resolve.
 * @param fallbackTag Optional tag to use when no git tags exist (e.g. manifest comfyui_ref).
 */
export async function resolveLocalVersion(comfyuiDir: string, commit: string, fallbackTag?: string): Promise<ComfyVersion> {
  const cacheKey = `${comfyuiDir}\0${commit}`
  const cached = _cache.get(cacheKey)
  if (cached) {
    // Cache stores git-only data; apply fallbackTag at read time without
    // mutating the cached entry.
    if (fallbackTag && !cached.baseTag) {
      return { ...cached, baseTag: fallbackTag }
    }
    return cached
  }

  const [ancestorTag, latestTag] = await Promise.all([
    findNearestTag(comfyuiDir, commit),
    getCachedLatestTag(comfyuiDir),
  ])
  const ancestorDist = ancestorTag ? await countCommitsAhead(comfyuiDir, ancestorTag, commit) : undefined

  // Use the global latest tag only when the commit is ahead of the ancestor
  // tag (latest channel) AND the ancestor tag is an ancestor of the latest
  // tag.  The ancestry check ensures we only upgrade when the backport
  // release branched from a point the commit has already passed — i.e. the
  // backport's commits are accounted for by the commit's position in history.
  let useLatest = false
  if (latestTag && latestTag !== ancestorTag && ancestorDist !== undefined && ancestorDist > 0) {
    useLatest = ancestorTag ? await isAncestorOf(comfyuiDir, ancestorTag, latestTag) : false
  }

  let baseTag: string | undefined
  let commitsAhead: number | undefined
  if (useLatest) {
    const latestDist = await countCommitsAhead(comfyuiDir, latestTag!, commit)
    if (latestDist !== undefined) {
      // Successfully counted relative to the latest tag.
      baseTag = latestTag
      commitsAhead = latestDist
    } else {
      // Could not count relative to latestTag — fall back to ancestorTag
      // so the tag and count stay consistent.
      baseTag = ancestorTag
      commitsAhead = ancestorDist
    }
  } else {
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

/** Clear the version cache (e.g. after an update changes tags). */
export function clearVersionCache(): void {
  _cache.clear()
  _latestTagCache = null
}
