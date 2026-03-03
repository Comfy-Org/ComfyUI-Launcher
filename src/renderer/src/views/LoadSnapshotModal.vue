<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import type { SnapshotFilePreview } from '../types/ipc'

const emit = defineEmits<{
  close: []
  'show-progress': [
    opts: {
      installationId: string
      title: string
      apiCall: () => Promise<unknown>
      cancellable?: boolean
    }
  ]
}>()

const { t } = useI18n()
const modal = useModal()

const preview = ref<SnapshotFilePreview | null>(null)
const installName = ref('')
const nodesExpanded = ref(true)
const pipExpanded = ref(false)
const loading = ref(false)
const creating = ref(false)
const dragging = ref(false)

const INVALID_NAME_CHARS = /[<>:"/\\|?*]/
const nameHasInvalidChars = computed(() => INVALID_NAME_CHARS.test(installName.value))
const mouseDownOnOverlay = ref(false)

function open(): void {
  preview.value = null
  installName.value = ''
  nodesExpanded.value = true
  pipExpanded.value = false
  loading.value = false
  creating.value = false
  dragging.value = false
}

async function loadFromPath(filePath: string): Promise<void> {
  loading.value = true
  try {
    const result = await window.api.previewSnapshotPath(filePath)
    if (!result.ok) {
      if (result.message) {
        await modal.alert({ title: t('list.loadSnapshot'), message: result.message })
      }
      return
    }
    if (result.preview) {
      preview.value = result.preview
      installName.value = result.preview.installationName || ''
      nodesExpanded.value = true
    }
  } finally {
    loading.value = false
  }
}

async function handleBrowse(): Promise<void> {
  const result = await window.api.previewSnapshotFile()
  if (!result.ok) {
    if (result.message) {
      await modal.alert({ title: t('list.loadSnapshot'), message: result.message })
    }
    return
  }
  if (result.preview) {
    preview.value = result.preview
    installName.value = result.preview.installationName || ''
    nodesExpanded.value = true
  }
}

function handleDragOver(event: DragEvent): void {
  event.preventDefault()
  dragging.value = true
}

function handleDragLeave(): void {
  dragging.value = false
}

async function handleDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  dragging.value = false
  const file = event.dataTransfer?.files[0]
  if (!file) return
  if (!file.name.endsWith('.json')) {
    await modal.alert({ title: t('list.loadSnapshot'), message: t('snapshots.importInvalidFile') })
    return
  }
  const filePath = window.api.getPathForFile(file)
  if (!filePath) return
  await loadFromPath(filePath)
}

function handleClearPreview(): void {
  preview.value = null
}

async function handleCreate(): Promise<void> {
  if (!preview.value || creating.value) return
  creating.value = true
  const filePath = preview.value.filePath

  try {
    const result = await window.api.createFromSnapshot(filePath, installName.value || undefined)
    if (!result.ok) {
      if (result.message) {
        await modal.alert({ title: t('list.loadSnapshot'), message: result.message })
      }
      return
    }
    if (result.entry) {
      creating.value = false
      emit('close')
      emit('show-progress', {
        installationId: result.entry.id,
        title: `${t('newInstall.installing')} — ${result.entry.name}`,
        apiCall: () => window.api.installInstance(result.entry!.id),
        cancellable: true,
      })
      return
    }
  } finally {
    creating.value = false
  }
}

function triggerLabel(trigger: string): string {
  switch (trigger) {
    case 'boot': return t('snapshots.triggerBoot')
    case 'restart': return t('snapshots.triggerRestart')
    case 'manual': return t('snapshots.triggerManual')
    case 'pre-update': return t('snapshots.triggerPreUpdate')
    case 'post-update': return t('snapshots.triggerPostUpdate')
    case 'post-restore': return t('snapshots.triggerPostRestore')
    default: return trigger
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

function formatNodeVersion(node: { version?: string; commit?: string }): string {
  if (node.version) return node.version
  if (node.commit) return node.commit.slice(0, 7)
  return '—'
}

function handleOverlayMouseDown(event: MouseEvent): void {
  mouseDownOnOverlay.value = event.target === (event.currentTarget as HTMLElement)
}

function handleOverlayClick(event: MouseEvent): void {
  if (mouseDownOnOverlay.value && event.target === (event.currentTarget as HTMLElement)) {
    emit('close')
  }
  mouseDownOnOverlay.value = false
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

// Prevent Electron from navigating to dropped files
function preventNav(event: Event): void {
  event.preventDefault()
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  document.addEventListener('dragover', preventNav)
  document.addEventListener('drop', preventNav)
})
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('dragover', preventNav)
  document.removeEventListener('drop', preventNav)
})

defineExpose({ open })
</script>

