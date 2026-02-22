import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useElectronApi } from './useElectronApi'

describe('useElectronApi', () => {
  beforeEach(() => {
    ;(window as any).api = { testMethod: vi.fn() }
  })

  it('returns window.api reference', () => {
    const { api } = useElectronApi()
    expect(api).toBe((window as any).api)
  })

  it('listen() calls the subscribe function with the callback', () => {
    const { listen } = useElectronApi()
    const subscribe = vi.fn(() => vi.fn())
    const callback = vi.fn()

    listen(subscribe, callback)

    expect(subscribe).toHaveBeenCalledWith(callback)
  })

  it('listen() returns the unsubscribe function from subscribe', () => {
    const { listen } = useElectronApi()
    const unsub = vi.fn()
    const subscribe = vi.fn(() => unsub)

    const result = listen(subscribe, vi.fn())

    expect(result).toBe(unsub)
  })

  it('cleanup() calls all accumulated unsubscribe functions', () => {
    const { listen, cleanup } = useElectronApi()
    const unsub1 = vi.fn()
    const unsub2 = vi.fn()

    listen(vi.fn(() => unsub1), vi.fn())
    listen(vi.fn(() => unsub2), vi.fn())

    cleanup()

    expect(unsub1).toHaveBeenCalledOnce()
    expect(unsub2).toHaveBeenCalledOnce()
  })

  it('cleanup() clears the internal array so calling it twice does not double-call', () => {
    const { listen, cleanup } = useElectronApi()
    const unsub = vi.fn()

    listen(vi.fn(() => unsub), vi.fn())

    cleanup()
    cleanup()

    expect(unsub).toHaveBeenCalledOnce()
  })

  it('multiple listen() calls accumulate and all get cleaned up', () => {
    const { listen, cleanup } = useElectronApi()
    const unsubs = [vi.fn(), vi.fn(), vi.fn()]

    unsubs.forEach((unsub) => {
      listen(vi.fn(() => unsub), vi.fn())
    })

    cleanup()

    for (const unsub of unsubs) {
      expect(unsub).toHaveBeenCalledOnce()
    }
  })
})
