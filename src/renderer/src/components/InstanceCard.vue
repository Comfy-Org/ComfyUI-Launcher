<script setup lang="ts">
defineProps<{
  installationId?: string
  name: string
  draggable?: boolean
}>()
</script>

<template>
  <div
    class="instance-card"
    :data-id="installationId"
  >
    <div
      v-if="draggable"
      class="drag-handle"
      :title="$t('list.dragToReorder')"
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
