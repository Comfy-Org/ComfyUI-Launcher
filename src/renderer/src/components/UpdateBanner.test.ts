import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronApi } from '../types/ipc'

vi.mock('../main', () => ({
  i18n: {
    global: {
      t: (key: string) => key,
    },
  },
}))

import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import UpdateBanner from './UpdateBanner.vue'

const messages = {
  en: {
    update: {
      available: 'Update available: **v{version}**',
      download: 'Download',
      dismiss: 'Dismiss',
      downloading: 'Downloading update… {progress}',
      ready: 'Update **v{version}** ready to install',
      restartUpdate: 'Restart & Update',
      later: 'Later',
      checkFailed: 'Update check failed',
      details: 'Details',
      retry: 'Retry',
      updateCheck: 'Update Check',
      updateError: 'Update Error',
      upToDate: 'You are running the latest version.',
      debAvailable: 'Update **v{version}** is available. Run apt to update.',
      debUpToDate: 'Updates are delivered through your system package manager.',
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
    checkForUpdate: vi.fn().mockResolvedValue({ available: false }),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    installUpdate: vi.fn().mockResolvedValue(undefined),
    getPendingUpdate: vi.fn().mockResolvedValue(null),
    getUpdateCapabilities: vi.fn().mockResolvedValue({ canAutoUpdate: true, systemManaged: false }),
    onUpdateAvailable: vi.fn(() => vi.fn()),
    onUpdateDownloadProgress: vi.fn(() => vi.fn()),
    onUpdateDownloaded: vi.fn(() => vi.fn()),
    onUpdateError: vi.fn(() => vi.fn()),
    ...overrides,
  } as unknown as ElectronApi
}

function mountBanner(api: ElectronApi) {
  window.api = api
  return mount(UpdateBanner, {
    global: { plugins: [createTestI18n()] },
  })
}

describe('UpdateBanner', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('standard install (canAutoUpdate: true)', () => {
    it('shows Download button when update is available', async () => {
      const onUpdateAvailable = vi.fn((cb: (info: { version: string }) => void) => {
        setTimeout(() => cb({ version: '1.2.0' }), 0)
        return vi.fn()
      })
      const api = stubApi({ onUpdateAvailable })
      const wrapper = mountBanner(api)

      await vi.waitFor(() => {
        expect(wrapper.text()).toContain('1.2.0')
      })

      expect(wrapper.find('button.primary').exists()).toBe(true)
      expect(wrapper.find('button.primary').text()).toBe('Download')
    })

    it('shows standard available message', async () => {
      const onUpdateAvailable = vi.fn((cb: (info: { version: string }) => void) => {
        setTimeout(() => cb({ version: '2.0.0' }), 0)
        return vi.fn()
      })
      const api = stubApi({ onUpdateAvailable })
      const wrapper = mountBanner(api)

      await vi.waitFor(() => {
        expect(wrapper.text()).toContain('2.0.0')
      })

      const bannerHtml = wrapper.find('.update-banner-message').html()
      expect(bannerHtml).toContain('Update available')
      expect(bannerHtml).not.toContain('apt')
    })
  })

  describe('system-managed install (canAutoUpdate: false, systemManaged: true)', () => {
    it('hides Download button when update is available', async () => {
      const onUpdateAvailable = vi.fn((cb: (info: { version: string }) => void) => {
        setTimeout(() => cb({ version: '1.2.0' }), 0)
        return vi.fn()
      })
      const api = stubApi({
        getUpdateCapabilities: vi.fn().mockResolvedValue({ canAutoUpdate: false, systemManaged: true }),
        onUpdateAvailable,
      })
      const wrapper = mountBanner(api)

      await vi.waitFor(() => {
        expect(wrapper.text()).toContain('1.2.0')
      })

      expect(wrapper.findAll('button.primary').length).toBe(0)
    })

    it('shows apt-specific message when update is available', async () => {
      const onUpdateAvailable = vi.fn((cb: (info: { version: string }) => void) => {
        setTimeout(() => cb({ version: '1.2.0' }), 0)
        return vi.fn()
      })
      const api = stubApi({
        getUpdateCapabilities: vi.fn().mockResolvedValue({ canAutoUpdate: false, systemManaged: true }),
        onUpdateAvailable,
      })
      const wrapper = mountBanner(api)

      await vi.waitFor(() => {
        expect(wrapper.text()).toContain('1.2.0')
      })

      const bannerHtml = wrapper.find('.update-banner-message').html()
      expect(bannerHtml).toContain('apt')
    })

    it('still shows Dismiss button', async () => {
      const onUpdateAvailable = vi.fn((cb: (info: { version: string }) => void) => {
        setTimeout(() => cb({ version: '1.2.0' }), 0)
        return vi.fn()
      })
      const api = stubApi({
        getUpdateCapabilities: vi.fn().mockResolvedValue({ canAutoUpdate: false, systemManaged: true }),
        onUpdateAvailable,
      })
      const wrapper = mountBanner(api)

      await vi.waitFor(() => {
        expect(wrapper.text()).toContain('1.2.0')
      })

      expect(wrapper.text()).toContain('Dismiss')
    })
  })

  describe('shared behavior (unchanged regardless of install type)', () => {
    it('ready state shows Restart & Update and Later buttons', async () => {
      const onUpdateDownloaded = vi.fn((cb: (info: { version: string }) => void) => {
        setTimeout(() => cb({ version: '1.3.0' }), 0)
        return vi.fn()
      })
      const api = stubApi({ onUpdateDownloaded })
      const wrapper = mountBanner(api)

      await vi.waitFor(() => {
        expect(wrapper.text()).toContain('1.3.0')
      })

      expect(wrapper.text()).toContain('Restart & Update')
      expect(wrapper.text()).toContain('Later')
    })

    it('error state shows Details, Retry, and Dismiss buttons', async () => {
      const onUpdateError = vi.fn((cb: (err: { message: string }) => void) => {
        setTimeout(() => cb({ message: 'Network error' }), 0)
        return vi.fn()
      })
      const api = stubApi({ onUpdateError })
      const wrapper = mountBanner(api)

      await vi.waitFor(() => {
        expect(wrapper.text()).toContain('Update check failed')
      })

      expect(wrapper.text()).toContain('Details')
      expect(wrapper.text()).toContain('Retry')
      expect(wrapper.text()).toContain('Dismiss')
    })

    it('downloading state shows no action buttons', async () => {
      const onUpdateDownloadProgress = vi.fn((cb: (progress: { transferred: string; total: string; percent: number }) => void) => {
        setTimeout(() => cb({ transferred: '5.0', total: '20.0', percent: 25 }), 0)
        return vi.fn()
      })
      const api = stubApi({ onUpdateDownloadProgress })
      const wrapper = mountBanner(api)

      await vi.waitFor(() => {
        expect(wrapper.text()).toContain('Downloading')
      })

      expect(wrapper.findAll('button').length).toBe(0)
    })
  })
})
