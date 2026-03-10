/**
 * Ground-truth version data for an installed ComfyUI.
 *
 * Stored on the installation record as `comfyVersion`.  All display
 * strings are derived at render time via {@link formatComfyVersion}.
 */
export interface ComfyVersion {
  /** Full 40-character commit SHA. */
  commit: string
  /** Nearest stable release tag (e.g. "v0.14.2"). */
  baseTag?: string
  /** Number of commits ahead of baseTag (0 = on the tag, >0 = latest channel). */
  commitsAhead?: number
}

/**
 * Format a {@link ComfyVersion} for display.
 *
 * @param v  Structured version data (may be undefined for legacy installs).
 * @param style  `'short'` for cards (`v0.14.2+21`), `'detail'` for the
 *               Manage view (`v0.14.2 + 21 commits (a1b2c3d)`).
 * @param legacyVersion  Fallback string from `installation.version` for
 *                       pre-migration installations that lack `comfyVersion`.
 */
export function formatComfyVersion(
  v: ComfyVersion | undefined,
  style: 'short' | 'detail',
  legacyVersion?: string
): string {
  if (!v) return legacyVersion || 'unknown'

  const { commit, baseTag, commitsAhead } = v
  const shortSha = commit.slice(0, 7)

  if (!baseTag) return legacyVersion || shortSha

  // undefined (API comparison failed) and 0 (exactly on tag) both display as the tag.
  // This is intentional: if we don't know how far ahead, we conservatively show the tag.
  if (!commitsAhead || commitsAhead === 0) return baseTag

  if (style === 'short') {
    return `${baseTag}+${commitsAhead}`
  }

  return `${baseTag} + ${commitsAhead} commit${commitsAhead !== 1 ? 's' : ''} (${shortSha})`
}
