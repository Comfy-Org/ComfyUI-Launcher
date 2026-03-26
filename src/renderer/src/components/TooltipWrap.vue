<script setup lang="ts">
import { ref } from 'vue'
import { useTooltip } from '../composables/useTooltip'

const props = withDefaults(
  defineProps<{
    text?: string
    side?: 'top' | 'bottom'
  }>(),
  { text: undefined, side: 'top' }
)

const wrapRef = ref<HTMLElement | null>(null)
const { bubbleStyle, visible, show, hide } = useTooltip(
  wrapRef,
  () => props.side,
  () => !!props.text,
)
</script>

<template>
  <span
    ref="wrapRef"
    class="tooltip-wrap"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
  >
    <slot />
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
.tooltip-wrap {
  display: inline-flex;
}
</style>
