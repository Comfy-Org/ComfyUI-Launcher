import { execFile, spawn, type ExecFileException } from 'child_process'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { killProcTree } from './process'

let _pygit2Python: string | null = null
let _pygit2Script: string | null = null

export function configurePygit2(pythonPath: string, scriptPath: string): void {
  _pygit2Python = pythonPath
  _pygit2Script = scriptPath
}

export function isPygit2Configured(): boolean {
  return _pygit2Python !== null && _pygit2Script !== null
}

/**
 * Try to configure the pygit2 fallback using a standalone installation's
 * Python.  Validates that both the Python binary and the helper script
 * exist before calling {@link configurePygit2}.
 *
 * @returns `true` if pygit2 was successfully configured.
 */
export function tryConfigurePygit2Fallback(installPath: string): boolean {
  const pythonPath = process.platform === 'win32'
    ? path.join(installPath, 'standalone-env', 'python.exe')
    : path.join(installPath, 'standalone-env', 'bin', 'python3')
  if (!fs.existsSync(pythonPath)) return false
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'lib', 'git_operations.py')
    : path.join(__dirname, '..', '..', 'lib', 'git_operations.py')
  if (!fs.existsSync(scriptPath)) return false
  configurePygit2(pythonPath, scriptPath)
  return true
}

function runPygit2(args: string[], timeout: number = 5000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(_pygit2Python!, ['-s', '-u', _pygit2Script!, ...args], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout,
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (typeof (error as ExecFileException).code === 'number' ? ((error as ExecFileException).code as number) : 1) : 0,
        stdout: (stdout ?? '').toString(),
        stderr: (stderr ?? '').toString(),
      })
    })
  })
}

function makeRunPygit2(
  sendOutput: (text: string) => void,
  signal?: AbortSignal,
): (args: string[]) => Promise<ProcessResult> {
  return (args: string[]): Promise<ProcessResult> => {
    if (signal?.aborted) return Promise.resolve({ exitCode: 1, stderr: '', stdout: '' })
    return new Promise((resolve) => {
      const stdoutChunks: string[] = []
      const stderrChunks: string[] = []
      const proc = spawn(_pygit2Python!, ['-s', '-u', _pygit2Script!, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      })
      const onAbort = (): void => { killProcTree(proc) }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString()
        stdoutChunks.push(text)
        sendOutput(text)
      })
      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString()
        stderrChunks.push(text)
        sendOutput(text)
      })
      proc.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort)
        sendOutput(err.message)
        resolve({ exitCode: 1, stderr: stderrChunks.join('') + err.message, stdout: stdoutChunks.join('') })
      })
      proc.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        resolve({ exitCode: code ?? 1, stderr: stderrChunks.join(''), stdout: stdoutChunks.join('') })
      })
    })
  }
}

export interface ProcessResult {
  exitCode: number
  stderr: string
  stdout: string
}

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

/**
 * Count how many commits HEAD is ahead of a tag.  Runs `git rev-list --count`
 * asynchronously (local operation, no network).  Returns undefined if git is
 * unavailable, the tag doesn't exist, or any error occurs.
 */
export function countCommitsAhead(repoPath: string, tag: string, commit: string = 'HEAD'): Promise<number | undefined> {
  if (isPygit2Configured()) {
    return runPygit2(['rev-list-count', repoPath, tag, commit]).then(({ exitCode, stdout }) => {
      if (exitCode !== 0) return undefined
      const n = parseInt(stdout.trim(), 10)
      return Number.isFinite(n) ? n : undefined
    })
  }
  return new Promise((resolve) => {
    execFile('git', ['rev-list', '--count', `${tag}..${commit}`], {
      cwd: repoPath,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 1000,
    }, (error, stdout) => {
      if (error) { resolve(undefined); return }
      const n = parseInt(stdout.trim(), 10)
      resolve(Number.isFinite(n) ? n : undefined)
    })
  })
}

/**
 * Find the nearest ancestor tag reachable from HEAD.  Runs `git describe`
 * asynchronously (local operation, no network).  Returns undefined if git is
 * unavailable, no tags exist, or any error occurs.
 */
