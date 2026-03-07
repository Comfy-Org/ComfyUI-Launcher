import { execFile, spawn } from 'child_process'
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
    const refPath = path.resolve(gitDir, content.slice(5))
    if (!refPath.startsWith(gitDir + path.sep) && refPath !== gitDir) return null
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

export function isGitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { windowsHide: true, timeout: 5000 }, (error) => {
      resolve(!error)
    })
  })
}

export function gitClone(
  url: string,
  dest: string,
  sendOutput: (text: string) => void
): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['clone', url, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    proc.stdout.on('data', (data: Buffer) => sendOutput(data.toString()))
    proc.stderr.on('data', (data: Buffer) => sendOutput(data.toString()))
    proc.on('error', (err) => {
      sendOutput(err.message)
      resolve(1)
    })
    proc.on('close', (code) => resolve(code ?? 1))
  })
}

export function gitFetchAndCheckout(
  repoPath: string,
  commit: string,
  sendOutput: (text: string) => void
): Promise<number> {
  const runGit = (args: string[]): Promise<number> =>
    new Promise((resolve) => {
      const proc = spawn('git', args, {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      proc.stdout.on('data', (data: Buffer) => sendOutput(data.toString()))
      proc.stderr.on('data', (data: Buffer) => sendOutput(data.toString()))
      proc.on('error', (err) => {
        sendOutput(err.message)
        resolve(1)
      })
      proc.on('close', (code) => resolve(code ?? 1))
    })

  // Fetch master explicitly — grafted/archive-based repos may have no
  // branch tracking configured, so a bare `git fetch origin` only pulls
  // tags. Use --unshallow to handle shallow clones; fall back to a
  // regular fetch if the repo is already complete.
  const refspec = '+refs/heads/master:refs/remotes/origin/master'
  return runGit(['fetch', '--unshallow', 'origin', refspec]).then((code) => {
    if (code !== 0) return runGit(['fetch', 'origin', refspec])
    return code
  }).then((code) => {
    if (code !== 0) return code
    // Ensure a local master branch exists (mirroring the pygit2 update
    // script) so future updates via update_comfyui.py work correctly.
    // Detach HEAD first so `branch -f` can't fail due to master being
    // the currently checked-out branch.
    return runGit(['checkout', '--detach', 'HEAD']).then(() => {
      // Detach may fail if HEAD is invalid (fresh archive with no commits
      // checked out); that's fine — branch -f will still succeed.
      return runGit(['branch', '-f', 'master', 'refs/remotes/origin/master'])
    }).then((branchCode) => {
      if (branchCode !== 0) return branchCode
      return runGit(['checkout', commit])
    })
  })
}
