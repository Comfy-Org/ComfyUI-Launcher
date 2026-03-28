// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../git', () => ({
  readGitHead: vi.fn(),
}))

vi.mock('../nodes', () => ({
  scanCustomNodes: vi.fn(),
  nodeKey: vi.fn((n: { type: string; dirName: string }) => `${n.type}:${n.dirName}`),
}))

vi.mock('../pip', () => ({
  pipFreeze: vi.fn(),
}))

vi.mock('../pythonEnv', () => ({
  getUvPath: vi.fn(() => '/fake/uv'),
  getActivePythonPath: vi.fn(() => null),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    default: {
      ...(actual.default as object),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => {
        throw new Error('not found')
      }),
    },
  }
})

import { readGitHead } from '../git'
import { scanCustomNodes } from '../nodes'
import { captureState } from './store'
import type { InstallationRecord } from '../../installations'

const mockedReadGitHead = vi.mocked(readGitHead)
const mockedScanCustomNodes = vi.mocked(scanCustomNodes)

describe('captureState commit-matching guard', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedScanCustomNodes.mockResolvedValue([])
  })

  it('copies baseTag and commitsAhead when commit matches installation record', async () => {
    mockedReadGitHead.mockReturnValue('abc1234')
    const installation = {
      id: 'test',
      name: 'Test',
      createdAt: '2026-01-01T00:00:00.000Z',
      installPath: '/test/install',
      sourceId: 'test',
      comfyVersion: { commit: 'abc1234', baseTag: 'v0.17.2', commitsAhead: 12 },
    } as InstallationRecord

    const state = await captureState('/test/install', installation)

    expect(state.comfyui.commit).toBe('abc1234')
    expect(state.comfyui.baseTag).toBe('v0.17.2')
    expect(state.comfyui.commitsAhead).toBe(12)
  })

  it('does not copy baseTag when commit differs (external git change)', async () => {
    mockedReadGitHead.mockReturnValue('def5678')
    const installation = {
      id: 'test',
      name: 'Test',
      createdAt: '2026-01-01T00:00:00.000Z',
      installPath: '/test/install',
      sourceId: 'test',
      comfyVersion: { commit: 'abc1234', baseTag: 'v0.17.2', commitsAhead: 12 },
    } as InstallationRecord

    const state = await captureState('/test/install', installation)

    expect(state.comfyui.commit).toBe('def5678')
    expect(state.comfyui.baseTag).toBeUndefined()
    expect(state.comfyui.commitsAhead).toBeUndefined()
  })

  it('leaves baseTag undefined when no comfyVersion on installation', async () => {
    mockedReadGitHead.mockReturnValue('abc1234')
    const installation = {
      id: 'test',
      name: 'Test',
      createdAt: '2026-01-01T00:00:00.000Z',
      installPath: '/test/install',
      sourceId: 'test',
    } as InstallationRecord

    const state = await captureState('/test/install', installation)

    expect(state.comfyui.commit).toBe('abc1234')
    expect(state.comfyui.baseTag).toBeUndefined()
    expect(state.comfyui.commitsAhead).toBeUndefined()
  })

  it('copies baseTag when commit matches and commitsAhead is 0 (exact tag)', async () => {
    mockedReadGitHead.mockReturnValue('deadbeef')
    const installation = {
      id: 'test',
      name: 'Test',
      createdAt: '2026-01-01T00:00:00.000Z',
      installPath: '/test/install',
      sourceId: 'test',
      comfyVersion: { commit: 'deadbeef', baseTag: 'v0.18.0', commitsAhead: 0 },
    } as InstallationRecord

    const state = await captureState('/test/install', installation)

    expect(state.comfyui.commit).toBe('deadbeef')
    expect(state.comfyui.baseTag).toBe('v0.18.0')
    expect(state.comfyui.commitsAhead).toBe(0)
  })

  it('leaves baseTag undefined when readGitHead returns null', async () => {
    mockedReadGitHead.mockReturnValue(null)
    const installation = {
      id: 'test',
      name: 'Test',
      createdAt: '2026-01-01T00:00:00.000Z',
      installPath: '/test/install',
      sourceId: 'test',
      comfyVersion: { commit: 'abc1234', baseTag: 'v0.17.2', commitsAhead: 12 },
    } as InstallationRecord

    const state = await captureState('/test/install', installation)

    expect(state.comfyui.commit).toBeNull()
    expect(state.comfyui.baseTag).toBeUndefined()
    expect(state.comfyui.commitsAhead).toBeUndefined()
  })
})
