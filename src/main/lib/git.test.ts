// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, execFile: vi.fn(), spawn: vi.fn() }
})

import { execFile, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { countCommitsAhead, findNearestTag, findLatestVersionTag, isAncestorOf, findMergeBase, revParseRef, fetchTags, configurePygit2, isGitAvailable, resetGitAvailableCache, countUniqueCommits, gitClone, gitCheckoutCommit, gitFetchAndCheckout } from './git'

const mockedExecFile = vi.mocked(execFile)
const mockedSpawn = vi.mocked(spawn)

function mockExecFile(cb: (cmd: string, args: string[], opts: Record<string, unknown>, callback: (err: Error | null, stdout: string, stderr: string) => void) => void): void {
  mockedExecFile.mockImplementation(cb as never)
}

/** Create a fake ChildProcess that emits close with the given code. */
function createFakeProc(exitCode: number, stdout = '', stderr = ''): ReturnType<typeof spawn> {
  const proc = new EventEmitter() as ReturnType<typeof spawn>
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  Object.assign(proc, { stdout: stdoutEmitter, stderr: stderrEmitter, pid: 12345 })
  process.nextTick(() => {
    if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout))
    if (stderr) stderrEmitter.emit('data', Buffer.from(stderr))
    proc.emit('close', exitCode)
  })
  return proc
}

function mockSpawn(exitCode: number, stdout = '', stderr = ''): void {
  mockedSpawn.mockReturnValue(createFakeProc(exitCode, stdout, stderr))
}

/** Mock spawn to succeed on the Nth call (0-indexed) and fail others. */
function mockSpawnSequence(results: Array<{ exitCode: number; stdout?: string; stderr?: string }>): void {
  let callIdx = 0
  mockedSpawn.mockImplementation((() => {
    const r = results[callIdx] ?? { exitCode: 1 }
    callIdx++
    return createFakeProc(r.exitCode, r.stdout ?? '', r.stderr ?? '')
  }) as never)
}

describe('countCommitsAhead', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns the count when git succeeds', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '21\n', '') })
    expect(await countCommitsAhead('/repo', 'v0.14.2')).toBe(21)
  })

  it('returns 0 when on the tag exactly', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '0\n', '') })
    expect(await countCommitsAhead('/repo', 'v0.14.2')).toBe(0)
  })

  it('returns undefined when git fails', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(new Error('not found'), '', '') })
    expect(await countCommitsAhead('/repo', 'v0.14.2')).toBeUndefined()
  })

  it('returns undefined for non-numeric output', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'bad\n', '') })
    expect(await countCommitsAhead('/repo', 'v0.14.2')).toBeUndefined()
  })
})

describe('findNearestTag', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns the tag when git describe succeeds', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'v0.17.0\n', '') })
    expect(await findNearestTag('/repo')).toBe('v0.17.0')
  })

  it('returns undefined when git fails', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(new Error('no tags'), '', '') })
    expect(await findNearestTag('/repo')).toBeUndefined()
  })

  it('returns undefined for empty output', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '\n', '') })
    expect(await findNearestTag('/repo')).toBeUndefined()
  })
})

describe('findLatestVersionTag', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns the first tag from version-sorted output', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'v0.17.1\nv0.17.0\nv0.16.4\n', '') })
    expect(await findLatestVersionTag('/repo')).toBe('v0.17.1')
  })

  it('returns the tag when only one exists', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'v0.17.1\n', '') })
    expect(await findLatestVersionTag('/repo')).toBe('v0.17.1')
  })

  it('returns undefined when git fails', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(new Error('no tags'), '', '') })
    expect(await findLatestVersionTag('/repo')).toBeUndefined()
  })

  it('returns undefined for empty output', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '\n', '') })
    expect(await findLatestVersionTag('/repo')).toBeUndefined()
  })
})

describe('isAncestorOf', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns true when git exits with 0', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '', '') })
    expect(await isAncestorOf('/repo', 'v0.17.0', 'v0.17.1')).toBe(true)
  })

  it('returns false when git exits with error', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(new Error('not ancestor'), '', '') })
    expect(await isAncestorOf('/repo', 'v0.18.0', 'v0.17.1')).toBe(false)
  })
})