<template>
  <div
    class="view-modal active"
    @mousedown="handleOverlayMouseDown"
    @click="handleOverlayClick"
  >
    <div class="view-modal-content">
      <div class="view-modal-header">
        <div class="view-modal-title">{{ $t('list.loadSnapshot') }}</div>
        <button class="view-modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="view-modal-body">
        <div class="view-scroll">
          <!-- Drop zone / file picker (shown when no preview loaded) -->
          <div v-if="!preview" class="ls-drop-zone-wrap">
            <div
              class="ls-drop-zone"
              :class="{ 'ls-drop-zone-active': dragging, 'ls-drop-zone-loading': loading }"
              @dragover="handleDragOver"
              @dragleave="handleDragLeave"
              @drop="handleDrop"
            >
              <div v-if="loading" class="ls-drop-text">{{ $t('newInstall.loading') }}</div>
              <template v-else>
                <div class="ls-drop-text">{{ $t('list.snapshotDropHint') }}</div>
                <div class="ls-drop-or">{{ $t('common.or') }}</div>
                <button class="ls-browse-btn" @click="handleBrowse">{{ $t('common.browse') }}</button>
              </template>
            </div>
          </div>

          <!-- Preview content -->
          <template v-if="preview">
            <!-- Install name -->
            <div class="ls-section">
              <div class="ls-field">
                <span class="ls-label">{{ $t('common.name') }}</span>
                <input
                  v-model="installName"
                  class="ls-name-input"
                  type="text"
                  :placeholder="$t('common.namePlaceholder')"
                >
                <span v-if="nameHasInvalidChars" class="ls-name-hint">{{ $t('list.snapshotNameHint') }}</span>
              </div>
            </div>

            <!-- Source info -->
            <div class="ls-section">
              <div class="ls-field">
                <span class="ls-label">{{ $t('list.snapshotSourceName') }}</span>
                <span class="ls-value">{{ preview.installationName }}</span>
              </div>
              <div class="ls-field">
                <span class="ls-label">{{ $t('list.snapshotCount') }}</span>
                <span class="ls-value">{{ preview.snapshotCount }}</span>
              </div>
            </div>

            <!-- Snapshot timeline -->
            <div class="ls-section">
              <div class="ls-section-title">{{ $t('list.snapshotTimeline') }}</div>
              <div class="ls-timeline">
                <div
                  v-for="(snap, i) in preview.snapshots"
                  :key="snap.filename"
                  class="ls-timeline-item"
                >
                  <span class="ls-trigger" :class="'ls-trigger-' + snap.trigger">{{ triggerLabel(snap.trigger) }}</span>
                  <span v-if="i === 0" class="ls-current-tag">{{ $t('snapshots.current') }}</span>
                  <span class="ls-meta">{{ snap.comfyuiVersion }} · {{ $t('snapshots.nodesCount', { count: snap.nodeCount }) }} · {{ $t('snapshots.packagesCount', { count: snap.pipPackageCount }) }}</span>
                  <span class="ls-time">{{ formatDate(snap.createdAt) }}</span>
                </div>
              </div>
            </div>

            <!-- Newest snapshot detail -->
            <div class="ls-section">
              <div class="ls-section-title">{{ $t('list.snapshotNewestDetail') }}</div>

              <div class="ls-grid">
                <div class="ls-field">
                  <span class="ls-label">{{ $t('snapshots.comfyuiVersion') }}</span>
                  <span class="ls-value">{{ preview.newestSnapshot.comfyui.displayVersion || preview.newestSnapshot.comfyui.ref }}</span>
                </div>
                <div class="ls-field">
                  <span class="ls-label">{{ $t('snapshots.variant') }}</span>
                  <span class="ls-value">{{ preview.newestSnapshot.comfyui.variant || '—' }}</span>
                </div>
                <div class="ls-field">
                  <span class="ls-label">{{ $t('snapshots.pythonVersion') }}</span>
                  <span class="ls-value">{{ preview.newestSnapshot.pythonVersion || '—' }}</span>
                </div>
                <div class="ls-field">
                  <span class="ls-label">{{ $t('snapshots.capturedAt') }}</span>
                  <span class="ls-value">{{ formatDate(preview.newestSnapshot.createdAt) }}</span>
                </div>
              </div>

              <!-- Custom nodes -->
              <div class="ls-subsection">
                <div class="ls-subsection-title" @click="nodesExpanded = !nodesExpanded">
                  <span>{{ $t('snapshots.customNodes') }} ({{ preview.newestSnapshot.customNodes.length }})</span>
                  <span class="ls-collapse">{{ nodesExpanded ? '▾' : '▸' }}</span>
                </div>
                <template v-if="nodesExpanded">
                  <div v-if="preview.newestSnapshot.customNodes.length > 0" class="ls-recessed-list">
                    <div v-for="node in preview.newestSnapshot.customNodes" :key="node.id" class="ls-node-row">
                      <span class="ls-node-status" :class="node.enabled ? 'ls-node-enabled' : 'ls-node-disabled'" />
                      <span class="ls-node-name">{{ node.id }}</span>
                      <span class="ls-node-type">{{ node.type }}</span>
                      <span class="ls-node-version" :title="formatNodeVersion(node)">{{ formatNodeVersion(node) }}</span>
                    </div>
                  </div>
                  <div v-else class="ls-empty">—</div>
                </template>
              </div>

              <!-- Pip packages -->
              <div class="ls-subsection">
                <div class="ls-subsection-title" @click="pipExpanded = !pipExpanded">
                  <span>{{ $t('snapshots.pipPackages') }} ({{ preview.newestSnapshot.pipPackageCount }})</span>
                  <span class="ls-collapse">{{ pipExpanded ? '▾' : '▸' }}</span>
                </div>
                <template v-if="pipExpanded">
                  <div v-if="preview.newestSnapshot.pipPackageCount > 0" class="ls-recessed-list">
                    <div v-for="(version, name) in preview.newestSnapshot.pipPackages" :key="name" class="ls-pip-row">
                      <span class="ls-pip-name">{{ name }}</span>
                      <span class="ls-pip-version" :title="version">{{ version }}</span>
                    </div>
                  </div>
                  <div v-else class="ls-empty">—</div>
                </template>
              </div>
            </div>
          </template>
        </div>

        <!-- Bottom actions -->
        <div class="view-bottom">
          <button v-if="preview" @click="handleClearPreview">{{ $t('common.back') }}</button>
          <button
            class="primary"
            :disabled="!preview || creating"
            @click="handleCreate"
          >
            {{ creating ? $t('newInstall.loading') : $t('list.snapshotCreateInstall') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Drop zone */
.ls-drop-zone-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}

.ls-drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  min-height: 180px;
  border: 2px dashed var(--border);
  border-radius: 10px;
  padding: 32px;
  transition: border-color 0.15s, background 0.15s;
}
.ls-drop-zone-active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.ls-drop-zone-loading {
  opacity: 0.6;
  pointer-events: none;
}

