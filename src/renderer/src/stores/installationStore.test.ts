import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Installation } from '../types/ipc'
import { useInstallationStore } from './installationStore'

const mockInstallations: Installation[] = [
  {
    id: 'inst-1',
    name: 'My ComfyUI',
    sourceLabel: 'Local',
    sourceCategory: 'local'
  } as Installation,
  {
    id: 'inst-2',
    name: 'Remote ComfyUI',
    sourceLabel: 'Cloud',
    sourceCategory: 'cloud'
  } as Installation
]

vi.stubGlobal('window', {
  ...window,
  api: {
    getInstallations: vi.fn(),
    onInstallationsChanged: vi.fn()
  }
})

describe('useInstallationStore', () => {
  let store: ReturnType<typeof useInstallationStore>

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    store = useInstallationStore()
    vi.clearAllMocks()
  })

  it('should have empty initial state', () => {
    expect(store.installations).toEqual([])
    expect(store.loading).toBe(false)
  })

  describe('fetchInstallations', () => {
    it('should populate installations and manage loading state', async () => {
      vi.mocked(window.api.getInstallations).mockResolvedValue(
        mockInstallations
      )

      const promise = store.fetchInstallations()
      expect(store.loading).toBe(true)

      const result = await promise
      expect(store.loading).toBe(false)
      expect(store.installations).toEqual(mockInstallations)
      expect(result).toEqual(mockInstallations)
    })

    it('should clear loading even on error', async () => {
      vi.mocked(window.api.getInstallations).mockRejectedValue(
        new Error('Network error')
      )

      await expect(store.fetchInstallations()).rejects.toThrow('Network error')
      expect(store.loading).toBe(false)
    })
  })

  describe('getById', () => {
    beforeEach(async () => {
      vi.mocked(window.api.getInstallations).mockResolvedValue(
        mockInstallations
      )
      await store.fetchInstallations()
    })

    it('should return installation matching the given id', () => {
      const result = store.getById('inst-2')
      expect(result).toEqual(mockInstallations[1])
    })

    it('should return undefined for an unknown id', () => {
      const result = store.getById('nonexistent')
      expect(result).toBeUndefined()
    })
  })
})