describe('findMergeBase', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns SHA when git succeeds', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'abc123def456\n', '') })
    expect(await findMergeBase('/repo', 'v0.17.0', 'HEAD')).toBe('abc123def456')
  })

  it('returns undefined when git fails', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(new Error('no merge base'), '', '') })
    expect(await findMergeBase('/repo', 'v0.17.0', 'HEAD')).toBeUndefined()
  })
})

describe('revParseRef', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns SHA when git succeeds', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'abc123def\n', '') })
    expect(await revParseRef('/repo', 'v0.17.0')).toBe('abc123def')
  })

  it('returns undefined when git fails', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(new Error('bad ref'), '', '') })
    expect(await revParseRef('/repo', 'nonexistent')).toBeUndefined()
  })
})

describe('fetchTags', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns true when git exits with 0', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '', '') })
    expect(await fetchTags('/repo')).toBe(true)
  })

  it('returns false when git exits with error', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(new Error('network error'), '', '') })
    expect(await fetchTags('/repo')).toBe(false)
  })
})

describe('isGitAvailable (system git)', () => {
  beforeEach(() => { vi.resetAllMocks(); resetGitAvailableCache() })

  it('returns true when git --version succeeds', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'git version 2.40.0\n', '') })
    expect(await isGitAvailable()).toBe(true)
  })

  it('returns false when git is not found', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(new Error('ENOENT'), '', '') })
    expect(await isGitAvailable()).toBe(false)
  })
})

describe('countUniqueCommits (system git)', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns the count when git succeeds', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '3\n', '') })
    expect(await countUniqueCommits('/repo', 'v0.17.0', 'v0.17.1')).toBe(3)
  })

  it('returns 0 when no unique commits', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '0\n', '') })
    expect(await countUniqueCommits('/repo', 'v0.17.0', 'v0.17.1')).toBe(0)
  })

  it('returns undefined when git fails', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(new Error('fail'), '', '') })
    expect(await countUniqueCommits('/repo', 'v0.17.0', 'v0.17.1')).toBeUndefined()
  })

  it('returns undefined for non-numeric output', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'bad\n', '') })
    expect(await countUniqueCommits('/repo', 'v0.17.0', 'v0.17.1')).toBeUndefined()
  })
})

// ===================================================================
// System git — spawn-based functions
// ===================================================================

describe('gitClone (system git)', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns exitCode 0 on success', async () => {
    mockSpawn(0, '', 'Cloning into...\n')
    const output: string[] = []
    const result = await gitClone('https://github.com/test/repo', '/dest', (t) => output.push(t))
    expect(result.exitCode).toBe(0)
    expect(mockedSpawn).toHaveBeenCalledWith('git', ['clone', 'https://github.com/test/repo', '/dest'], expect.anything())
  })

  it('returns exitCode 1 on failure', async () => {
    mockSpawn(128, '', 'fatal: repo not found\n')
    const result = await gitClone('https://github.com/test/repo', '/dest', () => {})
    expect(result.exitCode).toBe(128)
    expect(result.stderr).toContain('fatal')
  })

  it('forwards output to sendOutput callback', async () => {
    mockSpawn(0, 'progress\n', '')
    const output: string[] = []
    await gitClone('https://github.com/test/repo', '/dest', (t) => output.push(t))
    expect(output).toContain('progress\n')
  })

  it('returns immediately when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await gitClone('https://github.com/test/repo', '/dest', () => {}, controller.signal)
    expect(result.exitCode).toBe(1)
    expect(mockedSpawn).not.toHaveBeenCalled()
  })
})

describe('gitCheckoutCommit (system git)', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns exitCode 0 when direct checkout succeeds', async () => {
    mockSpawn(0)
    const result = await gitCheckoutCommit('/repo', 'abc123', () => {})
    expect(result.exitCode).toBe(0)
    // First spawn call should be checkout
    expect(mockedSpawn.mock.calls[0]![1]).toEqual(['checkout', 'abc123'])
  })

  it('fetches and retries when direct checkout fails', async () => {
    mockSpawnSequence([
      { exitCode: 1, stderr: 'error: pathspec' },  // checkout fails
      { exitCode: 0 },                              // fetch --unshallow succeeds
      { exitCode: 0 },                              // retry checkout succeeds
    ])
    const result = await gitCheckoutCommit('/repo', 'abc123', () => {})
    expect(result.exitCode).toBe(0)
    expect(mockedSpawn).toHaveBeenCalledTimes(3)
  })

  it('returns immediately when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await gitCheckoutCommit('/repo', 'abc123', () => {}, controller.signal)
    expect(result.exitCode).toBe(1)
    expect(mockedSpawn).not.toHaveBeenCalled()
  })
})

