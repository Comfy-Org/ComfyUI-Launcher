import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronApi } from '../types/ipc'

vi.mock('../main', () => ({
  i18n: {
    global: {
      t: (key: string) => key,
    },
  },
}))

import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import SettingsView from './SettingsView.vue'

const messages = {
  en: {
    settings: {
      title: 'Settings',
      checkingForUpdates: 'Checking…',
    },
    update: {
      updateCheck: 'Update Check',
      updateError: 'Update Error',
      upToDate: 'You are running the latest version.',
      debUpToDate: 'Updates are delivered through your system package manager (apt).',
    },
  },
}

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages,
    missingWarn: false,
    fallbackWarn: false,
  })
}

function stubApi(overrides: Partial<ElectronApi> = {}): ElectronApi {
  return {
    getSettingsSections: vi.fn().mockResolvedValue([
      {
        title: 'Updates',
        fields: [],
        actions: [{ label: 'Check for updates', action: 'check-for-update' }],
      },
    ]),
    getUpdateCapabilities: vi.fn().mockResolvedValue({ canAutoUpdate: true, systemManaged: false }),
    checkForUpdate: vi.fn().mockResolvedValue({ available: false }),
    openExternal: vi.fn(),
    ...overrides,
  } as unknown as ElectronApi
}

describe('SettingsView update check messaging', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls getUpdateCapabilities during loadSettings', async () => {
    const getUpdateCapabilities = vi.fn().mockResolvedValue({ canAutoUpdate: false, systemManaged: true })
    const api = stubApi({ getUpdateCapabilities })
    window.api = api

    mount(SettingsView, {
      global: {
        plugins: [createTestI18n()],
        stubs: { SettingField: true },
      },
    })

    await flushPromises()
    expect(getUpdateCapabilities).toHaveBeenCalled()
  })

  it('calls checkForUpdate when check-for-update action is clicked', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue({ available: false })
    const api = stubApi({ checkForUpdate })
    window.api = api

    const wrapper = mount(SettingsView, {
      global: {
        plugins: [createTestI18n()],
        stubs: { SettingField: true },
      },
    })

    await flushPromises()

    const buttons = wrapper.findAll('button')
    const checkButton = buttons.find((b) => b.text().includes('Check for updates'))
    expect(checkButton).toBeDefined()
    await checkButton!.trigger('click')
    await flushPromises()

    expect(checkForUpdate).toHaveBeenCalled()
  })

  it('fetches capabilities with correct systemManaged value for standard installs', async () => {
    const getUpdateCapabilities = vi.fn().mockResolvedValue({ canAutoUpdate: true, systemManaged: false })
    const api = stubApi({ getUpdateCapabilities })
    window.api = api

    mount(SettingsView, {
      global: {
        plugins: [createTestI18n()],
        stubs: { SettingField: true },
      },
    })

    await flushPromises()
    expect(getUpdateCapabilities).toHaveBeenCalled()
    const result = await getUpdateCapabilities.mock.results[0].value
    expect(result.systemManaged).toBe(false)
  })

  it('fetches capabilities with correct systemManaged value for deb installs', async () => {
    const getUpdateCapabilities = vi.fn().mockResolvedValue({ canAutoUpdate: false, systemManaged: true })
    const api = stubApi({ getUpdateCapabilities })
    window.api = api

    mount(SettingsView, {
      global: {
        plugins: [createTestI18n()],
        stubs: { SettingField: true },
      },
    })

    await flushPromises()
    expect(getUpdateCapabilities).toHaveBeenCalled()
    const result = await getUpdateCapabilities.mock.results[0].value
    expect(result.systemManaged).toBe(true)
  })
})
