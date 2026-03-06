import path from 'path'
import { describe, expect, it, vi, beforeEach, type MockInstance } from 'vitest'
import fs from 'fs'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
}))

vi.mock('./nodes', () => ({
  scanCustomNodes: vi.fn().mockResolvedValue([]),
}))

import { detectDesktopInstall, findDesktopExecutable, syncSharedModelPaths, captureDesktopSnapshot } from './desktopDetect'
import type { DesktopInstallInfo } from './desktopDetect'

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

describe('syncSharedModelPaths', () => {
  let readFileSyncSpy: MockInstance
  let writeFileSyncSpy: MockInstance
  let mkdirSyncSpy: MockInstance

  beforeEach(() => {
    vi.restoreAllMocks()
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync')
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
  })

  it('creates config with launcher sections when file does not exist', () => {
    readFileSyncSpy.mockImplementation(() => { throw new Error('ENOENT') })

    syncSharedModelPaths('/config/ComfyUI', ['/shared/models'])

    expect(mkdirSyncSpy).toHaveBeenCalledWith('/config/ComfyUI', { recursive: true })
    expect(writeFileSyncSpy).toHaveBeenCalledOnce()
    const written = writeFileSyncSpy.mock.calls[0]![1] as string
    expect(written).toContain('comfyui_launcher_0:')
    expect(written).toContain('checkpoints: checkpoints/')
    expect(written).toContain('loras: loras/')
  })

  it('preserves existing Desktop sections and appends launcher sections', () => {
    readFileSyncSpy.mockReturnValue(
      'comfyui_desktop:\n  base_path: /docs/ComfyUI\n  is_default: true\n'
    )

    syncSharedModelPaths('/config/ComfyUI', ['/shared/models'])

    const written = writeFileSyncSpy.mock.calls[0]![1] as string
    expect(written).toContain('comfyui_desktop:')
    expect(written).toContain('base_path: /docs/ComfyUI')
    expect(written).toContain('comfyui_launcher_0:')
  })

  it('replaces existing launcher sections on re-sync', () => {
    readFileSyncSpy.mockReturnValue(
      'comfyui_desktop:\n  base_path: /docs/ComfyUI\n\n' +
      'comfyui_launcher_0:\n  base_path: /old/models\n  checkpoints: checkpoints/\n'
    )

    const newDir = path.resolve('/new/models')
    syncSharedModelPaths('/config/ComfyUI', ['/new/models'])

    const written = writeFileSyncSpy.mock.calls[0]![1] as string
    expect(written).not.toContain('/old/models')
    expect(written).toContain(newDir)
    expect(written).toContain('comfyui_desktop:')
    // Should have exactly one launcher section
    expect(written.match(/comfyui_launcher_0:/g)).toHaveLength(1)
  })

  it('handles multiple model directories', () => {
    readFileSyncSpy.mockImplementation(() => { throw new Error('ENOENT') })

    syncSharedModelPaths('/config/ComfyUI', ['/models/a', '/models/b'])

    const written = writeFileSyncSpy.mock.calls[0]![1] as string
    expect(written).toContain('comfyui_launcher_0:')
    expect(written).toContain('comfyui_launcher_1:')
  })

  it('writes no launcher sections when modelsDirs is empty', () => {
    readFileSyncSpy.mockReturnValue(
      'comfyui_desktop:\n  base_path: /docs/ComfyUI\n'
    )

    syncSharedModelPaths('/config/ComfyUI', [])

    const written = writeFileSyncSpy.mock.calls[0]![1] as string
    expect(written).toContain('comfyui_desktop:')
    expect(written).not.toContain('comfyui_launcher_')
  })
})

describe('captureDesktopSnapshot', () => {
  let mockScan: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.restoreAllMocks()
    const nodes = await import('./nodes')
    mockScan = vi.mocked(nodes.scanCustomNodes)
    mockScan.mockResolvedValue([])
  })

  it('returns a valid snapshot with empty nodes when no custom nodes exist', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const info: DesktopInstallInfo = {
      configDir: '/config/ComfyUI',
      basePath: '/data/ComfyUI',
      executablePath: null,
      hasVenv: false,
    }

    const snapshot = await captureDesktopSnapshot(info)

    expect(snapshot.version).toBe(1)
    expect(snapshot.trigger).toBe('manual')
    expect(snapshot.label).toBe('Desktop migration')
    expect(snapshot.comfyui.ref).toBe('desktop')
    expect(snapshot.customNodes).toEqual([])
    expect(snapshot.pipPackages).toEqual({})
  })

  it('scans custom nodes from basePath', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const fakeNodes = [
      { id: 'test-node', type: 'cnr' as const, dirName: 'test-node', enabled: true, version: '1.0' },
    ]
    mockScan.mockResolvedValue(fakeNodes)

    const info: DesktopInstallInfo = {
      configDir: '/config/ComfyUI',
      basePath: '/data/ComfyUI',
      executablePath: null,
      hasVenv: false,
    }

    const snapshot = await captureDesktopSnapshot(info)

    expect(mockScan).toHaveBeenCalledWith('/data/ComfyUI')
    expect(snapshot.customNodes).toEqual(fakeNodes)
  })

  it('skips pip freeze when no venv exists', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const info: DesktopInstallInfo = {
      configDir: '/config/ComfyUI',
      basePath: '/data/ComfyUI',
      executablePath: null,
      hasVenv: false,
    }

    const snapshot = await captureDesktopSnapshot(info)

    expect(snapshot.pipPackages).toEqual({})
  })
})