describe('gitFetchAndCheckout (system git)', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('fetches master, creates branch, and checks out commit', async () => {
    mockSpawnSequence([
      { exitCode: 0 },  // fetch --unshallow --tags origin refspec
      { exitCode: 0 },  // checkout --detach HEAD
      { exitCode: 0 },  // branch -f master
      { exitCode: 0 },  // checkout commit
    ])
    const result = await gitFetchAndCheckout('/repo', 'abc123', () => {})
    expect(result.exitCode).toBe(0)
    expect(mockedSpawn).toHaveBeenCalledTimes(4)
  })

  it('falls back to regular fetch when unshallow fails', async () => {
    mockSpawnSequence([
      { exitCode: 1 },  // fetch --unshallow fails
      { exitCode: 0 },  // fetch (no --unshallow) succeeds
      { exitCode: 0 },  // checkout --detach HEAD
      { exitCode: 0 },  // branch -f master
      { exitCode: 0 },  // checkout commit
    ])
    const result = await gitFetchAndCheckout('/repo', 'abc123', () => {})
    expect(result.exitCode).toBe(0)
    expect(mockedSpawn).toHaveBeenCalledTimes(5)
  })

  it('returns immediately when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await gitFetchAndCheckout('/repo', 'abc123', () => {}, controller.signal)
    expect(result.exitCode).toBe(1)
    expect(mockedSpawn).not.toHaveBeenCalled()
  })
})

// ===================================================================
// pygit2 fallback tests
//
// When configurePygit2() is called, every function routes through
// execFile(pythonPath, ['-s', '-u', scriptPath, subcmd, ...]) instead
// of execFile('git', [...]).  The tests below verify that:
//   1. The correct subcommand and args are passed to the Python script
//   2. The output is parsed identically to the system-git path
// ===================================================================

