import { describe, expect, it } from 'vitest'
import { getModelDownloadContentScript } from './comfyContentScript'

describe('getModelDownloadContentScript', () => {
  const script = getModelDownloadContentScript()

  it('returns a non-empty string', () => {
    expect(script).toBeTruthy()
    expect(typeof script).toBe('string')
    expect(script.length).toBeGreaterThan(0)
  })

  it('wraps the script in an IIFE', () => {
    expect(script.startsWith('(function()')).toBe(true)
  })

  it('contains the guard against double injection', () => {
    expect(script).toContain('__comfyDesktop2Injected')
  })

  it('contains the BADGE_TO_DIR mapping with expected directory names', () => {
    expect(script).toContain('BADGE_TO_DIR')
    for (const dir of ['vae', 'diffusion_models', 'text_encoders']) {
      expect(script).toContain(dir)
    }
  })

  it('contains MutationObserver for dialog detection', () => {
    expect(script).toContain('MutationObserver')
  })

  it('contains theme variable reading (comfy-menu-bg)', () => {
    expect(script).toContain('comfy-menu-bg')
  })

  it('contains the download tab element id', () => {
    expect(script).toContain('__comfy-dl-tab')
  })

  it('guards model download interception behind __comfyDesktop2Remote check', () => {
    expect(script).toContain('__comfyDesktop2Remote')
    // The createElement override should be skipped for remote sessions
    expect(script).toContain('if (!window.__comfyDesktop2Remote)')
  })

  it('keeps download progress toast active regardless of remote flag', () => {
    // onDownloadProgress listener should not be inside the remote guard
    expect(script).toContain('onDownloadProgress')
  })
})
