import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionStore } from './sessionStore'

describe('useSessionStore', () => {
  let store: ReturnType<typeof useSessionStore>

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    store = useSessionStore()
    vi.clearAllMocks()
  })

  describe('setActiveSession', () => {
    it('clears error for same installation id', () => {
      store.errorInstances.set('inst-1', { installationName: 'Test' })

      store.setActiveSession('inst-1', 'Label')

      expect(store.errorInstances.has('inst-1')).toBe(false)
    })
  })

  describe('clearActiveSession', () => {
    beforeEach(() => {
      store.setActiveSession('inst-1', 'Label 1')
      store.setActiveSession('inst-2', 'Label 2')
    })

    it('clears a specific session when id is provided', () => {
      store.clearActiveSession('inst-1')

      expect(store.activeSessions.has('inst-1')).toBe(false)
      expect(store.activeSessions.has('inst-2')).toBe(true)
    })

    it('clears all sessions when no id is provided', () => {
      store.clearActiveSession()

      expect(store.activeSessions.size).toBe(0)
    })
  })

  describe('clearErrorInstance', () => {
    it('deletes both the error instance and its session', () => {
      store.startSession('inst-1')
      store.errorInstances.set('inst-1', { installationName: 'Test' })

      store.clearErrorInstance('inst-1')

      expect(store.errorInstances.has('inst-1')).toBe(false)
      expect(store.sessions.has('inst-1')).toBe(false)
    })
  })

  describe('appendOutput', () => {
    it('appends text to an existing session', () => {
      store.startSession('inst-1')
      store.appendOutput('inst-1', 'hello ')
      store.appendOutput('inst-1', 'world')

      expect(store.getSession('inst-1')?.output).toBe('hello world')
    })

    it('creates a new session if one does not exist', () => {
      store.appendOutput('inst-1', 'auto-created')

      expect(store.hasSession('inst-1')).toBe(true)
      expect(store.getSession('inst-1')?.output).toBe('auto-created')
    })
  })

  describe('runningTabCount', () => {
    it('sums both active sessions and running instances', () => {
      store.setActiveSession('inst-1', 'A')
      store.runningInstances.set('inst-2', {
        installationId: 'inst-2',
        installationName: 'Test',
        mode: 'run'
      })

      expect(store.runningTabCount).toBe(2)
    })
  })

  describe('hasErrors', () => {
    it('reflects whether error instances exist', () => {
      expect(store.hasErrors).toBe(false)

      store.errorInstances.set('inst-1', { installationName: 'Test' })

      expect(store.hasErrors).toBe(true)
    })
  })
})