export function findNearestTag(repoPath: string, commit: string = 'HEAD'): Promise<string | undefined> {
  if (isPygit2Configured()) {
    return runPygit2(['describe-tags', repoPath, commit]).then(({ exitCode, stdout }) => {
      if (exitCode !== 0) return undefined
      const tag = stdout.trim()
      return tag || undefined
    })
  }
  return new Promise((resolve) => {
    execFile('git', ['describe', '--tags', '--abbrev=0', commit], {
      cwd: repoPath,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 1000,
    }, (error, stdout) => {
      if (error) { resolve(undefined); return }
      const tag = stdout.trim()
      resolve(tag || undefined)
    })
  })
}

/**
 * Find the highest version tag in the repository.  Runs `git tag` with
 * version-sort, so it includes tags on release branches that are not
 * ancestors of HEAD.  This is a display heuristic — the result may refer
 * to a tag whose commit is on a different branch.  Callers should verify
 * ancestry (via {@link isAncestorOf}) before using it as a base tag.
 * Returns undefined if git is unavailable, no `v*` tags exist, or any
 * error occurs.
 */
export function findLatestVersionTag(repoPath: string): Promise<string | undefined> {
  if (isPygit2Configured()) {
    return runPygit2(['tag-list', repoPath]).then(({ exitCode, stdout }) => {
      if (exitCode !== 0) return undefined
      const tag = stdout.trim().split('\n')[0]?.trim()
      return tag || undefined
    })
  }
  return new Promise((resolve) => {
    execFile('git', ['tag', '-l', 'v*', '--sort=-v:refname'], {
      cwd: repoPath,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 1000,
    }, (error, stdout) => {
      if (error) { resolve(undefined); return }
      const tag = stdout.trim().split('\n')[0]?.trim()
      resolve(tag || undefined)
    })
  })
}

/**
 * Count commits reachable from `ref1` that have no cherry-pick equivalent
 * (matched by patch-id) reachable from `ref2`.  Runs
 * `git rev-list --count --cherry-pick --left-only ref1...ref2`
 * (local, no network).  Returns undefined on error.
 *
 * Useful for backport detection: when a release branch cherry-picks commits
 * from master, this counts only the commits unique to the release branch
 * (typically just the version bump).
 */
export function countUniqueCommits(repoPath: string, ref1: string, ref2: string): Promise<number | undefined> {
  if (isPygit2Configured()) {
    return runPygit2(['cherry-pick-count', repoPath, ref1, ref2], 5000).then(({ exitCode, stdout }) => {
      if (exitCode !== 0) return undefined
      const n = parseInt(stdout.trim(), 10)
      return Number.isFinite(n) ? n : undefined
    })
  }
  return new Promise((resolve) => {
    execFile('git', ['rev-list', '--count', '--cherry-pick', '--left-only', `${ref1}...${ref2}`], {
      cwd: repoPath,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000,
    }, (error, stdout) => {
      if (error) { resolve(undefined); return }
      const n = parseInt(stdout.trim(), 10)
      resolve(Number.isFinite(n) ? n : undefined)
    })
  })
}

/**
 * Check whether `ancestor` is an ancestor of `descendant` in the commit
 * graph.  Runs `git merge-base --is-ancestor` (local, no network).
 * Returns true if ancestor is reachable from descendant, false otherwise
 * (including on error).
 */
export function isAncestorOf(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  if (isPygit2Configured()) {
    return runPygit2(['is-ancestor', repoPath, ancestor, descendant]).then(({ exitCode }) => {
      return exitCode === 0
    })
  }
  return new Promise((resolve) => {
    execFile('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repoPath,
      windowsHide: true,
      timeout: 1000,
    }, (error) => {
      resolve(!error)
    })
  })
}

/**
 * Find the merge-base (common ancestor) of two refs.  Runs `git merge-base`
 * (local, no network).  Returns the SHA on success, undefined on error
 * (e.g. if either ref is missing from the object store).
 */
