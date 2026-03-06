<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SnapshotDiffView from './SnapshotDiffView.vue'
import type { SnapshotDiffData } from '../types/ipc'

interface Props {
  diffData: SnapshotDiffData | null
  loading: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  cancel: []
  confirm: []
}>()

const { t } = useI18n()

const mouseDownOnOverlay = ref(false)

function handleOverlayMouseDown(event: MouseEvent): void {
  mouseDownOnOverlay.value = event.target === (event.currentTarget as HTMLElement)
}

function handleOverlayClick(event: MouseEvent): void {
  if (mouseDownOnOverlay.value && event.target === (event.currentTarget as HTMLElement)) {
    emit('cancel')
  }
  mouseDownOnOverlay.value = false
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    emit('cancel')
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      class="modal-overlay restore-modal-overlay"
      @mousedown="handleOverlayMouseDown"
      @click="handleOverlayClick"
    >
      <div class="modal-box restore-modal-box">
        <div class="modal-title">{{ t('snapshots.restorePreviewTitle') }}</div>

        <div v-if="loading" class="restore-modal-loading">{{ t('common.loading') }}</div>

        <template v-else-if="diffData">
          <div v-if="diffData.empty" class="restore-modal-empty">
            {{ t('snapshots.restoreNoChanges') }}
          </div>
          <template v-else>
            <div class="restore-modal-summary">
              <span v-if="diffData.diff.comfyuiChanged" class="restore-badge restore-badge-changed">{{ t('snapshots.comfyuiUpdated') }}</span>
              <span v-if="diffData.diff.updateChannelChanged && diffData.diff.updateChannel" class="restore-badge restore-badge-changed">{{ diffData.diff.updateChannel.from }} → {{ diffData.diff.updateChannel.to }}</span>
              <span v-if="diffData.diff.nodesAdded.length > 0" class="restore-badge restore-badge-added">+{{ diffData.diff.nodesAdded.length }} {{ t('snapshots.nodesLabel') }}</span>
              <span v-if="diffData.diff.nodesRemoved.length > 0" class="restore-badge restore-badge-removed">−{{ diffData.diff.nodesRemoved.length }} {{ t('snapshots.nodesLabel') }}</span>
              <span v-if="diffData.diff.nodesChanged.length > 0" class="restore-badge restore-badge-changed">~{{ diffData.diff.nodesChanged.length }} {{ t('snapshots.nodesLabel') }}</span>
              <span v-if="diffData.diff.pipsAdded.length > 0" class="restore-badge restore-badge-added">+{{ diffData.diff.pipsAdded.length }} {{ t('snapshots.pkgsLabel') }}</span>
              <span v-if="diffData.diff.pipsRemoved.length > 0" class="restore-badge restore-badge-removed">−{{ diffData.diff.pipsRemoved.length }} {{ t('snapshots.pkgsLabel') }}</span>
              <span v-if="diffData.diff.pipsChanged.length > 0" class="restore-badge restore-badge-changed">~{{ diffData.diff.pipsChanged.length }} {{ t('snapshots.pkgsLabel') }}</span>
            </div>

            <div class="restore-modal-diff">
              <SnapshotDiffView :diff="diffData.diff" />
            </div>
          </template>
        </template>

        <div class="modal-actions">
          <button @click="emit('cancel')">{{ t('snapshots.restoreCancel') }}</button>
          <button
            v-if="diffData && !diffData.empty"
            class="primary"
            @click="emit('confirm')"
          >
            {{ t('snapshots.restoreConfirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.restore-modal-overlay {
  z-index: 75;
}

.restore-modal-box {
  min-width: 400px;
  max-width: 560px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
}

.restore-modal-loading {
  color: var(--text-muted);
  font-size: 13px;
  padding: 16px 0;
}

.restore-modal-empty {
  font-size: 14px;
  color: var(--text-muted);
  padding: 8px 0;
  margin-bottom: 16px;
}

.restore-modal-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 12px;
}

.restore-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
}

.restore-badge-added {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, transparent);
}

.restore-badge-removed {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.restore-badge-changed {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 12%, transparent);
}

.restore-modal-diff {
  background: var(--bg);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 16px;
  overflow-y: auto;
  min-height: 0;
}
</style>