.ls-drop-text {
  font-size: 15px;
  color: var(--text-muted);
  text-align: center;
}
.ls-drop-or {
  font-size: 13px;
  color: var(--text-muted);
}
.ls-browse-btn {
  padding: 6px 20px;
  font-size: 14px;
  border-radius: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  cursor: pointer;
}
.ls-browse-btn:hover {
  border-color: var(--border-hover);
}

/* Preview content */
.ls-section {
  margin-bottom: 16px;
}
.ls-section:last-child {
  margin-bottom: 0;
}

.ls-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 8px;
}

.ls-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
  margin-bottom: 10px;
}

.ls-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 4px;
}

.ls-label {
  font-size: 13px;
  color: var(--text-muted);
}

.ls-value {
  font-size: 14px;
  color: var(--text);
  user-select: text;
}

.ls-name-input {
  font-size: 14px;
  padding: 6px 10px;
  border-radius: 5px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  box-sizing: border-box;
  width: 100%;
}
.ls-name-input:focus {
  outline: none;
  border-color: var(--accent);
}

.ls-name-hint {
  font-size: 11px;
  color: var(--warning, #fd9903);
  margin-top: 2px;
}

/* Timeline */
.ls-timeline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px;
}

.ls-timeline-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  padding: 6px 10px;
  background: var(--bg);
  border-radius: 5px;
}

.ls-trigger {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  color: var(--text-muted);
  background: var(--surface);
}

.ls-trigger-boot { color: var(--text-muted); }
.ls-trigger-restart { color: var(--info, #58a6ff); }
.ls-trigger-manual { color: var(--success, #00cd72); }
.ls-trigger-pre-update { color: var(--success, #00cd72); }
.ls-trigger-post-update { color: var(--warning, #fd9903); }
.ls-trigger-post-restore { color: var(--warning, #fd9903); }

.ls-current-tag {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}

.ls-meta {
  color: var(--text-muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ls-time {
  color: var(--text-muted);
  font-size: 13px;
  flex-shrink: 0;
}

/* Subsections (nodes, packages) */
.ls-subsection {
  margin-top: 10px;
}

.ls-subsection-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  user-select: none;
  margin-bottom: 6px;
}

.ls-collapse {
  font-size: 14px;
}

.ls-recessed-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 200px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px;
}

.ls-node-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  padding: 2px 0;
}

.ls-node-status {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.ls-node-enabled { background: var(--info, #58a6ff); }
.ls-node-disabled { background: var(--text-muted); }

.ls-node-name {
  color: var(--text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}

.ls-node-type {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 3px;
  flex-shrink: 0;
}

.ls-node-version {
  font-size: 13px;
  color: var(--text-muted);
  font-family: monospace;
  flex-shrink: 0;
  user-select: text;
}

.ls-empty {
  font-size: 14px;
  color: var(--text-muted);
}

/* Pip packages */
.ls-pip-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
  font-size: 13px;
}

.ls-pip-name {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  user-select: text;
}

.ls-pip-version {
  color: var(--text-muted);
  font-family: monospace;
  margin-left: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 50%;
  user-select: text;
}
</style>
