import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import DetailSection from './DetailSection.vue'
import type { ActionDef } from '../types/ipc'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: {} },
  missingWarn: false,
  fallbackWarn: false
})

const defaultProps = {
  installationId: 'test-install-1'
}

function mountComponent(props: Record<string, unknown> = {}) {
  return mount(DetailSection, {
    props: { ...defaultProps, ...props },
    global: { plugins: [i18n] }
  })
}

beforeEach(() => {
  ;(window as any).api = {
    updateInstallation: vi.fn().mockResolvedValue({}),
    runAction: vi.fn().mockResolvedValue({ navigate: undefined })
  }
})

describe('DetailSection', () => {
  it('starts collapsed when collapsed=true', () => {
    const wrapper = mountComponent({ title: 'Collapsible', collapsed: true })
    expect((wrapper.find('.detail-section-body').element as HTMLElement).style.display).toBe('none')
  })

  it('toggles collapse on title click', async () => {
    const wrapper = mountComponent({ title: 'Toggle Me', collapsed: true })
    const bodyEl = wrapper.find('.detail-section-body').element as HTMLElement

    expect(bodyEl.style.display).toBe('none')

    await wrapper.find('.detail-section-title').trigger('click')
    expect(bodyEl.style.display).not.toBe('none')

    await wrapper.find('.detail-section-title').trigger('click')
    expect(bodyEl.style.display).toBe('none')
  })

  it('is not collapsible when collapsed=null', async () => {
    const wrapper = mountComponent({ title: 'Static', collapsed: null })
    const bodyEl = wrapper.find('.detail-section-body').element as HTMLElement

    expect(bodyEl.style.display).not.toBe('none')

    await wrapper.find('.detail-section-title').trigger('click')
    expect(bodyEl.style.display).not.toBe('none')
  })

  it('emits run-action with the action def when action button clicked', async () => {
    const actions: ActionDef[] = [{ id: 'a1', label: 'Launch' }]
    const wrapper = mountComponent({ actions })

    await wrapper.find('.detail-actions button').trigger('click')

    const emitted = wrapper.emitted('run-action')!
    expect(emitted).toHaveLength(1)
    expect(emitted[0]![0]).toEqual(actions[0])
  })
})
