import path from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: {},
  shell: {},
}))

import { hasValidExtension, isPathContained, stripQueryParams } from './comfyDownloadManager'

describe('isPathContained', () => {
  const baseDir = path.resolve('/models')

  it('returns true for a file inside the base dir', () => {
    const filePath = path.join(baseDir, 'file.safetensors')
    expect(isPathContained(filePath, baseDir)).toBe(true)
  })

  it('returns true for a file in a subdirectory of the base dir', () => {
    const filePath = path.join(baseDir, 'checkpoints', 'model.safetensors')
    expect(isPathContained(filePath, baseDir)).toBe(true)
  })

  it('returns false for a path outside the base dir', () => {
    const filePath = path.join(baseDir, '..', '..', 'etc', 'passwd')
    expect(isPathContained(filePath, baseDir)).toBe(false)
  })

  it('returns false for a path that is a prefix but not a child', () => {
    const filePath = path.resolve('/models-evil/file.txt')
    expect(isPathContained(filePath, baseDir)).toBe(false)
  })

  it('returns false when the file path equals the base dir itself', () => {
    expect(isPathContained(baseDir, baseDir)).toBe(false)
  })
})

describe('hasValidExtension', () => {
  it.each(['.safetensors', '.sft', '.ckpt', '.pth', '.pt'])(
    'returns true for %s extension',
    (ext) => {
      expect(hasValidExtension(`model${ext}`)).toBe(true)
    },
  )

  it('returns true for uppercase extensions', () => {
    expect(hasValidExtension('model.SAFETENSORS')).toBe(true)
  })

  it('returns true for mixed case extensions', () => {
    expect(hasValidExtension('model.SafeTensors')).toBe(true)
  })

  it.each(['.exe', '.js', '.zip', '.txt'])(
    'returns false for %s extension',
    (ext) => {
      expect(hasValidExtension(`file${ext}`)).toBe(false)
    },
  )

  it('returns false for empty string', () => {
    expect(hasValidExtension('')).toBe(false)
  })

  it('returns false for filename with no extension', () => {
    expect(hasValidExtension('model')).toBe(false)
  })
})

describe('stripQueryParams', () => {
  it('returns filename unchanged when no query params', () => {
    expect(stripQueryParams('model.safetensors')).toBe('model.safetensors')
  })

  it('strips query params from filename', () => {
    expect(stripQueryParams('model.safetensors?token=abc')).toBe('model.safetensors')
  })

  it('handles multiple question marks', () => {
    expect(stripQueryParams('model.safetensors?a=1?b=2')).toBe('model.safetensors')
  })

  it('returns empty string for empty input', () => {
    expect(stripQueryParams('')).toBe('')
  })

  it('handles filename that is just a question mark', () => {
    expect(stripQueryParams('?')).toBe('')
  })
})


