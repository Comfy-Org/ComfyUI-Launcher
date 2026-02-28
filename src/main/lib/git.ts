import fs from 'fs'
import path from 'path'

/**
 * Resolve the actual .git directory for a repository.
 * Handles worktrees/submodules where .git is a file containing "gitdir: <path>".
 */
export function resolveGitDir(repoPath: string): string | null {
  const dotGit = path.join(repoPath, '.git')
  try {
    const st = fs.statSync(dotGit)
    if (st.isDirectory()) return dotGit
    if (st.isFile()) {
      const content = fs.readFileSync(dotGit, 'utf-8')
      const m = content.match(/^gitdir:\s*(.+)\s*$/m)
      if (m) return path.resolve(repoPath, m[1]!.trim())
    }
  } catch {}
  return null
}

export function readGitHead(repoPath: string): string | null {
  const gitDir = resolveGitDir(repoPath)
  if (!gitDir) return null
  const headPath = path.join(gitDir, 'HEAD')
  try {
    const content = fs.readFileSync(headPath, 'utf-8').trim()
    // Detached HEAD — contains sha directly
    if (!content.startsWith('ref: ')) return content || null
    // Symbolic ref — resolve it
    const refPath = path.join(gitDir, content.slice(5))
    try {
      return fs.readFileSync(refPath, 'utf-8').trim() || null
    } catch {
      // Try packed-refs as fallback
      const packedRefsPath = path.join(gitDir, 'packed-refs')
      try {
        const packed = fs.readFileSync(packedRefsPath, 'utf-8')
        const ref = content.slice(5)
        for (const line of packed.split('\n')) {
          if (line.startsWith('#') || !line.trim()) continue
          const [sha, name] = line.trim().split(/\s+/)
          if (name === ref) return sha || null
        }
      } catch {}
      return null
    }
  } catch {
    return null
  }
}

export function readGitRemoteUrl(repoPath: string): string | null {
  const gitDir = resolveGitDir(repoPath)
  if (!gitDir) return null
  const configPath = path.join(gitDir, 'config')
  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    const match = content.match(/\[remote "origin"\][^[]*?url\s*=\s*(.+)/m)
    if (!match) return null
    return redactUrl(match[1]!.trim())
  } catch {
    return null
  }
}

/** Strip embedded credentials from git remote URLs. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) {
      parsed.username = ''
      parsed.password = ''
    }
    return parsed.toString()
  } catch {
    // Non-standard URL (e.g. git@github.com:...) — strip user:pass@ if present
    return url.replace(/\/\/[^/@]+@/, '//')
  }
}

/** Check whether a path has a .git directory or file (worktree/submodule). */
export function hasGitDir(nodePath: string): boolean {
  return resolveGitDir(nodePath) !== null
}
