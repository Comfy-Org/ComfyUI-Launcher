<script setup lang="ts">
import { ref } from 'vue'
import { CircleHelp } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    text: string
    side?: 'top' | 'bottom'
  }>(),
  { side: 'top' }
)

const iconRef = ref<HTMLElement | null>(null)
const bubbleStyle = ref<Record<string, string>>({})
const visible = ref(false)

function show(): void {
  if (!iconRef.value) return
  const rect = iconRef.value.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  if (props.side === 'bottom') {
    bubbleStyle.value = {
      top: `${rect.bottom + 6}px`,
      left: `${x}px`,
    }
  } else {
    bubbleStyle.value = {
      bottom: `${window.innerHeight - rect.top + 6}px`,
      left: `${x}px`,
    }
  }
  visible.value = true
}

function hide(): void {
  visible.value = false
}
</script>

<template>
  <span
    ref="iconRef"
    class="info-tooltip-trigger"
    @mouseenter="show"
    @mouseleave="hide"
  >
    <CircleHelp :size="14" class="info-tooltip-icon" />
    <Teleport to="body">
      <span
        v-if="visible"
        class="info-tooltip-bubble"
        :style="bubbleStyle"
      >{{ text }}</span>
    </Teleport>
  </span>
</template>

<style scoped>
.info-tooltip-trigger {
  display: inline-flex;
  align-items: center;
  margin-left: 4px;
  vertical-align: middle;
  cursor: help;
}

.info-tooltip-icon {
  color: var(--text-muted);
  opacity: 0.6;
  transition: opacity 0.15s, color 0.15s;
  flex-shrink: 0;
}

.info-tooltip-trigger:hover .info-tooltip-icon {
  opacity: 1;
  color: var(--accent);
}
</style>

<style>
.info-tooltip-bubble {
  position: fixed;
  transform: translateX(-50%);
  width: max-content;
  max-width: 260px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  text-transform: none;
  letter-spacing: 0;
  white-space: normal;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  z-index: 10001;
  pointer-events: none;
}
</style>
