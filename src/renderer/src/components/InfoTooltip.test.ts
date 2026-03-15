import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import InfoTooltip from './InfoTooltip.vue'

describe('InfoTooltip', () => {
  it('renders the tooltip text', () => {
    const wrapper = mount(InfoTooltip, { props: { text: 'Hello tooltip' } })
    expect(wrapper.find('.info-tooltip-bubble').text()).toBe('Hello tooltip')
  })

  it('defaults to top side', () => {
    const wrapper = mount(InfoTooltip, { props: { text: 'tip' } })
    expect(wrapper.find('.info-tooltip-top').exists()).toBe(true)
    expect(wrapper.find('.info-tooltip-bottom').exists()).toBe(false)
  })

  it('supports bottom side', () => {
    const wrapper = mount(InfoTooltip, { props: { text: 'tip', side: 'bottom' } })
    expect(wrapper.find('.info-tooltip-bottom').exists()).toBe(true)
    expect(wrapper.find('.info-tooltip-top').exists()).toBe(false)
  })

  it('renders the icon', () => {
    const wrapper = mount(InfoTooltip, { props: { text: 'tip' } })
    expect(wrapper.find('.info-tooltip-icon').exists()).toBe(true)
  })
})
