import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActionResult } from '../types/ipc'
import { useProgressStore } from './progressStore'
import { useSessionStore } from './sessionStore'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  })
}))

vi.stubGlobal('window', {
  ...window,
  api: {
    getInstallations: vi.fn().mockResolvedValue([]),
    onInstallationsChanged: vi.fn(),
    onInstallProgress: vi.fn(() => vi.fn()),
    onComfyOutput: vi.fn(() => vi.fn()),
    cancelOperation: vi.fn(),
    stopComfyUI: vi.fn(),
    getRunningInstances: vi.fn().mockResolvedValue([]),
    onInstanceStarted: vi.fn(() => vi.fn()),
    onInstanceStopped: vi.fn(() => vi.fn()),
    onComfyExited: vi.fn(() => vi.fn()),
    onErrorDetail: vi.fn(() => vi.fn()),
  }
})

describe('useProgressStore', () => {
  let store: ReturnType<typeof useProgressStore>
  let sessionStore: ReturnType<typeof useSessionStore>

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    store = useProgressStore()
    sessionStore = useSessionStore()
    vi.clearAllMocks()
  })

  describe('getProgressInfo', () => {
    it('returns null when no operation exists', () => {
      expect(store.getProgressInfo('inst-1')).toBeNull()
    })

    it('returns null when operation is finished', async () => {
      const apiCall = vi.fn().mockResolvedValue({ ok: true } as ActionResult)
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall,
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      expect(store.getProgressInfo('inst-1')).toBeNull()
    })

    it('returns flat status and percent when no steps defined', () => {
      const apiCall = () => new Promise<ActionResult>(() => {}) // never resolves
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall,
      })

      const op = store.operations.get('inst-1')!
      op.flatStatus = 'Downloading...'
      op.flatPercent = 42

      const info = store.getProgressInfo('inst-1')
      expect(info).toEqual({ status: 'Downloading...', percent: 42 })
    })

    it('returns step-based status when steps and activePhase are set', () => {
      const apiCall = () => new Promise<ActionResult>(() => {})
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall,
      })

      const op = store.operations.get('inst-1')!
      op.steps = [
        { phase: 'download', label: 'Download' },
        { phase: 'extract', label: 'Extract' }
      ]
      op.activePhase = 'download'
      op.lastStatus['download'] = 'Fetching files...'
      op.activePercent = 75

      const info = store.getProgressInfo('inst-1')
      expect(info).toEqual({ status: 'Fetching files...', percent: 75 })
    })

    it('falls back to phase name when lastStatus has no entry', () => {
      const apiCall = () => new Promise<ActionResult>(() => {})
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall,
      })

      const op = store.operations.get('inst-1')!
      op.steps = [{ phase: 'download', label: 'Download' }]
      op.activePhase = 'download'
      op.activePercent = 0

      const info = store.getProgressInfo('inst-1')
      expect(info).toEqual({ status: 'download', percent: 0 })
    })

    it('falls back to title when flatStatus is empty', () => {
      const apiCall = () => new Promise<ActionResult>(() => {})
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall,
      })

      const op = store.operations.get('inst-1')!
      op.flatStatus = ''

      const info = store.getProgressInfo('inst-1')
      expect(info?.status).toBe('Install')
    })
  })

  describe('startOperation', () => {
    it('creates an operation and sets up session', () => {
      const apiCall = () => new Promise<ActionResult>(() => {})
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install ComfyUI',
        apiCall,
      })

      expect(store.operations.has('inst-1')).toBe(true)
      const op = store.operations.get('inst-1')!
      expect(op.title).toBe('Install ComfyUI')
      expect(op.finished).toBe(false)
      expect(op.error).toBeNull()
    })

    it('subscribes to progress and output IPC', () => {
      const apiCall = () => new Promise<ActionResult>(() => {})
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall,
      })

      expect(window.api.onInstallProgress).toHaveBeenCalled()
      expect(window.api.onComfyOutput).toHaveBeenCalled()
    })

    it('marks operation finished with error on apiCall rejection', async () => {
      const apiCall = vi.fn().mockRejectedValue(new Error('Network failure'))
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall,
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      const op = store.operations.get('inst-1')!
      expect(op.error).toBe('Network failure')
    })

    it('marks operation finished on successful apiCall', async () => {
      const apiCall = vi.fn().mockResolvedValue({ ok: true } as ActionResult)
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall,
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      const op = store.operations.get('inst-1')!
      expect(op.error).toBeNull()
      expect(op.result).toEqual({ ok: true })
    })

    it('sets error on non-ok result', async () => {
      const apiCall = vi.fn().mockResolvedValue({ ok: false, message: 'Bad config' } as ActionResult)
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall,
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      const op = store.operations.get('inst-1')!
      expect(op.error).toBe('Bad config')
      expect(sessionStore.errorInstances.has('inst-1')).toBe(true)
    })

    it('does not set error on cancelled result', async () => {
      const apiCall = vi.fn().mockResolvedValue({ ok: false, cancelled: true } as ActionResult)
      store.startOperation({
        installationId: 'inst-1',
        title: 'Launch',
        apiCall,
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      const op = store.operations.get('inst-1')!
      expect(op.error).toBeNull()
      expect(op.result?.cancelled).toBe(true)
      expect(sessionStore.errorInstances.has('inst-1')).toBe(false)
    })

    it('clears active session on cancellation', async () => {
      const apiCall = vi.fn().mockResolvedValue({ ok: false, cancelled: true } as ActionResult)
      store.startOperation({
        installationId: 'inst-1',
        title: 'Launch',
        apiCall,
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      expect(sessionStore.activeSessions.has('inst-1')).toBe(false)
    })

    it('cleans up previous operation for same installationId', () => {
      const unsub1 = vi.fn()
      vi.mocked(window.api.onInstallProgress).mockReturnValueOnce(unsub1)

      store.startOperation({
        installationId: 'inst-1',
        title: 'First',
        apiCall: () => new Promise<ActionResult>(() => {}),
      })

      store.startOperation({
        installationId: 'inst-1',
        title: 'Second',
        apiCall: () => new Promise<ActionResult>(() => {}),
      })

      expect(store.operations.get('inst-1')?.title).toBe('Second')
    })

    it('sets result on port conflict without error', async () => {
      const portConflictInfo = { port: 8188, pids: [123], isComfy: true }
      const apiCall = vi.fn().mockResolvedValue({ ok: false, portConflict: portConflictInfo } as ActionResult)
      store.startOperation({
        installationId: 'inst-1',
        title: 'Launch',
        apiCall,
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      const op = store.operations.get('inst-1')!
      expect(op.error).toBeNull()
      expect(op.result?.portConflict).toEqual(portConflictInfo)
      expect(sessionStore.errorInstances.has('inst-1')).toBe(false)
    })

    it('handles synchronous apiCall throw', () => {
      const apiCall = () => { throw new Error('Sync boom') }
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall: apiCall as unknown as () => Promise<ActionResult>,
      })

      const op = store.operations.get('inst-1')!
      expect(op.error).toBe('Sync boom')
      expect(op.finished).toBe(true)
    })
  })

  describe('cancelOperation', () => {
    it('sets cancelRequested and calls IPC cancel/stop', () => {
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall: () => new Promise<ActionResult>(() => {}),
      })

      store.cancelOperation('inst-1')

      const op = store.operations.get('inst-1')!
      expect(op.cancelRequested).toBe(true)
      expect(window.api.cancelOperation).toHaveBeenCalledWith('inst-1')
      expect(window.api.stopComfyUI).toHaveBeenCalledWith('inst-1')
    })

    it('is safe to cancel a nonexistent operation', () => {
      expect(() => store.cancelOperation('nonexistent')).not.toThrow()
    })
  })

  describe('cleanupOperation', () => {
    it('calls unsubscribe functions', () => {
      const unsubProgress = vi.fn()
      const unsubOutput = vi.fn()
      vi.mocked(window.api.onInstallProgress).mockReturnValueOnce(unsubProgress)
      vi.mocked(window.api.onComfyOutput).mockReturnValueOnce(unsubOutput)

      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall: () => new Promise<ActionResult>(() => {}),
      })

      store.cleanupOperation('inst-1')

      expect(unsubProgress).toHaveBeenCalled()
      expect(unsubOutput).toHaveBeenCalled()
    })

    it('is safe to cleanup a nonexistent operation', () => {
      expect(() => store.cleanupOperation('nonexistent')).not.toThrow()
    })
  })
})
