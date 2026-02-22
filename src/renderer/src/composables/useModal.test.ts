import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ModalSelectItem, ModalOption } from './useModal'

vi.mock('../main', () => ({
  i18n: {
    global: {
      t: (key: string) => key
    }
  }
}))

import { useModal } from './useModal'

describe('useModal', () => {
  const modal = useModal()

  beforeEach(() => {
    modal.close(null)
  })

  describe('alert', () => {
    it('resolves on close', async () => {
      const promise = modal.alert({ title: 'T', message: 'M' })
      modal.close(undefined)

      await expect(promise).resolves.toBeUndefined()
    })

    it('uses i18n key as default buttonLabel', () => {
      modal.alert({ title: 'T', message: 'M' })
      expect(modal.state.buttonLabel).toBe('modal.ok')
    })

    it('uses custom buttonLabel when provided', () => {
      modal.alert({ title: 'T', message: 'M', buttonLabel: 'Got it' })
      expect(modal.state.buttonLabel).toBe('Got it')
    })
  })

  describe('confirm', () => {
    it('resolves true when closed with true', async () => {
      const promise = modal.confirm({ title: 'T', message: 'M' })
      modal.close(true)

      await expect(promise).resolves.toBe(true)
    })

    it('resolves false when closed with false', async () => {
      const promise = modal.confirm({ title: 'T', message: 'M' })
      modal.close(false)

      await expect(promise).resolves.toBe(false)
    })
  })

  describe('prompt', () => {
    it('resolves with string value on close', async () => {
      const promise = modal.prompt({ title: 'T', message: 'M' })
      modal.close('user input')

      await expect(promise).resolves.toBe('user input')
    })

    it('resolves with null when cancelled', async () => {
      const promise = modal.prompt({ title: 'T', message: 'M' })
      modal.close(null)

      await expect(promise).resolves.toBeNull()
    })
  })

  describe('select', () => {
    const items: ModalSelectItem[] = [
      { value: 'a', label: 'Option A' },
      { value: 'b', label: 'Option B' }
    ]

    it('resolves with selected value on close', async () => {
      const promise = modal.select({ title: 'T', items })
      modal.close('b')

      await expect(promise).resolves.toBe('b')
    })

    it('resolves with null when cancelled', async () => {
      const promise = modal.select({ title: 'T', items })
      modal.close(null)

      await expect(promise).resolves.toBeNull()
    })
  })

  describe('confirmWithOptions', () => {
    const options: ModalOption[] = [
      { id: 'opt1', label: 'Option 1', checked: true },
      { id: 'opt2', label: 'Option 2', checked: false }
    ]

    it('copies options rather than using the same reference', () => {
      modal.confirmWithOptions({ title: 'T', message: 'M', options })

      expect(modal.state.options).not.toBe(options)
      expect(modal.state.options[0]).not.toBe(options[0])
    })

    it('resolves with record on close', async () => {
      const promise = modal.confirmWithOptions({ title: 'T', message: 'M', options })
      const result = { opt1: true, opt2: false }
      modal.close(result)

      await expect(promise).resolves.toEqual(result)
    })
  })

  describe('close', () => {
    it('resets state after resolving', () => {
      modal.confirm({ title: 'Test', message: 'Msg', confirmStyle: 'primary' })
      expect(modal.state.visible).toBe(true)

      modal.close(false)

      expect(modal.state.visible).toBe(false)
      expect(modal.state.resolve).toBeNull()
    })

    it('is safe to call when no modal is open', () => {
      expect(() => modal.close(null)).not.toThrow()
    })
  })
})
