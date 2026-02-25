/*
  Pointer-based drag-to-reorder for a vertical item list.
  Adapted from TahaSh/drag-to-reorder (MIT License).

  Items animate into position via CSS transitions on the `is-idle` class;
  the actively-dragged item is lifted with the `is-draggable` class.
*/

export interface DraggableListOptions {
  onReorder?: (oldIndex: number, newIndex: number) => void
}

export class DraggableList {
  private container: HTMLElement
  private itemSelector: string
  private handleClass = 'drag-handle'
  private onReorder: ((oldIndex: number, newIndex: number) => void) | null

  private draggableItem: HTMLElement | null = null
  private items: HTMLElement[] = []
  private pointerStartX = 0
  private pointerStartY = 0
  private containerStartTop = 0
  private lastClientX = 0
  private lastClientY = 0
  private itemsGap = 0
  private scrollParent: HTMLElement | null = null

  private boundDragStart = this.dragStart.bind(this)
  private boundDragEnd = this.dragEnd.bind(this)
  private boundDrag: ((e: MouseEvent) => void) | null = null
  private boundScroll: (() => void) | null = null

  constructor(
    container: HTMLElement,
    itemSelector: string,
    options: DraggableListOptions = {}
  ) {
    this.container = container
    this.itemSelector = itemSelector
    this.onReorder = options.onReorder ?? null

    this.container.addEventListener('mousedown', this.boundDragStart)
    document.addEventListener('mouseup', this.boundDragEnd)
  }

  // --- Item queries ---

  private getAllItems(): HTMLElement[] {
    if (!this.items.length) {
      this.items = Array.from(this.container.querySelectorAll(this.itemSelector))
      for (const el of this.items) el.classList.add('is-idle')
    }
    return this.items
  }

  private getIdleItems(): HTMLElement[] {
    return this.getAllItems().filter((item) => item.classList.contains('is-idle'))
  }

  private isItemAbove(item: HTMLElement): boolean {
    return item.hasAttribute('data-is-above')
  }

  private isItemToggled(item: HTMLElement): boolean {
    return item.hasAttribute('data-is-toggled')
  }

  // --- Scroll parent ---

  private findScrollParent(): HTMLElement {
    let el = this.container.parentElement
    while (el) {
      const style = getComputedStyle(el)
      if (/(auto|scroll)/.test(style.overflow + style.overflowY)) return el
      el = el.parentElement
    }
    return document.documentElement
  }

  // --- Drag lifecycle ---

  private dragStart(e: MouseEvent): void {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (!target.closest('.' + this.handleClass)) return
    const item = target.closest(this.itemSelector) as HTMLElement | null
    if (!item) return

    this.draggableItem = item
    this.pointerStartX = e.clientX
    this.pointerStartY = e.clientY
    this.lastClientX = e.clientX
    this.lastClientY = e.clientY
    this.containerStartTop = this.container.getBoundingClientRect().top

    this.setItemsGap()
    this.initDraggableItem()
    this.initItemsState()

    this.boundDrag = this.drag.bind(this)
    document.addEventListener('mousemove', this.boundDrag)

    this.scrollParent = this.findScrollParent()
    this.boundScroll = this.onScroll.bind(this)
    this.scrollParent.addEventListener('scroll', this.boundScroll, { passive: true })
  }

  private drag(e: MouseEvent): void {
    if (!this.draggableItem) return
    e.preventDefault()

    this.lastClientX = e.clientX
    this.lastClientY = e.clientY

    // Auto-scroll when pointer is outside the scroll parent
    if (this.scrollParent) {
      const scrollRect = this.scrollParent.getBoundingClientRect()
      if (e.clientY > scrollRect.bottom && this.scrollParent.scrollTop < this.scrollParent.scrollHeight - this.scrollParent.clientHeight) {
        this.scrollParent.scrollBy(0, 10)
      } else if (e.clientY < scrollRect.top && this.scrollParent.scrollTop > 0) {
        this.scrollParent.scrollBy(0, -10)
      }
    }

    this.updateDragPosition()
  }

  private onScroll(): void {
    if (!this.draggableItem) return
    this.updateDragPosition()
  }

