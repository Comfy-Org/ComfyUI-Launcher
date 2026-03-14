import { fetchJSON } from './fetch'

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
  draft: boolean
  prerelease: boolean
}

interface GitHubComparison {
  ahead_by: number
}

export async function fetchLatestRelease(
  channel: string
): Promise<Record<string, unknown> | null> {
  if (channel === 'latest') {
    const REPO = 'Comfy-Org/ComfyUI'
    const [commit, releases] = await Promise.all([
      fetchJSON(`https://api.github.com/repos/${REPO}/commits/master`) as Promise<GitHubCommit | null>,
      (fetchJSON(`https://api.github.com/repos/${REPO}/releases?per_page=10`) as Promise<GitHubRelease[]>)
        .catch(() => [] as GitHubRelease[]),
    ])
    if (!commit) return null
    const date = commit.commit?.committer?.date
    const msg = commit.commit?.message?.split('\n')[0] ?? ''
    const stable = releases.find((r) => !r.draft && !r.prerelease)
    let baseTag: string | undefined
    let commitsAhead: number | undefined
    if (stable) {
      baseTag = stable.tag_name
      try {
        const cmp = await fetchJSON(
          `https://api.github.com/repos/${REPO}/compare/${stable.tag_name}...master`
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
  const releases = await fetchJSON(
    'https://api.github.com/repos/Comfy-Org/ComfyUI/releases?per_page=30'
  ) as GitHubRelease[]
  const stable = releases.find((r) => !r.draft && !r.prerelease)
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
