<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  installationId?: string
  name: string
  draggable?: boolean
}>()

const emit = defineEmits<{
  dragstart: [event: DragEvent]
  drop: [event: DragEvent]
}>()

const cardRef = ref<HTMLDivElement | null>(null)
const isDragging = ref(false)
const isDragOver = ref(false)

function handleHandleMouseDown() {
  if (cardRef.value) cardRef.value.draggable = true
}

function handleHandleMouseUp() {
  if (cardRef.value) cardRef.value.draggable = false
}

function handleDragStart(e: DragEvent) {
  isDragging.value = true
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  emit('dragstart', e)
}

function handleDragEnd() {
  isDragging.value = false
  isDragOver.value = false
  if (cardRef.value) cardRef.value.draggable = false
}

function handleDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  isDragOver.value = true
}

function handleDragLeave() {
  isDragOver.value = false
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
  emit('drop', e)
}
</script>

<template>
  <div
    ref="cardRef"
    class="instance-card"
    :class="{ dragging: isDragging, 'drag-over': isDragOver }"
    :data-id="installationId"
    @dragstart="handleDragStart"
    @dragend="handleDragEnd"
    @dragover.prevent="handleDragOver"
    @dragleave="handleDragLeave"
    @drop.prevent="handleDrop"
  >
    <div
      v-if="draggable"
      class="drag-handle"
      :title="$t('list.dragToReorder')"
      @mousedown="handleHandleMouseDown"
      @mouseup="handleHandleMouseUp"
    >
      <span></span><span></span><span></span>
    </div>
    <div class="instance-info">
      <div class="instance-name">{{ name }}</div>
      <div v-if="$slots.meta" class="instance-meta">
        <slot name="meta" />
      </div>
      <slot name="extra-info" />
    </div>
    <div class="instance-actions">
      <slot name="actions" />
    </div>
  </div>
</template>
