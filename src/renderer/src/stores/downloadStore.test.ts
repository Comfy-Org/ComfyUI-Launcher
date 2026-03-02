import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ElectronApi, ModelDownloadProgress } from '../types/ipc'
import { useDownloadStore } from './downloadStore'

function makeProgress(
  overrides: Partial<ModelDownloadProgress> & { url: string }
): ModelDownloadProgress {
  return {
    filename: 'model.safetensors',
    progress: 0,
    status: 'pending',
    ...overrides,
  }
}

describe('useDownloadStore', () => {
  let store: ReturnType<typeof useDownloadStore>

  beforeEach(() => {
    window.api = {
      listModelDownloads: vi.fn().mockResolvedValue([]),
      onModelDownloadProgress: vi.fn(() => vi.fn()),
    } as unknown as ElectronApi

    setActivePinia(createTestingPinia({ stubActions: false }))
    store = useDownloadStore()
    vi.clearAllMocks()
  })

  describe('upsert', () => {
    it('inserts a new download entry', () => {
      const p = makeProgress({ url: 'https://example.com/a.bin' })
      store.upsert(p)

      expect(store.downloads.size).toBe(1)
      expect(store.downloads.get('https://example.com/a.bin')).toMatchObject({
        url: 'https://example.com/a.bin',
        status: 'pending',
      })
    })

    it('updates an existing entry with same url', () => {
      const url = 'https://example.com/a.bin'
      store.upsert(makeProgress({ url, progress: 0, status: 'pending' }))
      store.upsert(makeProgress({ url, progress: 50, status: 'downloading' }))

      expect(store.downloads.size).toBe(1)
      expect(store.downloads.get(url)).toMatchObject({
        progress: 50,
        status: 'downloading',
      })
    })

    it('preserves other entries when updating one', () => {
      store.upsert(makeProgress({ url: 'https://example.com/a.bin' }))
      store.upsert(makeProgress({ url: 'https://example.com/b.bin' }))
      store.upsert(
        makeProgress({ url: 'https://example.com/a.bin', progress: 75 })
      )

      expect(store.downloads.size).toBe(2)
      expect(store.downloads.get('https://example.com/b.bin')).toBeDefined()
    })
  })

  describe('dismiss', () => {
    it('removes the entry by url', () => {
      const url = 'https://example.com/a.bin'
      store.upsert(makeProgress({ url }))
      store.dismiss(url)

      expect(store.downloads.has(url)).toBe(false)
      expect(store.downloads.size).toBe(0)
    })

    it('is a no-op for unknown url', () => {
      store.upsert(makeProgress({ url: 'https://example.com/a.bin' }))
      store.dismiss('https://example.com/unknown.bin')

      expect(store.downloads.size).toBe(1)
    })
  })

  describe('activeDownloads', () => {
    it('includes downloads with status pending, downloading, paused', () => {
      store.upsert(makeProgress({ url: 'a', status: 'pending' }))
      store.upsert(makeProgress({ url: 'b', status: 'downloading' }))
      store.upsert(makeProgress({ url: 'c', status: 'paused' }))

      expect(store.activeDownloads).toHaveLength(3)
      expect(store.activeDownloads.map((d) => d.url).sort()).toEqual([
        'a',
        'b',
        'c',
      ])
    })

    it('excludes completed, error, cancelled', () => {
      store.upsert(makeProgress({ url: 'a', status: 'completed' }))
      store.upsert(makeProgress({ url: 'b', status: 'error' }))
      store.upsert(makeProgress({ url: 'c', status: 'cancelled' }))
      store.upsert(makeProgress({ url: 'd', status: 'downloading' }))

      expect(store.activeDownloads).toHaveLength(1)
      expect(store.activeDownloads[0].url).toBe('d')
    })
  })

  describe('finishedDownloads', () => {
    it('includes downloads with status completed, error, cancelled', () => {
      store.upsert(makeProgress({ url: 'a', status: 'completed' }))
      store.upsert(makeProgress({ url: 'b', status: 'error' }))
      store.upsert(makeProgress({ url: 'c', status: 'cancelled' }))

      expect(store.finishedDownloads).toHaveLength(3)
      expect(store.finishedDownloads.map((d) => d.url).sort()).toEqual([
        'a',
        'b',
        'c',
      ])
    })

    it('excludes pending, downloading, paused', () => {
      store.upsert(makeProgress({ url: 'a', status: 'pending' }))
      store.upsert(makeProgress({ url: 'b', status: 'downloading' }))
      store.upsert(makeProgress({ url: 'c', status: 'paused' }))
      store.upsert(makeProgress({ url: 'd', status: 'completed' }))

      expect(store.finishedDownloads).toHaveLength(1)
      expect(store.finishedDownloads[0].url).toBe('d')
    })
  })

  describe('hasDownloads', () => {
    it('returns false when empty', () => {
      expect(store.hasDownloads).toBe(false)
    })

    it('returns true when downloads exist', () => {
      store.upsert(makeProgress({ url: 'a' }))

      expect(store.hasDownloads).toBe(true)
    })

    it('returns false after all entries are dismissed', () => {
      store.upsert(makeProgress({ url: 'a' }))
      store.upsert(makeProgress({ url: 'b' }))
      store.dismiss('a')
      store.dismiss('b')

      expect(store.hasDownloads).toBe(false)
    })
  })
})
