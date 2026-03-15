import path from 'path'
import { afterEach, describe, expect, it, vi, beforeEach, type MockInstance } from 'vitest'
import fs from 'fs'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: {},
  shell: { openPath: vi.fn().mockResolvedValue('') },
}))

import { desktop } from './desktop'

describe('desktop.getLaunchCommand', () => {
  let existsSyncSpy: MockInstance
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.restoreAllMocks()
    existsSyncSpy = vi.spyOn(fs, 'existsSync')
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('uses `open` for .app bundles on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const appPath = '/Applications/ComfyUI.app'
    existsSyncSpy.mockReturnValue(true)

    const cmd = desktop.getLaunchCommand({ desktopExePath: appPath } as unknown as Parameters<typeof desktop.getLaunchCommand>[0])
    expect(cmd).not.toBeNull()
    expect(cmd!.cmd).toBe('/usr/bin/open')
    expect(cmd!.args).toEqual([appPath])
    expect(cmd!.skipPortWait).toBe(true)
  })

  it('uses the executable directly on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const exePath = 'C:\\Programs\\ComfyUI\\ComfyUI.exe'
    existsSyncSpy.mockReturnValue(true)

    const cmd = desktop.getLaunchCommand({ desktopExePath: exePath } as unknown as Parameters<typeof desktop.getLaunchCommand>[0])
    expect(cmd).not.toBeNull()
    expect(cmd!.cmd).toBe(exePath)
    expect(cmd!.args).toEqual([])
  })

  it('returns null when executable does not exist', () => {
    existsSyncSpy.mockReturnValue(false)

    const cmd = desktop.getLaunchCommand({ desktopExePath: '/missing/ComfyUI.app' } as unknown as Parameters<typeof desktop.getLaunchCommand>[0])
    expect(cmd).toBeNull()
  })
})

describe('desktop.probeInstallation', () => {
  let existsSyncSpy: MockInstance

  beforeEach(() => {
    vi.restoreAllMocks()
    existsSyncSpy = vi.spyOn(fs, 'existsSync')
  })

  function stubDir(dirPath: string, contents: string[]): void {
    existsSyncSpy.mockImplementation((p: fs.PathLike) => {
      const s = p.toString()
      return contents.some((name) => s === path.join(dirPath, name))
    })
  }

  it('returns data for a Desktop basePath (.venv, models, user, no standalone-env)', async () => {
    const dir = '/home/test/Documents/ComfyUI'
    stubDir(dir, ['models', 'user', '.venv'])

    const result = await desktop.probeInstallation(dir)
    expect(result).not.toBeNull()
    expect(result!.version).toBeUndefined()
    expect(result!.launchMode).toBe('external')
  })

  it('returns null when standalone-env exists (Standalone install)', async () => {
    const dir = '/home/test/installs/my-comfy'
    stubDir(dir, ['models', 'user', '.venv', 'standalone-env'])

    expect(await desktop.probeInstallation(dir)).toBeNull()
  })

  it('returns null when .venv is missing', async () => {
    const dir = '/home/test/Documents/ComfyUI'
    stubDir(dir, ['models', 'user'])

    expect(await desktop.probeInstallation(dir)).toBeNull()
  })

  it('returns null when models directory is missing', async () => {
    const dir = '/home/test/Documents/ComfyUI'
    stubDir(dir, ['user', '.venv'])

    expect(await desktop.probeInstallation(dir)).toBeNull()
  })

  it('returns null when user directory is missing', async () => {
    const dir = '/home/test/Documents/ComfyUI'
    stubDir(dir, ['models', '.venv'])

    expect(await desktop.probeInstallation(dir)).toBeNull()
  })
})
