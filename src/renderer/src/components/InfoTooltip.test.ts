import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import InfoTooltip from './InfoTooltip.vue'

describe('InfoTooltip', () => {
  it('renders the icon', () => {
    const wrapper = mount(InfoTooltip, { props: { text: 'tip' } })
    expect(wrapper.find('.info-tooltip-icon').exists()).toBe(true)
  })

  it('does not show bubble initially', () => {
    const wrapper = mount(InfoTooltip, { props: { text: 'Hello tooltip' } })
    expect(wrapper.find('.info-tooltip-bubble').exists()).toBe(false)
  })

  it('shows bubble with correct text on mouseenter', async () => {
    const wrapper = mount(InfoTooltip, {
      props: { text: 'Hello tooltip' },
      attachTo: document.body,
    })
    await wrapper.find('.info-tooltip-trigger').trigger('mouseenter')
    const bubble = document.querySelector('.info-tooltip-bubble')
    expect(bubble).not.toBeNull()
    expect(bubble!.textContent).toBe('Hello tooltip')
    wrapper.unmount()
  })

  it('hides bubble on mouseleave', async () => {
    const wrapper = mount(InfoTooltip, {
      props: { text: 'tip' },
      attachTo: document.body,
    })
    await wrapper.find('.info-tooltip-trigger').trigger('mouseenter')
    expect(document.querySelector('.info-tooltip-bubble')).not.toBeNull()
    await wrapper.find('.info-tooltip-trigger').trigger('mouseleave')
    expect(document.querySelector('.info-tooltip-bubble')).toBeNull()
    wrapper.unmount()
  })

  it('defaults to top side positioning', async () => {
    const wrapper = mount(InfoTooltip, {
      props: { text: 'tip' },
      attachTo: document.body,
    })
    await wrapper.find('.info-tooltip-trigger').trigger('mouseenter')
    const bubble = document.querySelector('.info-tooltip-bubble') as HTMLElement
    expect(bubble.style.bottom).toBeTruthy()
    expect(bubble.style.top).toBeFalsy()
    wrapper.unmount()
  })

  it('uses top positioning for bottom side', async () => {
    const wrapper = mount(InfoTooltip, {
      props: { text: 'tip', side: 'bottom' },
      attachTo: document.body,
    })
    await wrapper.find('.info-tooltip-trigger').trigger('mouseenter')
    const bubble = document.querySelector('.info-tooltip-bubble') as HTMLElement
    expect(bubble.style.top).toBeTruthy()
    expect(bubble.style.bottom).toBeFalsy()
    wrapper.unmount()
  })
})
