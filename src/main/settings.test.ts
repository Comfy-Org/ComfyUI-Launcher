import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyui-desktop-2-settings-'))
const homePath = path.join(tmpRoot, 'home')
const userDataPath = path.join(tmpRoot, 'user-data')
const xdgConfigHome = path.join(tmpRoot, 'xdg-config')
const xdgCacheHome = path.join(tmpRoot, 'xdg-cache')
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalXdgCacheHome = process.env.XDG_CACHE_HOME

process.env.XDG_CONFIG_HOME = xdgConfigHome
process.env.XDG_CACHE_HOME = xdgCacheHome
fs.mkdirSync(homePath, { recursive: true })
fs.mkdirSync(userDataPath, { recursive: true })
fs.mkdirSync(xdgConfigHome, { recursive: true })
fs.mkdirSync(xdgCacheHome, { recursive: true })

let settings: {
  set: (key: string, value: unknown) => void
  get: (key: string) => unknown
  defaults: { onAppClose: 'tray' | 'quit' }
}

const settingsPath = process.platform === 'linux'
  ? path.join(xdgConfigHome, 'comfyui-desktop-2', 'settings.json')
  : path.join(userDataPath, 'settings.json')

function readPersistedSettings(): Record<string, unknown> {
  const raw = fs.readFileSync(settingsPath, 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

beforeEach(async () => {
  fs.rmSync(path.dirname(settingsPath), { recursive: true, force: true })
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: {
      getPath: (name: string) => {
        if (name === 'home') return homePath
        return userDataPath
      },
    },
  }))
  settings = await import('./settings')
})

afterAll(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('settings unset/default semantics', () => {
  it('treats undefined as unset and falls back to default', () => {
    settings.set('onAppClose', 'quit')
    expect(settings.get('onAppClose')).toBe('quit')

    settings.set('onAppClose', undefined)

    expect(settings.get('onAppClose')).toBe(settings.defaults.onAppClose)
    const persisted = readPersistedSettings()
    expect(persisted).not.toHaveProperty('onAppClose')
  })

  it('normalizes legacy null values to unset on write', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ primaryInstallId: null, autoUpdate: null }, null, 2),
      'utf-8'
    )

    expect(settings.get('primaryInstallId')).toBeUndefined()
    expect(settings.get('autoUpdate')).toBeUndefined()

    settings.set('theme', 'dark')

    const persisted = readPersistedSettings()
    expect(persisted).not.toHaveProperty('primaryInstallId')
    expect(persisted).not.toHaveProperty('autoUpdate')
    expect(persisted['theme']).toBe('dark')
  })

  it('treats null for unknown keys as passthrough values', () => {
    settings.set('customKey' as string, null)
    expect(settings.get('customKey' as string)).toBeNull()
    expect(readPersistedSettings()['customKey']).toBeNull()
  })

  it('treats empty and whitespace-only strings as unset for pypiMirror', () => {
    settings.set('pypiMirror', 'https://mirrors.aliyun.com/pypi/simple/')
    expect(settings.get('pypiMirror')).toBe('https://mirrors.aliyun.com/pypi/simple/')

    settings.set('pypiMirror', '')
    expect(settings.get('pypiMirror')).toBeUndefined()
    expect(readPersistedSettings()).not.toHaveProperty('pypiMirror')

    settings.set('pypiMirror', 'https://example.com/simple/')
    settings.set('pypiMirror', '   ')
    expect(settings.get('pypiMirror')).toBeUndefined()
    expect(readPersistedSettings()).not.toHaveProperty('pypiMirror')
  })
})
