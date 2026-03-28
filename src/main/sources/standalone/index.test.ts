import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../../lib/fetch', () => ({
  fetchJSON: vi.fn(),
}))

import { standalone } from './index'
import { fetchJSON } from '../../lib/fetch'
import type { FieldOption } from '../../types/sources'

const mockedFetchJSON = vi.mocked(fetchJSON)

// --- Helpers ---

function makeGitHubRelease(tag: string, name?: string) {
  return {
    id: Math.random(),
    tag_name: tag,
    name: name || null,
    assets: [{ name: 'manifests.json', browser_download_url: `https://example.com/${tag}/manifests.json`, size: 100 }],
  }
}

// --- buildInstallation ---

describe('standalone.buildInstallation', () => {
  const makeRelease = (value: string, tagName?: string): FieldOption => ({
    value,
    label: value,
    data: { id: 1, tag_name: tagName || value, name: null, assets: [] } as unknown as Record<string, unknown>,
  })

  const makeVariant = (variantId: string): FieldOption => ({
    value: variantId,
    label: variantId,
    data: {
      variantId,
      manifest: { id: variantId, comfyui_ref: 'v0.18.3', python_version: '3.13.12' },
      downloadUrl: 'https://example.com/download.tar.gz',
      downloadFiles: [{ url: 'https://example.com/download.tar.gz', filename: 'download.tar.gz', size: 1000 }],
    } as unknown as Record<string, unknown>,
  })

  it('sets autoUpdateComfyUI when release value is "latest"', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('latest', 'standalone-v0.1.24'),
      variant: makeVariant('win-nvidia'),
    })
    expect(result.autoUpdateComfyUI).toBe(true)
  })

  it('does NOT set autoUpdateComfyUI for a specific release tag', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('standalone-v0.1.24'),
      variant: makeVariant('win-nvidia'),
    })
    expect(result.autoUpdateComfyUI).toBeUndefined()
  })

  it('uses underlying tag_name as releaseTag when "latest" is selected', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('latest', 'standalone-v0.1.24'),
      variant: makeVariant('win-nvidia'),
    })
    expect(result.releaseTag).toBe('standalone-v0.1.24')
  })

  it('uses the release value directly as releaseTag for specific releases', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('standalone-v0.1.20'),
      variant: makeVariant('win-nvidia'),
    })
    expect(result.releaseTag).toBe('standalone-v0.1.20')
  })
})

// --- getFieldOptions('release') ---

describe('standalone.getFieldOptions release', () => {
  function setupMockReleases() {
    const releases = [makeGitHubRelease('standalone-v0.1.24', 'March 2026'), makeGitHubRelease('standalone-v0.1.23')]
    mockedFetchJSON.mockImplementation((url: string) => {
      if (url.includes('/releases/latest')) return Promise.resolve(releases[0])
      return Promise.resolve(releases)
    })
  }

  it('includes "Latest Stable" when includeLatestStable is true', async () => {
    setupMockReleases()
    const options = await standalone.getFieldOptions!('release', {}, { includeLatestStable: true })
    expect(options[0]!.value).toBe('latest')
    expect(options[0]!.recommended).toBe(true)
    // Real releases follow
    expect(options[1]!.value).toBe('standalone-v0.1.24')
    expect(options[2]!.value).toBe('standalone-v0.1.23')
  })

  it('excludes "Latest Stable" by default (no context flag)', async () => {
    setupMockReleases()
    const options = await standalone.getFieldOptions!('release', {}, {})
    expect(options.every((o) => o.value !== 'latest')).toBe(true)
    expect(options[0]!.value).toBe('standalone-v0.1.24')
  })

  it('excludes "Latest Stable" when includeLatestStable is false', async () => {
    setupMockReleases()
    const options = await standalone.getFieldOptions!('release', {}, { includeLatestStable: false })
    expect(options.every((o) => o.value !== 'latest')).toBe(true)
  })

  it('"Latest Stable" entry uses the newest release data', async () => {
    setupMockReleases()
    const options = await standalone.getFieldOptions!('release', {}, { includeLatestStable: true })
    const latestEntry = options.find((o) => o.value === 'latest')!
    const underlyingRelease = latestEntry.data as Record<string, unknown>
    expect(underlyingRelease.tag_name).toBe('standalone-v0.1.24')
  })
})
