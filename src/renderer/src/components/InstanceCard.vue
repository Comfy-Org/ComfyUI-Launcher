<script setup lang="ts">
import { Star, Pin } from 'lucide-vue-next'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'

const props = defineProps<{
  installationId?: string
  name: string
  draggable?: boolean
  sourceCategory?: string
}>()

const prefs = useLauncherPrefs()
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
      <div class="instance-name">
        {{ name }}
        <Star v-if="installationId && sourceCategory === 'local' && prefs.isPrimary(installationId)" :size="14" class="card-indicator card-indicator-primary" :title="$t('dashboard.primary')" />
        <Pin v-if="installationId && prefs.isPinned(installationId)" :size="14" class="card-indicator card-indicator-pinned" :title="$t('dashboard.pinned')" />
      </div>
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
