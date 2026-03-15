// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, execFile: vi.fn() }
})

import { execFile } from 'child_process'
import { countCommitsAhead, findNearestTag, findLatestVersionTag, isAncestorOf } from './git'

const mockedExecFile = vi.mocked(execFile)

function mockExecFile(cb: (cmd: string, args: string[], opts: Record<string, unknown>, callback: (err: Error | null, stdout: string, stderr: string) => void) => void): void {
  mockedExecFile.mockImplementation(cb as never)
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
