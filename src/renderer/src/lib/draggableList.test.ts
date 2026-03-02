import { afterEach, describe, expect, it, vi } from 'vitest'
import { DraggableList } from './draggableList'

/**
 * Builds a minimal DOM container with n items and a drag handle in each.
 * Items are laid out vertically with fixed 50px height + 10px gap.
 *
 * getBoundingClientRect is patched to read any inline `translate()` transform
 * so the DraggableList midpoint comparisons work in happy-dom (which ignores
 * CSS transforms).
 */
function buildList(count: number, itemHeight = 50, gap = 10): HTMLElement {
  const container = document.createElement('div')
  container.getBoundingClientRect = () => ({
    top: 0, bottom: count * (itemHeight + gap), left: 0, right: 100,
    width: 100, height: count * (itemHeight + gap), x: 0, y: 0, toJSON: () => {}
  })

  for (let i = 0; i < count; i++) {
    const item = document.createElement('div')
    item.classList.add('item')
    item.dataset.id = String(i)

    const baseTop = i * (itemHeight + gap)
    item.getBoundingClientRect = () => {
      let offsetY = 0
      const m = item.style.transform?.match(/translate\([\d.+-]+px,\s*([-\d.]+)px\)/)
      if (m) offsetY = parseFloat(m[1])
      return {
        top: baseTop + offsetY, bottom: baseTop + itemHeight + offsetY,
        left: 0, right: 100, width: 100, height: itemHeight,
        x: 0, y: baseTop + offsetY, toJSON: () => {}
      }
    }

    const handle = document.createElement('div')
    handle.classList.add('drag-handle')
    item.appendChild(handle)
    container.appendChild(item)
  }
  document.body.appendChild(container)
  return container
}

function mousedown(target: HTMLElement, clientY: number): void {
  target.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientY, clientX: 0, bubbles: true }))
}

function mousemove(clientY: number): void {
  document.dispatchEvent(new MouseEvent('mousemove', { clientY, clientX: 0, bubbles: true }))
}

function mouseup(): void {
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}

describe('DraggableList', () => {
  let container: HTMLElement
  let draggable: DraggableList

  afterEach(() => {
    draggable?.dispose()
    container?.remove()
  })

  describe('initialization', () => {
    it('ignores non-left-button clicks', () => {
      container = buildList(2)
      const onReorder = vi.fn()
      draggable = new DraggableList(container, '.item', { onReorder })

      const handle = container.querySelectorAll('.drag-handle')[0] as HTMLElement
      handle.dispatchEvent(new MouseEvent('mousedown', { button: 2, clientY: 25, bubbles: true }))
      mouseup()

      expect(onReorder).not.toHaveBeenCalled()
    })

    it('ignores clicks outside drag handle', () => {
      container = buildList(2)
      const onReorder = vi.fn()
      draggable = new DraggableList(container, '.item', { onReorder })

      const item = container.querySelectorAll('.item')[0] as HTMLElement
      mousedown(item, 25)
      mouseup()

      expect(onReorder).not.toHaveBeenCalled()
    })
  })

  describe('reorder callback', () => {
    it('does not fire when item is dropped in place', () => {
      container = buildList(3)
      const onReorder = vi.fn()
      draggable = new DraggableList(container, '.item', { onReorder })

      const handle = container.querySelectorAll('.drag-handle')[0] as HTMLElement
      mousedown(handle, 25)
      mousemove(30)
      mouseup()

      expect(onReorder).not.toHaveBeenCalled()
    })

    it('fires with correct indices when dragging item 0 past item 1', () => {
      container = buildList(3)
      const onReorder = vi.fn()
      draggable = new DraggableList(container, '.item', { onReorder })

      const handle = container.querySelectorAll('.drag-handle')[0] as HTMLElement
      // Item midpoints: 0→25, 1→85, 2→145
      mousedown(handle, 25)
      // First move sets the transform; second move reads the shifted rect
      mousemove(90)
      mousemove(90)
      mouseup()

      expect(onReorder).toHaveBeenCalledWith(0, 1)
    })

    it('fires with correct indices when dragging item 0 past item 2', () => {
      container = buildList(3)
      const onReorder = vi.fn()
      draggable = new DraggableList(container, '.item', { onReorder })

      const handle = container.querySelectorAll('.drag-handle')[0] as HTMLElement
      mousedown(handle, 25)
      mousemove(150)
      mousemove(150)
      mouseup()

      expect(onReorder).toHaveBeenCalledWith(0, 2)
    })

    it('fires with correct indices when dragging last item up to first', () => {
      container = buildList(3)
      const onReorder = vi.fn()
      draggable = new DraggableList(container, '.item', { onReorder })

      const handle = container.querySelectorAll('.drag-handle')[2] as HTMLElement
      // Start at midpoint of item 2 (y=145)
      mousedown(handle, 145)
      mousemove(20)
      mousemove(20)
      mouseup()

      expect(onReorder).toHaveBeenCalledWith(2, 0)
    })
  })

  describe('CSS classes', () => {
    it('adds is-draggable class during drag and removes it after', () => {
      container = buildList(2)
      draggable = new DraggableList(container, '.item')

      const item = container.querySelectorAll('.item')[0] as HTMLElement
      const handle = item.querySelector('.drag-handle') as HTMLElement

      mousedown(handle, 25)
      expect(item.classList.contains('is-draggable')).toBe(true)

      mouseup()
      expect(item.classList.contains('is-draggable')).toBe(false)
    })
  })

  describe('dispose', () => {
    it('removes event listeners and prevents further drags', () => {
      container = buildList(2)
      const onReorder = vi.fn()
      draggable = new DraggableList(container, '.item', { onReorder })

      draggable.dispose()

      const handle = container.querySelectorAll('.drag-handle')[0] as HTMLElement
      mousedown(handle, 25)
      mousemove(90)
      mousemove(90)
      mouseup()

      expect(onReorder).not.toHaveBeenCalled()
    })
  })
})
