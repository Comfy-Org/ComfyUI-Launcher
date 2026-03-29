import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ArgsBuilder from './ArgsBuilder.vue'
import type { ComfyArgDef, ElectronApi } from '../../../types/ipc'

const MOCK_ARGS: ComfyArgDef[] = [
  { name: 'port', flag: '--port', help: 'Set the listen port.', type: 'value', metavar: 'PORT', category: 'Network' },
  { name: 'listen', flag: '--listen', help: 'Specify the IP address to listen on.', type: 'optional-value', metavar: 'IP', category: 'Network' },
  { name: 'lowvram', flag: '--lowvram', help: 'Split the unet in parts to use less vram.', type: 'boolean', category: 'GPU & VRAM', exclusiveGroup: 'vram' },
  { name: 'cpu', flag: '--cpu', help: 'To use the CPU for everything (slow).', type: 'boolean', category: 'GPU & VRAM', exclusiveGroup: 'vram' },
  { name: 'highvram', flag: '--highvram', help: 'Keep models in GPU memory.', type: 'boolean', category: 'GPU & VRAM', exclusiveGroup: 'vram' },
  { name: 'verbose', flag: '--verbose', help: 'Set the logging level', type: 'optional-value', choices: ['DEBUG', 'INFO', 'WARNING'], category: 'Logging' },
]

function mountBuilder(modelValue = '', installationId = 'test-inst') {
  return mount(ArgsBuilder, {
    props: { modelValue, installationId },
    attachTo: document.body,
  })
}

describe('ArgsBuilder', () => {
  beforeEach(() => {
    window.api = {
      getComfyArgs: vi.fn().mockResolvedValue({ args: MOCK_ARGS }),
    } as unknown as ElectronApi
  })

  async function ready(modelValue = '', installationId = 'test-inst') {
    const wrapper = mountBuilder(modelValue, installationId)
    await flushPromises()
    return wrapper
  }

  // --- Validation: bare positional args ---

  it('flags bare positional tokens as unsupported', async () => {
    const wrapper = await ready('foo bar')
    const tokens = wrapper.findAll('.token-bad')
    expect(tokens.length).toBe(2)
    expect(tokens[0]!.text()).toBe('foo')
    expect(tokens[1]!.text()).toBe('bar')
    wrapper.unmount()
  })

  it('does not flag a value consumed by a preceding flag', async () => {
    const wrapper = await ready('--port 8188')
    const bad = wrapper.findAll('.token-bad')
    expect(bad.length).toBe(0)
    wrapper.unmount()
  })

  // --- Validation: --flag= with empty value ---

  it('flags --port= (empty inline value) as missing-value', async () => {
    const wrapper = await ready('--port=')
    const missing = wrapper.findAll('.token-missing')
    expect(missing.length).toBeGreaterThanOrEqual(1)
    expect(missing[0]!.text()).toBe('--port=')
    wrapper.unmount()
  })

  it('does not flag --port=8188 (non-empty inline value)', async () => {
    const wrapper = await ready('--port=8188')
    const missing = wrapper.findAll('.token-missing')
    expect(missing.length).toBe(0)
    const bad = wrapper.findAll('.token-bad')
    expect(bad.length).toBe(0)
    wrapper.unmount()
  })

  it('treats --port= d as two separate issues (empty value + orphaned d)', async () => {
    const wrapper = await ready('--port= d')
    const missing = wrapper.findAll('.token-missing')
    expect(missing.some((m) => m.text() === '--port=')).toBe(true)
    const bad = wrapper.findAll('.token-bad')
    expect(bad.some((b) => b.text() === 'd')).toBe(true)
    wrapper.unmount()
  })

  // --- Autocomplete: suppression for required-value flags ---

  it('suppresses autocomplete when typing a value after --port', async () => {
    const wrapper = await ready('--port 81')
    const input = wrapper.find('input')
    await input.trigger('focus')
    await wrapper.setProps({ modelValue: '--port 81' })
    await flushPromises()
    expect(wrapper.find('.args-autocomplete').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows autocomplete when typing after --listen (optional-value)', async () => {
    const wrapper = await ready('')
    const input = wrapper.find('input')
    await input.trigger('focus')
    await input.setValue('--listen low')
    await flushPromises()
    // 'low' matches 'lowvram' and listen is optional-value, so autocomplete should show
    expect(wrapper.find('.args-autocomplete').exists()).toBe(true)
    wrapper.unmount()
  })

  // --- Autocomplete: bare word matching ---

  it('shows autocomplete for bare word matching a flag name exactly', async () => {
    const wrapper = await ready('')
    const input = wrapper.find('input')
    await input.trigger('focus')
    await input.setValue('port')
    await flushPromises()
    expect(wrapper.find('.args-autocomplete').exists()).toBe(true)
    const items = wrapper.findAll('.args-autocomplete-flag')
    expect(items.some((el) => el.text() === '--port')).toBe(true)
    wrapper.unmount()
  })

  it('does not show autocomplete for --port (already has dashes and is complete)', async () => {
    const wrapper = await ready('')
    const input = wrapper.find('input')
    await input.trigger('focus')
    await input.setValue('--port')
    await flushPromises()
    expect(wrapper.find('.args-autocomplete').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows autocomplete for single dash', async () => {
    const wrapper = await ready('')
    const input = wrapper.find('input')
    await input.trigger('focus')
    await input.setValue('-')
    await flushPromises()
    expect(wrapper.find('.args-autocomplete').exists()).toBe(true)
    wrapper.unmount()
  })

  // --- Schema refresh on installationId change ---

  it('re-fetches schema when installationId changes', async () => {
    const wrapper = await ready('', 'inst-a')
    expect(window.api.getComfyArgs).toHaveBeenCalledWith('inst-a')

    await wrapper.setProps({ installationId: 'inst-b' })
    await flushPromises()
    expect(window.api.getComfyArgs).toHaveBeenCalledWith('inst-b')
    wrapper.unmount()
  })

  // --- Exclusive group radio rendering ---

  it('renders exclusive group args as radio buttons in the helper panel', async () => {
    const wrapper = await ready('')
    // Open the helper panel
    await wrapper.find('.args-configure-btn').trigger('click')
    await flushPromises()
    // Should find radio group with "one of" badge
    const badge = wrapper.find('.arg-radio-group-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('one of')
    // Should have radio inputs for the 3 exclusive VRAM args
    const radios = wrapper.findAll('.arg-radio-group input[type="radio"]')
    expect(radios.length).toBe(3)
    wrapper.unmount()
  })

  it('shows exclusive group in active section when one is active', async () => {
    const wrapper = await ready('--lowvram')
    await wrapper.find('.args-configure-btn').trigger('click')
    await flushPromises()
    // Active section should exist and contain a radio group
    const activeGroup = wrapper.find('.args-group-active')
    expect(activeGroup.exists()).toBe(true)
    const activeRadios = activeGroup.findAll('.arg-radio-group input[type="radio"]')
    expect(activeRadios.length).toBe(3)
    wrapper.unmount()
  })
})
