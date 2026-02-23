import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'

import InstanceCard from './InstanceCard.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: {} },
  missingWarn: false,
  fallbackWarn: false
})

const mountComponent = (props = {}, options = {}) => {
  return mount(InstanceCard, {
    global: { plugins: [i18n] },
    props: { name: 'Test Install', ...props },
    ...options
  })
}

describe('InstanceCard', () => {
  it('shows drag handle only when draggable', () => {
    expect(mountComponent({ draggable: true }).find('.drag-handle').exists()).toBe(true)
    expect(mountComponent({ draggable: false }).find('.drag-handle').exists()).toBe(false)
  })

  it('does not render instance-meta wrapper when meta slot is empty', () => {
    const wrapper = mountComponent()
    expect(wrapper.find('.instance-meta').exists()).toBe(false)
  })

  it('renders instance-meta wrapper when meta slot has content', () => {
    const wrapper = mountComponent({}, { slots: { meta: '<span>v1.0</span>' } })
    expect(wrapper.find('.instance-meta').exists()).toBe(true)
  })
})
