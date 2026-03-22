import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockPlatform = 'linux'
let mockAppImage: string | undefined
let mockIsPackaged = true
let mockExePath = '/opt/ComfyUI Desktop 2.0/comfyui-desktop-2'

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged
    },
    getPath: (name: string) => {
      if (name === 'exe') return mockExePath
      return ''
    },
  },
  ipcMain: {
    handle: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}))

vi.mock('@todesktop/runtime', () => ({
  default: { autoUpdater: null },
}))

vi.mock('../settings', () => ({
  get: vi.fn(),
}))

vi.mock('./quit-state', () => ({
  clearQuitReason: vi.fn(),
  setQuitReason: vi.fn(),
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('isSystemPackageInstall (via get-update-capabilities)', () => {
  let registeredHandlers: Record<string, (...args: unknown[]) => unknown>

  beforeEach(async () => {
    registeredHandlers = {}
    const { ipcMain } = await import('electron')
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers[channel] = handler
    }) as typeof ipcMain.handle)

    mockPlatform = 'linux'
    mockAppImage = undefined
    mockIsPackaged = true
    mockExePath = '/opt/ComfyUI Desktop 2.0/comfyui-desktop-2'

    delete process.env.APPIMAGE
    Object.defineProperty(process, 'platform', { value: mockPlatform, configurable: true })

    vi.resetModules()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  async function getCapabilities(): Promise<{ canAutoUpdate: boolean; systemManaged: boolean }> {
    Object.defineProperty(process, 'platform', { value: mockPlatform, configurable: true })
    if (mockAppImage) {
      process.env.APPIMAGE = mockAppImage
    } else {
      delete process.env.APPIMAGE
    }

    vi.resetModules()
    const updater = await import('./updater')
    updater.register()
    const handler = registeredHandlers['get-update-capabilities']!
    return handler() as { canAutoUpdate: boolean; systemManaged: boolean }
  }

  it('detects .deb install under /opt/', async () => {
    mockExePath = '/opt/ComfyUI Desktop 2.0/comfyui-desktop-2'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: false, systemManaged: true })
  })

  it('detects .deb install under /usr/', async () => {
    mockExePath = '/usr/lib/comfyui-desktop-2/comfyui-desktop-2'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: false, systemManaged: true })
  })

  it('returns standard for AppImage (APPIMAGE env set)', async () => {
    mockAppImage = '/home/user/ComfyUI-Desktop-2.0.AppImage'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard for Windows', async () => {
    mockPlatform = 'win32'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard for macOS', async () => {
    mockPlatform = 'darwin'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard when not packaged (dev mode)', async () => {
    mockIsPackaged = false
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard for Linux exe under /home/ (manual extract)', async () => {
    mockExePath = '/home/user/apps/comfyui-desktop-2'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard for Linux exe under /tmp/ (temp location)', async () => {
    mockExePath = '/tmp/.mount_comfyui/comfyui-desktop-2'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })
})
