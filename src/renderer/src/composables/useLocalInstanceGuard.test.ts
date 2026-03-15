import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  })
}))

const mockSelect = vi.fn()
vi.mock('./useModal', () => ({
  useModal: () => ({
    select: mockSelect
  })
}))

vi.stubGlobal('window', {
  ...window,
  api: {
    getInstallations: vi.fn().mockResolvedValue([]),
    onInstallationsChanged: vi.fn(),
    onInstallationsVersionsUpdated: vi.fn(),
    stopComfyUI: vi.fn().mockResolvedValue(undefined),
  }
})

import { useLocalInstanceGuard } from './useLocalInstanceGuard'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import type { Installation } from '../types/ipc'

function makeInstallation(overrides: Partial<Installation> = {}): Installation {
  return {
    id: 'inst-1',
    name: 'Test Install',
    sourceLabel: 'standalone',
    sourceCategory: 'local',
    ...overrides,
  }
}

describe('useLocalInstanceGuard', () => {
  let sessionStore: ReturnType<typeof useSessionStore>
  let installationStore: ReturnType<typeof useInstallationStore>

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    sessionStore = useSessionStore()
    installationStore = useInstallationStore()
    vi.clearAllMocks()
  })

  it('allows launch when no other instances are running or launching', async () => {
    installationStore.installations.push(makeInstallation({ id: 'target' }))
    const guard = useLocalInstanceGuard()

    const result = await guard.checkBeforeLaunch('target')

    expect(result).toBe(true)
  })

  it('allows launch without prompting for non-local (cloud) targets', async () => {
    installationStore.installations.push(makeInstallation({ id: 'cloud-1', sourceCategory: 'cloud' }))
    sessionStore.runningInstances.set('other', {
      installationId: 'other',
      installationName: 'Other',
      mode: 'window',
    })
    const guard = useLocalInstanceGuard()

    const result = await guard.checkBeforeLaunch('cloud-1')

    expect(result).toBe(true)
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('prompts when another local instance is running', async () => {
    installationStore.installations.push(
      makeInstallation({ id: 'target' }),
      makeInstallation({ id: 'running-1', name: 'Running Install' }),
    )
    sessionStore.runningInstances.set('running-1', {
      installationId: 'running-1',
      installationName: 'Running Install',
      mode: 'window',
    })
    mockSelect.mockResolvedValue('proceed')
    const guard = useLocalInstanceGuard()

    const result = await guard.checkBeforeLaunch('target')

    expect(mockSelect).toHaveBeenCalled()
    expect(result).toBe(true)
  })

  it('prompts when another local instance is launching (not yet fully booted)', async () => {
    installationStore.installations.push(
      makeInstallation({ id: 'target' }),
      makeInstallation({ id: 'launching-1', name: 'Launching Install' }),
    )
    sessionStore.launchingInstances.set('launching-1', {
      installationName: 'Launching Install',
    })
    mockSelect.mockResolvedValue('proceed')
    const guard = useLocalInstanceGuard()

    const result = await guard.checkBeforeLaunch('target')

    expect(mockSelect).toHaveBeenCalled()
    expect(result).toBe(true)
  })

  it('does not prompt for instances that are the target itself', async () => {
    installationStore.installations.push(makeInstallation({ id: 'target' }))
    sessionStore.launchingInstances.set('target', {
      installationName: 'Target',
    })
    const guard = useLocalInstanceGuard()

    const result = await guard.checkBeforeLaunch('target')

    expect(result).toBe(true)
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('returns false when user cancels the prompt', async () => {
    installationStore.installations.push(
      makeInstallation({ id: 'target' }),
      makeInstallation({ id: 'other' }),
    )
    sessionStore.runningInstances.set('other', {
      installationId: 'other',
      installationName: 'Other',
      mode: 'window',
    })
    mockSelect.mockResolvedValue(null)
    const guard = useLocalInstanceGuard()

    const result = await guard.checkBeforeLaunch('target')

    expect(result).toBe(false)
  })

  it('stops running instances when user chooses replace', async () => {
    installationStore.installations.push(
      makeInstallation({ id: 'target' }),
      makeInstallation({ id: 'other' }),
    )
    sessionStore.runningInstances.set('other', {
      installationId: 'other',
      installationName: 'Other',
      mode: 'window',
    })
    mockSelect.mockResolvedValue('replace')
    const guard = useLocalInstanceGuard()

    const result = await guard.checkBeforeLaunch('target')

    expect(window.api.stopComfyUI).toHaveBeenCalledWith('other')
    expect(result).toBe(true)
  })
})