export function findMergeBase(repoPath: string, ref1: string, ref2: string): Promise<string | undefined> {
  if (isPygit2Configured()) {
    return runPygit2(['merge-base', repoPath, ref1, ref2]).then(({ exitCode, stdout }) => {
      if (exitCode !== 0) return undefined
      const sha = stdout.trim()
      return sha || undefined
    })
  }
  return new Promise((resolve) => {
    execFile('git', ['merge-base', ref1, ref2], {
      cwd: repoPath,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 1000,
    }, (error, stdout) => {
      if (error) { resolve(undefined); return }
      const sha = stdout.trim()
      resolve(sha || undefined)
    })
  })
}

/**
 * Resolve a ref (tag name, branch, etc.) to its full SHA.  Runs `git rev-parse`
 * asynchronously (local operation, no network).  Returns the SHA on success,
 * undefined on error.
 */
export function revParseRef(repoPath: string, ref: string): Promise<string | undefined> {
  if (isPygit2Configured()) {
    return runPygit2(['rev-parse', repoPath, ref]).then(({ exitCode, stdout }) => {
      if (exitCode !== 0) return undefined
      const sha = stdout.trim()
      return sha || undefined
    })
  }
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', ref], {
      cwd: repoPath,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 1000,
    }, (error, stdout) => {
      if (error) { resolve(undefined); return }
      const sha = stdout.trim()
      resolve(sha || undefined)
    })
  })
}

/**
 * Fetch all tags from the remote, unshallowing if needed so that
 * cherry-pick–aware version resolution has the full commit graph.
 * Tries `git fetch --unshallow origin --tags` first; falls back to
 * `git fetch origin --tags` when the repo is already complete or
 * unshallowing fails (e.g. network issues).
 * Returns true if at least the tag fetch succeeded, false otherwise.
 */
export function fetchTags(repoPath: string): Promise<boolean> {
  if (isPygit2Configured()) {
    return runPygit2(['fetch-tags', repoPath], 15000).then(({ exitCode }) => {
      return exitCode === 0
    })
  }
  return new Promise((resolve) => {
    execFile('git', ['fetch', '--unshallow', 'origin', '--tags'], {
      cwd: repoPath,
      windowsHide: true,
      timeout: 15000,
    }, (error) => {
      if (!error) { resolve(true); return }
      // Unshallow fails when the repo is already complete or on network
      // error — retry without --unshallow so tags still get fetched.
      execFile('git', ['fetch', 'origin', '--tags'], {
        cwd: repoPath,
        windowsHide: true,
        timeout: 15000,
      }, (error2) => {
        resolve(!error2)
      })
    })
  })
}

/** Check whether a path has a .git directory or file (worktree/submodule). */
export function hasGitDir(nodePath: string): boolean {
  return resolveGitDir(nodePath) !== null
}

let _gitAvailableCache: boolean | null = null

export function isGitAvailable(): Promise<boolean> {
  if (isPygit2Configured()) return Promise.resolve(true)
  if (_gitAvailableCache !== null) return Promise.resolve(_gitAvailableCache)
  return new Promise((resolve) => {
    execFile('git', ['--version'], { windowsHide: true, timeout: 5000 }, (error) => {
      _gitAvailableCache = !error
      resolve(_gitAvailableCache)
    })
  })
}

/** Reset the cached result of {@link isGitAvailable} (for tests). */
export function resetGitAvailableCache(): void {
  _gitAvailableCache = null
}

export function gitClone(
  url: string,
  dest: string,
  sendOutput: (text: string) => void,
  signal?: AbortSignal
): Promise<ProcessResult> {
  if (signal?.aborted) return Promise.resolve({ exitCode: 1, stderr: '', stdout: '' })
  if (isPygit2Configured()) {
    const runPygit2Spawn = makeRunPygit2(sendOutput, signal)
    return runPygit2Spawn(['clone', url, dest])
  }
  return new Promise((resolve) => {
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    const proc = spawn('git', ['clone', url, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    const onAbort = (): void => { killProcTree(proc) }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      stdoutChunks.push(text)
      sendOutput(text)
    })
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      stderrChunks.push(text)
      sendOutput(text)
    })
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      sendOutput(err.message)
      resolve({ exitCode: 1, stderr: stderrChunks.join('') + err.message, stdout: stdoutChunks.join('') })
    })
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode: code ?? 1, stderr: stderrChunks.join(''), stdout: stdoutChunks.join('') })
    })
  })
}

