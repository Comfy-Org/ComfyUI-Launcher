import path from 'path'
import { describe, expect, it, vi, beforeEach, type MockInstance } from 'vitest'
import fs from 'fs'

import { detectDesktopInstall, findDesktopExecutable } from './desktopDetect'

describe('detectDesktopInstall', () => {
  let readFileSyncSpy: MockInstance
  let existsSyncSpy: MockInstance

  beforeEach(() => {
    vi.restoreAllMocks()
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync')
    existsSyncSpy = vi.spyOn(fs, 'existsSync')
    delete process.env.APPDATA
    delete process.env.LOCALAPPDATA
  })

  it('returns null on unsupported platforms', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', env: {} })
    expect(detectDesktopInstall()).toBeNull()
    vi.unstubAllGlobals()
  })

  it('returns null when APPDATA is not set on Windows', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32', env: {} })
    expect(detectDesktopInstall()).toBeNull()
    vi.unstubAllGlobals()
  })

  it('returns null when config.json does not exist', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32', env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' } })
    readFileSyncSpy.mockImplementation(() => { throw new Error('ENOENT') })
    expect(detectDesktopInstall()).toBeNull()
    vi.unstubAllGlobals()
  })

  it('returns null when config.json has no basePath', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32', env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' } })
    readFileSyncSpy.mockReturnValue('{"installState":"installed"}')
    expect(detectDesktopInstall()).toBeNull()
    vi.unstubAllGlobals()
  })

  it('returns null when basePath does not exist on disk', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32', env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' } })
    readFileSyncSpy.mockReturnValue('{"basePath":"C:\\\\Users\\\\test\\\\Documents\\\\ComfyUI"}')
    existsSyncSpy.mockReturnValue(false)
    expect(detectDesktopInstall()).toBeNull()
    vi.unstubAllGlobals()
  })

  it('returns info when a valid Desktop install is found', () => {
    const basePath = path.join('C:', 'Users', 'test', 'Documents', 'ComfyUI')
    vi.stubGlobal('process', {
      ...process,
      platform: 'win32',
      env: {
        APPDATA: path.join('C:', 'Users', 'test', 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join('C:', 'Users', 'test', 'AppData', 'Local'),
      },
    })

    readFileSyncSpy.mockReturnValue(JSON.stringify({ basePath }))
    existsSyncSpy.mockImplementation((p: fs.PathLike) => {
      const s = p.toString()
      if (s === basePath) return true
      if (s === path.join(basePath, 'models')) return true
      if (s === path.join(basePath, 'user')) return true
      if (s === path.join(basePath, '.venv')) return true
      return false
    })

    const result = detectDesktopInstall()
    expect(result).not.toBeNull()
    expect(result!.basePath).toBe(basePath)
    expect(result!.hasVenv).toBe(true)
    vi.unstubAllGlobals()
  })

  it('returns info with hasVenv false when .venv is missing', () => {
    const basePath = path.join('C:', 'Users', 'test', 'Documents', 'ComfyUI')
    vi.stubGlobal('process', {
      ...process,
      platform: 'win32',
      env: { APPDATA: path.join('C:', 'Users', 'test', 'AppData', 'Roaming') },
    })

    readFileSyncSpy.mockReturnValue(JSON.stringify({ basePath }))
    existsSyncSpy.mockImplementation((p: fs.PathLike) => {
      const s = p.toString()
      if (s === basePath) return true
      if (s === path.join(basePath, 'models')) return true
      if (s === path.join(basePath, 'user')) return true
      return false
    })

    const result = detectDesktopInstall()
    expect(result).not.toBeNull()
    expect(result!.hasVenv).toBe(false)
    vi.unstubAllGlobals()
  })
})

describe('findDesktopExecutable', () => {
  let existsSyncSpy: MockInstance

  beforeEach(() => {
    vi.restoreAllMocks()
    existsSyncSpy = vi.spyOn(fs, 'existsSync')
  })

  it('returns null on unsupported platforms', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', env: {} })
    expect(findDesktopExecutable()).toBeNull()
    vi.unstubAllGlobals()
  })

  it('returns executable path on Windows when it exists', () => {
    const localAppData = path.join('C:', 'Users', 'test', 'AppData', 'Local')
    vi.stubGlobal('process', { ...process, platform: 'win32', env: { LOCALAPPDATA: localAppData } })
    const expected = path.join(localAppData, 'Programs', 'ComfyUI', 'ComfyUI.exe')
    existsSyncSpy.mockImplementation((p: fs.PathLike) => p.toString() === expected)
    expect(findDesktopExecutable()).toBe(expected)
    vi.unstubAllGlobals()
  })

  it('returns null on Windows when executable does not exist', () => {
    vi.stubGlobal('process', {
      ...process,
      platform: 'win32',
      env: { LOCALAPPDATA: path.join('C:', 'Users', 'test', 'AppData', 'Local') },
    })
    existsSyncSpy.mockReturnValue(false)
    expect(findDesktopExecutable()).toBeNull()
    vi.unstubAllGlobals()
  })
})
