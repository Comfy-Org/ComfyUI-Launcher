import { describe, it, expect, vi, beforeAll } from 'vitest'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') return os.homedir()
      return path.join(os.tmpdir(), 'comfyui-launcher-test')
    },
  },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: {},
}))

let ALLOWED_EXTENSIONS: string[]
let hasValidExtension: (filename: string) => boolean
let isPathContained: (filePath: string, baseDir: string) => boolean

beforeAll(async () => {
  const mod = await import('./comfyDownloadManager')
  ALLOWED_EXTENSIONS = mod.ALLOWED_EXTENSIONS
  hasValidExtension = mod.hasValidExtension
  isPathContained = mod.isPathContained
})

describe('ALLOWED_EXTENSIONS', () => {
  const requiredExtensions = ['.safetensors', '.sft', '.ckpt', '.pth', '.pt']

  it.each(requiredExtensions)('includes %s', (ext) => {
    expect(ALLOWED_EXTENSIONS).toContain(ext)
  })
})

describe('hasValidExtension', () => {
  it.each([
    'model.safetensors',
    'model.sft',
    'model.ckpt',
    'model.pth',
    'model.pt',
  ])('returns true for %s', (filename) => {
    expect(hasValidExtension(filename)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(hasValidExtension('model.SafeTensors')).toBe(true)
  })

  it('returns false for disallowed extensions', () => {
    expect(hasValidExtension('script.py')).toBe(false)
    expect(hasValidExtension('archive.zip')).toBe(false)
  })
})

describe('isPathContained', () => {
  it('returns true when file is inside base directory', () => {
    expect(isPathContained('/models/stable-diffusion/model.sft', '/models')).toBe(true)
  })

  it('returns false when file is outside base directory', () => {
    expect(isPathContained('/other/model.sft', '/models')).toBe(false)
  })
})
