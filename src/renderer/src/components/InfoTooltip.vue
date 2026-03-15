<script setup lang="ts">
import { CircleHelp } from 'lucide-vue-next'

withDefaults(
  defineProps<{
    text: string
    side?: 'top' | 'bottom'
  }>(),
  { side: 'top' }
)
</script>

<template>
  <span class="info-tooltip-wrapper">
    <CircleHelp :size="14" class="info-tooltip-icon" />
    <span class="info-tooltip-bubble" :class="`info-tooltip-${side}`">{{ text }}</span>
  </span>
</template>

<style scoped>
.info-tooltip-wrapper {
  position: relative;
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

.info-tooltip-wrapper:hover .info-tooltip-icon {
  opacity: 1;
  color: var(--accent);
}

.info-tooltip-bubble {
  display: none;
  position: absolute;
  left: 50%;
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
  white-space: normal;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  z-index: 9999;
  pointer-events: none;
}

.info-tooltip-top {
  bottom: calc(100% + 6px);
}

.info-tooltip-bottom {
  top: calc(100% + 6px);
}

.info-tooltip-wrapper:hover .info-tooltip-bubble {
  display: block;
}
</style>