describe('pygit2 fallback', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    configurePygit2('/usr/bin/python3', '/path/to/git_operations.py')
  })

  /** Assert that execFile was called with our Python + script, and extract the subcommand args. */
  function expectPygit2Call(): string[] {
    expect(mockedExecFile).toHaveBeenCalled()
    const call = mockedExecFile.mock.calls[0]!
    const cmd = call[0] as string
    const args = call[1] as string[]
    expect(cmd).toBe('/usr/bin/python3')
    expect(args[0]).toBe('-s')
    expect(args[1]).toBe('-u')
    expect(args[2]).toBe('/path/to/git_operations.py')
    return args.slice(3) // subcommand + args
  }

  describe('isGitAvailable', () => {
    it('returns true when pygit2 is configured', async () => {
      expect(await isGitAvailable()).toBe(true)
    })
  })

  describe('countCommitsAhead', () => {
    it('passes correct subcommand and parses count', async () => {
      mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '21\n', '') })
      expect(await countCommitsAhead('/repo', 'v0.14.2')).toBe(21)
      const args = expectPygit2Call()
      expect(args).toEqual(['rev-list-count', '/repo', 'v0.14.2', 'HEAD'])
    })

    it('returns 0 when on the tag exactly', async () => {
      mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '0\n', '') })
      expect(await countCommitsAhead('/repo', 'v0.14.2')).toBe(0)
    })

    it('returns undefined on error', async () => {
      const errWithCode = new Error('fail') as Error & { code: number }
      errWithCode.code = 1
      mockExecFile((_cmd, _args, _opts, cb) => { cb(errWithCode, '', '') })
      expect(await countCommitsAhead('/repo', 'v0.14.2')).toBeUndefined()
    })

    it('passes custom commit ref', async () => {
      mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '5\n', '') })
      expect(await countCommitsAhead('/repo', 'v0.14.2', 'abc123')).toBe(5)
      const args = expectPygit2Call()
      expect(args).toEqual(['rev-list-count', '/repo', 'v0.14.2', 'abc123'])
    })
  })

  describe('findNearestTag', () => {
    it('passes correct subcommand and parses tag', async () => {
      mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'v0.17.0\n', '') })
      expect(await findNearestTag('/repo')).toBe('v0.17.0')
      const args = expectPygit2Call()
      expect(args).toEqual(['describe-tags', '/repo', 'HEAD'])
    })

    it('returns undefined on error', async () => {
      const errWithCode = new Error('no tags') as Error & { code: number }
      errWithCode.code = 1
      mockExecFile((_cmd, _args, _opts, cb) => { cb(errWithCode, '', '') })
      expect(await findNearestTag('/repo')).toBeUndefined()
    })

    it('returns undefined for empty output', async () => {
      mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '\n', '') })
      expect(await findNearestTag('/repo')).toBeUndefined()
    })
  })

  describe('findLatestVersionTag', () => {
    it('passes correct subcommand and parses first tag', async () => {
      mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'v0.17.1\nv0.17.0\nv0.16.4\n', '') })
      expect(await findLatestVersionTag('/repo')).toBe('v0.17.1')
      const args = expectPygit2Call()
      expect(args).toEqual(['tag-list', '/repo'])
    })

    it('returns undefined on error', async () => {
      const errWithCode = new Error('fail') as Error & { code: number }
      errWithCode.code = 1
      mockExecFile((_cmd, _args, _opts, cb) => { cb(errWithCode, '', '') })
      expect(await findLatestVersionTag('/repo')).toBeUndefined()
    })

    it('returns undefined for empty output', async () => {
      mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '\n', '') })
      expect(await findLatestVersionTag('/repo')).toBeUndefined()
    })
  })

  describe('countUniqueCommits', () => {
    it('passes correct subcommand and parses count', async () => {
      mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '3\n', '') })
      expect(await countUniqueCommits('/repo', 'v0.17.0', 'v0.17.1')).toBe(3)
      const args = expectPygit2Call()
      expect(args).toEqual(['cherry-pick-count', '/repo', 'v0.17.0', 'v0.17.1'])
    })

    it('returns undefined on error', async () => {
      const errWithCode = new Error('fail') as Error & { code: number }
      errWithCode.code = 1
      mockExecFile((_cmd, _args, _opts, cb) => { cb(errWithCode, '', '') })
      expect(await countUniqueCommits('/repo', 'v0.17.0', 'v0.17.1')).toBeUndefined()
    })
  })

  describe('isAncestorOf', () => {
    it('returns true when script exits with 0', async () => {
      mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '', '') })
      expect(await isAncestorOf('/repo', 'v0.17.0', 'v0.17.1')).toBe(true)
      const args = expectPygit2Call()
      expect(args).toEqual(['is-ancestor', '/repo', 'v0.17.0', 'v0.17.1'])
    })

    it('returns false when script exits with error', async () => {
      const errWithCode = new Error('not ancestor') as Error & { code: number }
      errWithCode.code = 1
      mockExecFile((_cmd, _args, _opts, cb) => { cb(errWithCode, '', '') })
      expect(await isAncestorOf('/repo', 'v0.18.0', 'v0.17.1')).toBe(false)
    })
  })

  describe('findMergeBase', () => {
    it('returns SHA when script succeeds', async () => {
      mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'abc123def456\n', '') })
      expect(await findMergeBase('/repo', 'v0.17.0', 'HEAD')).toBe('abc123def456')
      const args = expectPygit2Call()
      expect(args).toEqual(['merge-base', '/repo', 'v0.17.0', 'HEAD'])
    })

    it('returns undefined on error', async () => {
      const errWithCode = new Error('no merge base') as Error & { code: number }
      errWithCode.code = 1
      mockExecFile((_cmd, _args, _opts, cb) => { cb(errWithCode, '', '') })
      expect(await findMergeBase('/repo', 'v0.17.0', 'HEAD')).toBeUndefined()
    })
  })

  describe('revParseRef', () => {
    it('returns SHA when script succeeds', async () => {
      mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'abc123def\n', '') })
      expect(await revParseRef('/repo', 'v0.17.0')).toBe('abc123def')
      const args = expectPygit2Call()
      expect(args).toEqual(['rev-parse', '/repo', 'v0.17.0'])
    })

    it('returns undefined on error', async () => {
      const errWithCode = new Error('bad ref') as Error & { code: number }
      errWithCode.code = 1
      mockExecFile((_cmd, _args, _opts, cb) => { cb(errWithCode, '', '') })
      expect(await revParseRef('/repo', 'nonexistent')).toBeUndefined()
    })
  })

  describe('fetchTags', () => {
    it('returns true when script succeeds', async () => {
      mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '', '') })
      expect(await fetchTags('/repo')).toBe(true)
      const args = expectPygit2Call()
      expect(args).toEqual(['fetch-tags', '/repo'])
    })

    it('returns false on error', async () => {
      const errWithCode = new Error('network error') as Error & { code: number }
      errWithCode.code = 1
      mockExecFile((_cmd, _args, _opts, cb) => { cb(errWithCode, '', '') })
      expect(await fetchTags('/repo')).toBe(false)
    })
  })

  // --- spawn-based pygit2 functions ---

  /** Assert spawn was called with Python + script and extract the subcommand args. */
  function expectPygit2SpawnCall(callIndex = 0): string[] {
    expect(mockedSpawn.mock.calls.length).toBeGreaterThan(callIndex)
    const call = mockedSpawn.mock.calls[callIndex]!
    const cmd = call[0] as string
    const args = call[1] as string[]
    expect(cmd).toBe('/usr/bin/python3')
    expect(args[0]).toBe('-s')
    expect(args[1]).toBe('-u')
    expect(args[2]).toBe('/path/to/git_operations.py')
    return args.slice(3)
  }

  describe('gitClone', () => {
    it('passes correct subcommand and returns exitCode 0', async () => {
      mockSpawn(0, '', 'Cloning...\n')
      const result = await gitClone('https://github.com/test/repo', '/dest', () => {})
      expect(result.exitCode).toBe(0)
      const args = expectPygit2SpawnCall()
      expect(args).toEqual(['clone', 'https://github.com/test/repo', '/dest'])
    })

    it('returns failure exitCode on error', async () => {
      mockSpawn(1, '', 'Error: clone failed\n')
      const result = await gitClone('https://github.com/test/repo', '/dest', () => {})
      expect(result.exitCode).toBe(1)
    })

    it('forwards output to sendOutput callback', async () => {
      mockSpawn(0, 'progress\n', 'status\n')
      const output: string[] = []
      await gitClone('https://github.com/test/repo', '/dest', (t) => output.push(t))
      expect(output).toContain('progress\n')
      expect(output).toContain('status\n')
    })

    it('returns immediately when signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      const result = await gitClone('https://github.com/test/repo', '/dest', () => {}, controller.signal)
      expect(result.exitCode).toBe(1)
      expect(mockedSpawn).not.toHaveBeenCalled()
    })
  })

  describe('gitCheckoutCommit', () => {
    it('passes correct subcommand', async () => {
      mockSpawn(0, '', 'Checked out abc123\n')
      const result = await gitCheckoutCommit('/repo', 'abc123', () => {})
      expect(result.exitCode).toBe(0)
      const args = expectPygit2SpawnCall()
      expect(args).toEqual(['checkout', '/repo', 'abc123'])
    })

    it('returns failure exitCode on error', async () => {
      mockSpawn(1, '', 'Error: checkout failed\n')
      const result = await gitCheckoutCommit('/repo', 'abc123', () => {})
      expect(result.exitCode).toBe(1)
    })

    it('returns immediately when signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      const result = await gitCheckoutCommit('/repo', 'abc123', () => {}, controller.signal)
      expect(result.exitCode).toBe(1)
      expect(mockedSpawn).not.toHaveBeenCalled()
    })
  })

  describe('gitFetchAndCheckout', () => {
    it('passes correct subcommand', async () => {
      mockSpawn(0, '', 'Checked out abc123\n')
      const result = await gitFetchAndCheckout('/repo', 'abc123', () => {})
      expect(result.exitCode).toBe(0)
      const args = expectPygit2SpawnCall()
      expect(args).toEqual(['fetch-and-checkout', '/repo', 'abc123'])
    })

    it('returns failure exitCode on error', async () => {
      mockSpawn(1, '', 'Error: fetch failed\n')
      const result = await gitFetchAndCheckout('/repo', 'abc123', () => {})
      expect(result.exitCode).toBe(1)
    })

    it('returns immediately when signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      const result = await gitFetchAndCheckout('/repo', 'abc123', () => {}, controller.signal)
      expect(result.exitCode).toBe(1)
      expect(mockedSpawn).not.toHaveBeenCalled()
    })
  })
})
