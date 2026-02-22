import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import SettingField from './SettingField.vue'
import type { SettingsField } from '../types/ipc'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: {} },
  missingWarn: false,
  fallbackWarn: false
})

function mountField(field: SettingsField) {
  return mount(SettingField, {
    props: { field },
    global: { plugins: [i18n] }
  })
}

describe('SettingField', () => {
  beforeEach(() => {
    ;(window as any).api = {
      setSetting: vi.fn().mockResolvedValue(undefined),
      browseFolder: vi.fn().mockResolvedValue(null),
      openPath: vi.fn().mockResolvedValue(undefined)
    }
  })

  it('renders readonly value as non-editable text', () => {
    const wrapper = mountField({
      id: 'test',
      label: 'Read Only',
      type: 'text',
      value: '/some/path',
      readonly: true
    })
    expect(wrapper.find('.detail-field-value').exists()).toBe(true)
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('select').exists()).toBe(false)
  })

  it('select change calls setSetting and emits setting-updated', async () => {
    const wrapper = mountField({
      id: 'theme',
      label: 'Theme',
      type: 'select',
      value: 'dark',
      options: [
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' }
      ]
    })
    await wrapper.find('select').setValue('light')

    expect(window.api.setSetting).toHaveBeenCalledWith('theme', 'light')
    expect(wrapper.emitted('setting-updated')).toHaveLength(1)
  })

  it('boolean change calls setSetting', async () => {
    const wrapper = mountField({
      id: 'autostart',
      label: 'Auto Start',
      type: 'boolean',
      value: false
    })
    await wrapper.find('input[type="checkbox"]').setValue(true)

    expect(window.api.setSetting).toHaveBeenCalledWith('autostart', true)
    expect(wrapper.emitted('setting-updated')).toHaveLength(1)
  })
})
