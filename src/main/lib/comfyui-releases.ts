import { fetchJSON } from './fetch'

const REPO = 'Comfy-Org/ComfyUI'

interface GitHubCommit {
  sha: string
  html_url: string
  commit: {
    committer: { date: string } | null
    message: string | null
  } | null
}

interface GitHubRelease {
  tag_name: string
  name: string
  body: string
  html_url: string
  published_at: string
  draft: boolean
  prerelease: boolean
}

interface GitHubTag {
  name: string
}

interface GitHubComparison {
  ahead_by: number
}

function isStableRelease(r: GitHubRelease): boolean {
  return !r.prerelease && !!r.tag_name
}

/**
 * Parse a semver tag like "v0.18.2" into a comparable tuple.
 * Returns null for tags that don't match the expected pattern.
 */
function parseVersionTag(tag: string): number[] | null {
  const m = tag.match(/^v?(\d+(?:\.\d+)*)$/)
  if (!m) return null
  return m[1]!.split('.').map(Number)
}

/**
 * Compare two version tuples. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Find the latest semver tag from the tags API.
 * This catches tags that exist in git but whose GitHub Release is still a draft
 * (the releases API omits drafts for unauthenticated callers).
 */
async function fetchLatestTag(): Promise<string | null> {
  try {
    const tags = await fetchJSON(
      `https://api.github.com/repos/${REPO}/tags?per_page=30`
    ) as GitHubTag[]
    let best: { tag: string; version: number[] } | null = null
    for (const t of tags) {
      const v = parseVersionTag(t.name)
      if (!v) continue
      if (!best || compareVersions(v, best.version) > 0) {
        best = { tag: t.name, version: v }
      }
    }
    return best?.tag ?? null
  } catch {
    return null
  }
}

export async function fetchLatestRelease(
  channel: string
): Promise<Record<string, unknown> | null> {
  if (channel === 'latest') {
    const [commit, releases, latestTag] = await Promise.all([
      fetchJSON(`https://api.github.com/repos/${REPO}/commits/master`) as Promise<GitHubCommit | null>,
      (fetchJSON(`https://api.github.com/repos/${REPO}/releases?per_page=10`) as Promise<GitHubRelease[]>)
        .catch(() => [] as GitHubRelease[]),
      fetchLatestTag(),
    ])
    if (!commit) return null
    const date = commit.commit?.committer?.date
    const msg = commit.commit?.message?.split('\n')[0] ?? ''
    const stable = releases.find(isStableRelease)
    let baseTag: string | undefined
    let commitsAhead: number | undefined
    if (stable) {
      baseTag = stable.tag_name
    }
    // If a newer tag exists (e.g. release is still a draft), prefer it
    if (latestTag) {
      const latestV = parseVersionTag(latestTag)
      const baseV = baseTag ? parseVersionTag(baseTag) : null
      if (latestV && (!baseV || compareVersions(latestV, baseV) > 0)) {
        baseTag = latestTag
      }
    }
    if (baseTag) {
      try {
        const cmp = await fetchJSON(
          `https://api.github.com/repos/${REPO}/compare/${baseTag}...master`
        ) as GitHubComparison
        commitsAhead = cmp.ahead_by
      } catch {
        // comparison failed — we know the base tag but not how far ahead
      }
    }
    return {
      tag_name: commit.sha.slice(0, 7),
      commitSha: commit.sha,
      baseTag,
      commitsAhead,
      body: msg,
      html_url: commit.html_url,
      published_at: date,
      _commit: true,
    }
  }
  const [releases, latestTag] = await Promise.all([
    fetchJSON(`https://api.github.com/repos/${REPO}/releases?per_page=30`) as Promise<GitHubRelease[]>,
    fetchLatestTag(),
  ])
  const stable = releases.find(isStableRelease)

  // Determine if a newer tag exists that isn't yet a published release
  // (e.g. the GitHub Release is still in draft form).
  const stableV = stable ? parseVersionTag(stable.tag_name) : null
  const latestV = latestTag ? parseVersionTag(latestTag) : null
  const tagIsNewer = latestV && (!stableV || compareVersions(latestV, stableV) > 0)

  if (tagIsNewer && latestTag) {
    // Build a synthetic release from the tag — no release notes available
    // since the release is still a draft, but the version is correct.
    const matchingRelease = releases.find((r) => r.tag_name === latestTag)
    return {
      tag_name: latestTag,
      name: matchingRelease?.name || latestTag,
      body: matchingRelease?.body || '',
      html_url: matchingRelease?.html_url || `https://github.com/${REPO}/releases/tag/${latestTag}`,
      published_at: matchingRelease?.published_at || new Date().toISOString(),
      baseTag: latestTag,
      commitsAhead: 0,
    }
  }

  if (!stable) return null
  // Populate structured version fields so buildCacheEntry stores them.
  // A stable release IS the tag, so commitsAhead is always 0.
  const release = stable as unknown as Record<string, unknown>
  release.baseTag = stable.tag_name
  release.commitsAhead = 0
  return release
}

export function truncateNotes(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '\n\n… (truncated)'
}
