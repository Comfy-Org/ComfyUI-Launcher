import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', {
  ...window,
  api: {
    getInstallations: vi.fn().mockResolvedValue([]),
    onInstallationsChanged: vi.fn(),
    onInstallationsVersionsUpdated: vi.fn(),
    getSetting: vi.fn().mockResolvedValue(undefined),
    runAction: vi.fn().mockResolvedValue(undefined),
  }
})

// useLauncherPrefs has module-level shared state (primaryInstallId,
// pinnedInstallIds, loadPromise) that cannot be reset between tests.
// We therefore test loadPrefs once and exercise the remaining API via
// setPrimary / pinInstall / unpinInstall which mutate state directly.

import { useLauncherPrefs } from './useLauncherPrefs'

describe('useLauncherPrefs', () => {
  let prefs: ReturnType<typeof useLauncherPrefs>

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    vi.clearAllMocks()
    prefs = useLauncherPrefs()
    // Reset module-level shared state to isolate tests
    prefs.primaryInstallId.value = undefined
    prefs.pinnedInstallIds.value = []
  })

  describe('loadPrefs', () => {
    it('populates primaryInstallId and pinnedInstallIds from getSetting', async () => {
      vi.mocked(window.api.getSetting).mockImplementation((key: string) => {
        if (key === 'primaryInstallId') return Promise.resolve('inst-1')
        if (key === 'pinnedInstallIds') return Promise.resolve(['inst-2', 'inst-3'])
        return Promise.resolve(undefined)
      })

      await prefs.loadPrefs()

      expect(prefs.isPrimary('inst-1')).toBe(true)
      expect(prefs.isPrimary('inst-2')).toBe(false)
      expect(prefs.isPinned('inst-2')).toBe(true)
      expect(prefs.isPinned('inst-3')).toBe(true)
      expect(prefs.isPinned('inst-99')).toBe(false)
      expect(prefs.loaded.value).toBe(true)
    })
  })

  describe('isPinned / isPrimary', () => {
    it('returns false for unknown ids', () => {
      expect(prefs.isPinned('unknown')).toBe(false)
      expect(prefs.isPrimary('unknown')).toBe(false)
    })
  })

  describe('setPrimary', () => {
    it('updates primaryInstallId and calls runAction', async () => {
      await prefs.setPrimary('inst-5')

      expect(prefs.isPrimary('inst-5')).toBe(true)
      expect(window.api.runAction).toHaveBeenCalledWith('inst-5', 'set-primary-install')
    })

    it('replaces previous primary', async () => {
      await prefs.setPrimary('inst-5')
      await prefs.setPrimary('inst-6')

      expect(prefs.isPrimary('inst-5')).toBe(false)
      expect(prefs.isPrimary('inst-6')).toBe(true)
    })
  })

  describe('pinInstall', () => {
    it('adds id to pinnedInstallIds and calls runAction', async () => {
      await prefs.pinInstall('inst-10')

      expect(prefs.isPinned('inst-10')).toBe(true)
      expect(window.api.runAction).toHaveBeenCalledWith('inst-10', 'pin-install')
    })

    it('does not duplicate already-pinned ids', async () => {
      await prefs.pinInstall('inst-10')
      await prefs.pinInstall('inst-10')

      expect(prefs.pinnedInstallIds.value.filter((id) => id === 'inst-10').length).toBe(1)
    })
  })

  describe('unpinInstall', () => {
    it('removes id from pinnedInstallIds and calls runAction', async () => {
      await prefs.pinInstall('inst-10')
      expect(prefs.isPinned('inst-10')).toBe(true)

      await prefs.unpinInstall('inst-10')

      expect(prefs.isPinned('inst-10')).toBe(false)
      expect(window.api.runAction).toHaveBeenCalledWith('inst-10', 'unpin-install')
    })

    it('is safe to unpin an id that is not pinned', async () => {
      await prefs.unpinInstall('nonexistent')

      expect(prefs.pinnedInstallIds.value).not.toContain('nonexistent')
      expect(window.api.runAction).toHaveBeenCalledWith('nonexistent', 'unpin-install')
    })
  })
})
