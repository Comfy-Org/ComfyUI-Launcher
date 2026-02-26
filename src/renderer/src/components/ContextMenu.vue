<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: string
  disabled?: boolean
  separator?: boolean
}

const props = defineProps<{
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{
  close: []
  select: [id: string]
}>()

const menuRef = ref<HTMLDivElement | null>(null)
const adjustedX = ref(0)
const adjustedY = ref(0)

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    adjustedX.value = props.x
    adjustedY.value = props.y
    await nextTick()
    clampToViewport()
    document.addEventListener('mousedown', onOutsideClick, true)
    document.addEventListener('keydown', onEscape, true)
  } else {
    document.removeEventListener('mousedown', onOutsideClick, true)
    document.removeEventListener('keydown', onEscape, true)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onOutsideClick, true)
  document.removeEventListener('keydown', onEscape, true)
})

function clampToViewport(): void {
  if (!menuRef.value) return
  const rect = menuRef.value.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (adjustedX.value + rect.width > vw) adjustedX.value = vw - rect.width - 4
  if (adjustedY.value + rect.height > vh) adjustedY.value = vh - rect.height - 4
  if (adjustedX.value < 0) adjustedX.value = 4
  if (adjustedY.value < 0) adjustedY.value = 4
}

function onOutsideClick(e: MouseEvent): void {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    emit('close')
  }
}

function onEscape(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

function handleClick(item: ContextMenuItem): void {
  if (item.disabled) return
  emit('select', item.id)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && items.length > 0"
      ref="menuRef"
      class="context-menu"
      :style="{ left: adjustedX + 'px', top: adjustedY + 'px' }"
    >
      <template v-for="(item, i) in items" :key="item.id">
        <div v-if="item.separator && i > 0" class="context-menu-separator" />
        <button
          class="context-menu-item"
          :class="{ disabled: item.disabled }"
          :disabled="item.disabled"
          @click="handleClick(item)"
        >
          {{ item.label }}
        </button>
      </template>
    </div>
  </Teleport>
</template>
