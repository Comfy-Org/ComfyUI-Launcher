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
    const sha = commit.sha.slice(0, 7)
    const date = commit.commit?.committer?.date
    const msg = commit.commit?.message?.split('\n')[0] ?? ''
    const stable = releases.find((r) => !r.draft && !r.prerelease)
    let label = sha
    if (stable) {
      try {
        const cmp = await fetchJSON(
          `https://api.github.com/repos/${REPO}/compare/${stable.tag_name}...master`
        ) as GitHubComparison
        const ahead = cmp.ahead_by
        label = ahead > 0
          ? `${stable.tag_name} + ${ahead} commit${ahead !== 1 ? 's' : ''} (${sha})`
          : stable.tag_name
      } catch {
        label = `${stable.tag_name}+ (${sha})`
      }
    }
    return {
      tag_name: sha,
      name: label,
      body: msg,
      html_url: commit.html_url,
      published_at: date,
      _commit: true,
    }
  }
  const releases = await fetchJSON(
    'https://api.github.com/repos/Comfy-Org/ComfyUI/releases?per_page=30'
  ) as GitHubRelease[]
  return (releases.find((r) => !r.draft && !r.prerelease) as Record<string, unknown> | undefined) ?? null
}

export function truncateNotes(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '\n\n… (truncated)'
}