function makeRunGit(
  repoPath: string,
  sendOutput: (text: string) => void,
  signal?: AbortSignal,
): (args: string[]) => Promise<ProcessResult> {
  return (args: string[]): Promise<ProcessResult> => {
    if (signal?.aborted) return Promise.resolve({ exitCode: 1, stderr: '', stdout: '' })
    return new Promise((resolve) => {
      const stdoutChunks: string[] = []
      const stderrChunks: string[] = []
      const proc = spawn('git', args, {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      })
      const onAbort = (): void => { killProcTree(proc) }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString()
        stdoutChunks.push(text)
        sendOutput(text)
      })
      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString()
        stderrChunks.push(text)
        sendOutput(text)
      })
      proc.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort)
        sendOutput(err.message)
        resolve({ exitCode: 1, stderr: stderrChunks.join('') + err.message, stdout: stdoutChunks.join('') })
      })
      proc.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        resolve({ exitCode: code ?? 1, stderr: stderrChunks.join(''), stdout: stdoutChunks.join('') })
      })
    })
  }
}

/**
 * Check out a specific commit. Tries a direct checkout first (works for
 * full clones where the commit is already local). If the commit isn't
 * available, fetches all refs from origin (unshallowing if needed) and
 * retries.
 */
export function gitCheckoutCommit(
  repoPath: string,
  commit: string,
  sendOutput: (text: string) => void,
  signal?: AbortSignal
): Promise<ProcessResult> {
  if (signal?.aborted) return Promise.resolve({ exitCode: 1, stderr: '', stdout: '' })
  if (isPygit2Configured()) {
    const runPygit2Spawn = makeRunPygit2(sendOutput, signal)
    return runPygit2Spawn(['checkout', repoPath, commit])
  }
  const runGit = makeRunGit(repoPath, sendOutput, signal)

  return runGit(['checkout', commit]).then((directResult) => {
    if (directResult.exitCode === 0) return directResult
    return runGit(['fetch', '--unshallow', 'origin']).then((result) => {
      if (result.exitCode !== 0) return runGit(['fetch', 'origin'])
      return result
    }).then((fetchResult) => {
      if (fetchResult.exitCode !== 0) return fetchResult
      return runGit(['checkout', commit])
    })
  })
}

/**
 * Fetch the master branch from origin and check out a specific commit.
 * Designed for the ComfyUI main repo where master must exist locally
 * (mirroring update_comfyui.py behaviour).
 */
export function gitFetchAndCheckout(
  repoPath: string,
  commit: string,
  sendOutput: (text: string) => void,
  signal?: AbortSignal
): Promise<ProcessResult> {
  if (signal?.aborted) return Promise.resolve({ exitCode: 1, stderr: '', stdout: '' })
  if (isPygit2Configured()) {
    const runPygit2Spawn = makeRunPygit2(sendOutput, signal)
    return runPygit2Spawn(['fetch-and-checkout', repoPath, commit])
  }
  const runGit = makeRunGit(repoPath, sendOutput, signal)

  // Fetch master explicitly — grafted/archive-based repos may have no
  // branch tracking configured, so a bare `git fetch origin` only pulls
  // tags. Use --unshallow to handle shallow clones; fall back to a
  // regular fetch if the repo is already complete.
  const refspec = '+refs/heads/master:refs/remotes/origin/master'
  return runGit(['fetch', '--unshallow', '--tags', 'origin', refspec]).then((result) => {
    if (result.exitCode !== 0) return runGit(['fetch', '--tags', 'origin', refspec])
    return result
  }).then((result) => {
    if (result.exitCode !== 0) return result
    // Ensure a local master branch exists (mirroring the pygit2 update
    // script) so future updates via update_comfyui.py work correctly.
    // Detach HEAD first so `branch -f` can't fail due to master being
    // the currently checked-out branch.
    return runGit(['checkout', '--detach', 'HEAD']).then(() => {
      // Detach may fail if HEAD is invalid (fresh archive with no commits
      // checked out); that's fine — branch -f will still succeed.
      return runGit(['branch', '-f', 'master', 'refs/remotes/origin/master'])
    }).then((branchResult) => {
      if (branchResult.exitCode !== 0) return branchResult
      return runGit(['checkout', commit])
    })
  })
}