  private updateDragPosition(): void {
    if (!this.draggableItem) return
    const scrollOffset = this.container.getBoundingClientRect().top - this.containerStartTop
    const offsetX = this.lastClientX - this.pointerStartX
    const offsetY = this.lastClientY - this.pointerStartY - scrollOffset

    this.updateIdleItemsStateAndPosition()
    this.draggableItem.style.transform = `translate(${offsetX}px, ${offsetY}px)`
  }

  private dragEnd(): void {
    if (!this.draggableItem) return
    this.applyNewItemsOrder()
    this.cleanup()
  }

  // --- Setup helpers ---

  private setItemsGap(): void {
    const idle = this.getIdleItems()
    if (idle.length <= 1) {
      this.itemsGap = 0
      return
    }
    const r1 = idle[0]!.getBoundingClientRect()
    const r2 = idle[1]!.getBoundingClientRect()
    this.itemsGap = Math.abs(r1.bottom - r2.top)
  }

  private initDraggableItem(): void {
    this.draggableItem!.classList.remove('is-idle')
    this.draggableItem!.classList.add('is-draggable')
  }

  private initItemsState(): void {
    const allItems = this.getAllItems()
    const dragIndex = allItems.indexOf(this.draggableItem!)
    for (const item of this.getIdleItems()) {
      if (allItems.indexOf(item) < dragIndex) {
        item.dataset.isAbove = ''
      }
    }
  }

  // --- Position updates ---

  private updateIdleItemsStateAndPosition(): void {
    const dragRect = this.draggableItem!.getBoundingClientRect()
    const dragY = dragRect.top + dragRect.height / 2

    // Update toggled state based on midpoint crossing
    for (const item of this.getIdleItems()) {
      const itemRect = item.getBoundingClientRect()
      const itemY = itemRect.top + itemRect.height / 2

      if (this.isItemAbove(item)) {
        if (dragY <= itemY) {
          item.dataset.isToggled = ''
        } else {
          delete item.dataset.isToggled
        }
      } else {
        if (dragY >= itemY) {
          item.dataset.isToggled = ''
        } else {
          delete item.dataset.isToggled
        }
      }
    }

    // Translate toggled items to make room
    for (const item of this.getIdleItems()) {
      if (this.isItemToggled(item)) {
        const direction = this.isItemAbove(item) ? 1 : -1
        item.style.transform = `translateY(${direction * (dragRect.height + this.itemsGap)}px)`
      } else {
        item.style.transform = ''
      }
    }
  }

  // --- Reorder computation ---

  private applyNewItemsOrder(): void {
    const allItems = this.getAllItems()
    const reordered: (HTMLElement | undefined)[] = new Array(allItems.length)

    let oldPosition = -1
    allItems.forEach((item, index) => {
      if (item === this.draggableItem) {
        oldPosition = index
        return
      }
      if (!this.isItemToggled(item)) {
        reordered[index] = item
        return
      }
      const newIndex = this.isItemAbove(item) ? index + 1 : index - 1
      reordered[newIndex] = item
    })

    let newPosition = oldPosition
    for (let i = 0; i < allItems.length; i++) {
      if (reordered[i] === undefined) {
        newPosition = i
        break
      }
    }

    if (oldPosition !== newPosition && this.onReorder) {
      this.onReorder(oldPosition, newPosition)
    }
  }

  // --- Cleanup ---

  private cleanup(): void {
    if (this.draggableItem) {
      this.draggableItem.style.transform = ''
      this.draggableItem.classList.remove('is-draggable')
      this.draggableItem = null
    }

    for (const item of this.getIdleItems()) {
      delete item.dataset.isAbove
      delete item.dataset.isToggled
      item.classList.remove('is-idle')
      item.style.transform = ''
    }

    this.items = []
    this.itemsGap = 0

    if (this.boundDrag) {
      document.removeEventListener('mousemove', this.boundDrag)
      this.boundDrag = null
    }
    if (this.boundScroll && this.scrollParent) {
      this.scrollParent.removeEventListener('scroll', this.boundScroll)
      this.boundScroll = null
      this.scrollParent = null
    }
  }

  dispose(): void {
    this.cleanup()
    this.container.removeEventListener('mousedown', this.boundDragStart)
    document.removeEventListener('mouseup', this.boundDragEnd)
  }
}
