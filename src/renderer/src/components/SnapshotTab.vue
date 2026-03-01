<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import { ChevronDown } from 'lucide-vue-next'
import type {
  ActionDef,
  CopyEvent,
  SnapshotSummary,
  SnapshotListData,
  SnapshotDetailData,
  SnapshotDiffData,
  SnapshotDiffResult,
} from '../types/ipc'

interface Props {
  installationId: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'run-action': [action: ActionDef, button: HTMLButtonElement | null]
  'refresh-all': []
  'navigate-installation': [installationId: string]
}>()

const { t } = useI18n()
const modal = useModal()

const listData = ref<SnapshotListData | null>(null)
const loading = ref(true)
const selectedFilename = ref<string | null>(null)
const detail = ref<SnapshotDetailData | null>(null)
const detailLoading = ref(false)
const diffData = ref<SnapshotDiffData | null>(null)
const diffLoading = ref(false)
const diffMode = ref<'previous' | 'current' | null>(null)
const pipSearch = ref('')
const pipExpanded = ref(false)
const nodeSearch = ref('')
const nodesExpanded = ref(true)

const snapshots = computed(() => listData.value?.snapshots ?? [])
const copyEvents = computed(() => listData.value?.copyEvents ?? [])
const context = computed(() => listData.value?.context ?? null)

type TimelineItem =
  | { kind: 'snapshot'; snapshot: SnapshotSummary; snapshotIndex: number }
  | { kind: 'copy'; event: CopyEvent }

const timelineItems = computed<TimelineItem[]>(() => {
  // Merge snapshots and copy events by timestamp, newest first
  const items: TimelineItem[] = []
  let si = 0
  let ci = 0
  const snaps = snapshots.value
  const copies = [...copyEvents.value].sort((a, b) => new Date(b.copiedAt).getTime() - new Date(a.copiedAt).getTime())
  while (si < snaps.length || ci < copies.length) {
    const snapTime = si < snaps.length ? new Date(snaps[si]!.createdAt).getTime() : -Infinity
    const copyTime = ci < copies.length ? new Date(copies[ci]!.copiedAt).getTime() : -Infinity
    if (snapTime >= copyTime) {
      items.push({ kind: 'snapshot', snapshot: snaps[si]!, snapshotIndex: si })
      si++
    } else {
      items.push({ kind: 'copy', event: copies[ci]! })
      ci++
    }
  }
  return items
})

async function load(): Promise<void> {
  loading.value = true
  try {
    listData.value = await window.api.getSnapshots(props.installationId)
  } finally {
    loading.value = false
  }
}

watch(() => props.installationId, () => {
  selectedFilename.value = null
  detail.value = null
  diffData.value = null
  diffMode.value = null
  load()
}, { immediate: true })

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

function triggerClass(trigger: string): string {
  switch (trigger) {
    case 'boot': return 'trigger-boot'
    case 'restart': return 'trigger-restart'
    case 'manual': return 'trigger-manual'
    case 'pre-update': return 'trigger-preupdate'
    case 'post-update': return 'trigger-postupdate'
    case 'post-restore': return 'trigger-postrestore'
    default: return ''
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t('snapshots.timeJustNow')
  if (mins < 60) return t('snapshots.timeMinutesAgo', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('snapshots.timeHoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('snapshots.timeDaysAgo', { count: days })
  return new Date(iso).toLocaleDateString()
}

function copyReasonLabel(reason: string): string {
  switch (reason) {
    case 'copy-update': return t('snapshots.copyUpdatedAs')
    case 'release-update': return t('snapshots.releaseUpdatedAs')
    default: return t('snapshots.copiedAs')
  }
}

function changeSummary(s: SnapshotSummary): string[] {
  if (!s.diffVsPrevious) return []
  const parts: string[] = []
  const d = s.diffVsPrevious
  if (d.comfyuiChanged) parts.push(t('snapshots.comfyuiUpdated'))
  const nodeChanges = d.nodesAdded + d.nodesRemoved + d.nodesChanged
  if (nodeChanges > 0) {
    const nodeParts: string[] = []
    if (d.nodesAdded > 0) nodeParts.push(`+${d.nodesAdded}`)
    if (d.nodesRemoved > 0) nodeParts.push(`−${d.nodesRemoved}`)
    if (d.nodesChanged > 0) nodeParts.push(`~${d.nodesChanged}`)
    parts.push(`${nodeParts.join(' ')} nodes`)
  }
  const pipChanges = d.pipsAdded + d.pipsRemoved + d.pipsChanged
  if (pipChanges > 0) {
    parts.push(`${pipChanges} pkg changes`)
  }
  return parts
}

async function selectSnapshot(filename: string): Promise<void> {
  if (selectedFilename.value === filename) {
    selectedFilename.value = null
    detail.value = null
    diffData.value = null
    diffMode.value = null
    return
  }
  selectedFilename.value = filename
  diffData.value = null
  diffMode.value = null
  pipSearch.value = ''
  pipExpanded.value = false
  nodeSearch.value = ''
  nodesExpanded.value = true
  detailLoading.value = true
  try {
    detail.value = await window.api.getSnapshotDetail(props.installationId, filename)
  } finally {
    detailLoading.value = false
  }
}

async function loadDiff(mode: 'previous' | 'current'): Promise<void> {
  if (!selectedFilename.value) return
  if (diffMode.value === mode) {
    diffMode.value = null
    diffData.value = null
    return
  }
  diffMode.value = mode
  diffLoading.value = true
  try {
    diffData.value = await window.api.getSnapshotDiff(props.installationId, selectedFilename.value, mode)
  } finally {
    diffLoading.value = false
  }
}

async function saveSnapshot(): Promise<void> {
  const label = await modal.prompt({
    title: t('standalone.snapshotSaveTitle'),
    message: t('standalone.snapshotSaveMessage'),
    placeholder: t('standalone.snapshotLabelPlaceholder'),
    confirmLabel: t('snapshots.saveSnapshot'),
    required: false,
  })
  if (label === null) return
  await window.api.runAction(props.installationId, 'snapshot-save', { label: label || undefined })
  selectedFilename.value = null
  detail.value = null
  diffData.value = null
  diffMode.value = null
  await load()
  emit('refresh-all')
}

function handleRestore(filename: string): void {
  const action: ActionDef = {
    id: 'snapshot-restore',
    label: t('standalone.snapshotRestore'),
    data: { file: filename },
    showProgress: true,
    progressTitle: t('standalone.snapshotRestoringTitle'),
    cancellable: true,
    confirm: {
      title: t('standalone.snapshotRestoreTitle'),
      message: t('standalone.snapshotRestoreMessage'),
    },
  }
  emit('run-action', action, null)
}

async function handleDelete(filename: string): Promise<void> {
  const confirmed = await modal.confirm({
    title: t('standalone.snapshotDelete'),
    message: t('snapshots.deleteConfirm'),
  })
  if (!confirmed) return
  await window.api.runAction(props.installationId, 'snapshot-delete', { file: filename })
  if (selectedFilename.value === filename) {
    selectedFilename.value = null
    detail.value = null
    diffData.value = null
    diffMode.value = null
  }
  await load()
  emit('refresh-all')
}

const filteredCustomNodes = computed(() => {
  if (!detail.value) return []
  if (!nodeSearch.value) return detail.value.customNodes
  const q = nodeSearch.value.toLowerCase()
  return detail.value.customNodes.filter((n) => n.id.toLowerCase().includes(q))
})

const filteredPipPackages = computed(() => {
  if (!detail.value) return []
  const entries = Object.entries(detail.value.pipPackages)
  if (!pipSearch.value) return entries
  const q = pipSearch.value.toLowerCase()
  return entries.filter(([name]) => name.toLowerCase().includes(q))
})

function formatVersion(v: { ref: string; commit: string | null; displayVersion?: string }): string {
  if (v.displayVersion) return v.displayVersion
  return v.commit ? `${v.ref} (${v.commit.slice(0, 7)})` : v.ref
}

function formatNodeVersion(node: { version?: string; commit?: string }): string {
  if (node.version) return node.version
  if (node.commit) return node.commit.slice(0, 7)
  return '—'
}

function diffHasChanges(diff: SnapshotDiffResult): boolean {
  return diff.comfyuiChanged || diff.nodesAdded.length > 0 || diff.nodesRemoved.length > 0 ||
         diff.nodesChanged.length > 0 || diff.pipsAdded.length > 0 || diff.pipsRemoved.length > 0 ||
         diff.pipsChanged.length > 0
}
</script>

<template>
  <div class="snapshot-tab">
    <!-- Empty state -->
    <div v-if="!loading && snapshots.length === 0" class="snapshot-empty">
      {{ t('snapshots.empty') }}
    </div>

    <!-- Header with save button -->
    <div v-if="snapshots.length > 0 || !loading" class="snapshot-header">
      <button class="snapshot-save-btn" @click="saveSnapshot">
        {{ t('snapshots.saveSnapshot') }}
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="snapshot-loading">{{ t('common.loading') }}</div>

    <!-- Timeline -->
    <div v-if="!loading && snapshots.length > 0" class="snapshot-timeline">
      <template v-for="(item, index) in timelineItems" :key="item.kind === 'snapshot' ? item.snapshot.filename : `copy-${item.event.installationId}`">
        <!-- Copy event -->
        <div v-if="item.kind === 'copy'" class="timeline-entry">
          <div class="timeline-gutter">
            <div class="timeline-line timeline-line-top" :class="{ invisible: index === 0 }" />
            <div class="timeline-dot trigger-copy" />
            <div class="timeline-line-rest" :class="{ invisible: index === timelineItems.length - 1 }" />
          </div>
          <div class="timeline-content">
            <div class="timeline-copy-card">
              <span class="timeline-trigger trigger-copy">{{ copyReasonLabel(item.event.copyReason) }}</span>
              <button
                v-if="item.event.exists"
                class="timeline-copy-name clickable"
                @click="emit('navigate-installation', item.event.installationId)"
              >{{ item.event.installationName }}</button>
              <span v-else class="timeline-copy-name">{{ item.event.installationName }}</span>
              <span class="timeline-time" :title="formatDate(item.event.copiedAt)">{{ formatRelative(item.event.copiedAt) }}</span>
            </div>
          </div>
        </div>

        <!-- Snapshot entry -->
        <div
          v-else
          class="timeline-entry"
          :class="{ selected: selectedFilename === item.snapshot.filename }"
        >
        <!-- Timeline dot and line -->
        <div class="timeline-gutter">
          <div class="timeline-line timeline-line-top" :class="{ invisible: index === 0 }" />
          <div class="timeline-dot" :class="triggerClass(item.snapshot.trigger)" />
          <div class="timeline-line-rest" :class="{ invisible: index === timelineItems.length - 1 }" />
        </div>

        <!-- Card -->
        <div class="timeline-content">
          <div class="timeline-card" @click="selectSnapshot(item.snapshot.filename)">
            <div class="timeline-card-header">
              <span class="timeline-trigger" :class="triggerClass(item.snapshot.trigger)">{{ triggerLabel(item.snapshot.trigger) }}</span>
              <span v-if="item.snapshotIndex === 0" class="timeline-current-tag">{{ t('snapshots.current') }}</span>
              <span class="timeline-time" :title="formatDate(item.snapshot.createdAt)">{{ formatRelative(item.snapshot.createdAt) }}</span>
            </div>
            <div v-if="item.snapshot.label && !['after-update', 'before-update', 'after-restore'].includes(item.snapshot.label)" class="timeline-label">{{ item.snapshot.label }}</div>
            <div class="timeline-card-body">
              <div class="timeline-meta">
                <span>{{ item.snapshot.comfyuiVersion }}</span>
                <span class="timeline-meta-sep">·</span>
                <span>{{ t('snapshots.nodesCount', { count: item.snapshot.nodeCount }) }}</span>
                <span class="timeline-meta-sep">·</span>
                <span>{{ t('snapshots.packagesCount', { count: item.snapshot.pipPackageCount }) }}</span>
              </div>
              <!-- Restore button (not on current) -->
              <button
                v-if="item.snapshotIndex > 0"
                class="timeline-restore-btn"
                @click.stop="handleRestore(item.snapshot.filename)"
              >
                {{ t('snapshots.restore') }}
              </button>
              <!-- Delete button (manual snapshots only) -->
              <button
                v-if="item.snapshot.trigger === 'manual'"
                class="timeline-delete-btn"
                @click.stop="handleDelete(item.snapshot.filename)"
              >✕</button>
              <ChevronDown :size="14" class="timeline-expand-icon" :class="{ expanded: selectedFilename === item.snapshot.filename }" />
            </div>
            <div v-if="changeSummary(item.snapshot).length > 0" class="timeline-changes">
              <span v-for="part in changeSummary(item.snapshot)" :key="part" class="timeline-change-badge">{{ part }}</span>
            </div>
          </div>

          <!-- Inspector (inline, shown when selected) -->
          <div v-if="selectedFilename === item.snapshot.filename" class="snapshot-inspector" @click.stop>
          <div v-if="detailLoading" class="snapshot-loading">{{ t('common.loading') }}</div>
          <template v-else-if="detail">
            <!-- Diff toggle buttons -->
            <div class="diff-toggle">
              <button
                :class="{ active: diffMode === 'previous' }"
                :disabled="item.snapshotIndex === snapshots.length - 1"
                @click="loadDiff('previous')"
              >
                {{ t('snapshots.diffPrevious') }}
              </button>
              <button
                :class="{ active: diffMode === 'current' }"
                :disabled="item.snapshotIndex === 0"
                @click="loadDiff('current')"
              >
                {{ t('snapshots.diffCurrent') }}
              </button>
            </div>

            <!-- Diff view -->
            <div v-if="diffMode && !diffLoading && diffData" class="diff-view">
              <div v-if="!diffHasChanges(diffData.diff)" class="diff-empty">
                {{ t('snapshots.diffNoChanges') }}
              </div>
              <template v-else>
                <!-- ComfyUI version change -->
                <div v-if="diffData.diff.comfyuiChanged && diffData.diff.comfyui" class="diff-section">
                  <div class="diff-section-title">{{ t('snapshots.comfyuiVersion') }}</div>
                  <div class="diff-line diff-changed">
                    {{ formatVersion(diffData.diff.comfyui.from) }} → {{ formatVersion(diffData.diff.comfyui.to) }}
                  </div>
                </div>

                <!-- Node changes -->
                <div v-if="diffData.diff.nodesAdded.length > 0 || diffData.diff.nodesRemoved.length > 0 || diffData.diff.nodesChanged.length > 0" class="diff-section">
                  <div class="diff-section-title">{{ t('snapshots.customNodes') }}</div>
                  <div v-for="n in diffData.diff.nodesAdded" :key="'add-' + n.id" class="diff-line diff-added">
                    + {{ n.id }} {{ formatNodeVersion(n) }}
                  </div>
                  <div v-for="n in diffData.diff.nodesRemoved" :key="'rem-' + n.id" class="diff-line diff-removed">
                    − {{ n.id }} {{ formatNodeVersion(n) }}
                  </div>
                  <div v-for="n in diffData.diff.nodesChanged" :key="'chg-' + n.id" class="diff-line diff-changed">
                    ~ {{ n.id }}: {{ n.from.version || (n.from.commit ? n.from.commit.slice(0, 7) : '?') }} → {{ n.to.version || (n.to.commit ? n.to.commit.slice(0, 7) : '?') }}
                    <template v-if="n.from.enabled !== n.to.enabled">, {{ n.from.enabled ? 'enabled' : 'disabled' }} → {{ n.to.enabled ? 'enabled' : 'disabled' }}</template>
                  </div>
                </div>

                <!-- Pip changes -->
                <div v-if="diffData.diff.pipsAdded.length > 0 || diffData.diff.pipsRemoved.length > 0 || diffData.diff.pipsChanged.length > 0" class="diff-section">
                  <div class="diff-section-title">
                    {{ t('snapshots.pipPackages') }}
                    ({{ diffData.diff.pipsAdded.length + diffData.diff.pipsRemoved.length + diffData.diff.pipsChanged.length }})
                  </div>
                  <div v-for="p in diffData.diff.pipsAdded" :key="'padd-' + p.name" class="diff-line diff-added">
                    + {{ p.name }} {{ p.version }}
                  </div>
                  <div v-for="p in diffData.diff.pipsRemoved" :key="'prem-' + p.name" class="diff-line diff-removed">
                    − {{ p.name }} {{ p.version }}
                  </div>
                  <div v-for="p in diffData.diff.pipsChanged" :key="'pchg-' + p.name" class="diff-line diff-changed">
                    ~ {{ p.name }}: {{ p.from }} → {{ p.to }}
                  </div>
                </div>
              </template>
            </div>
            <div v-else-if="diffMode && diffLoading" class="snapshot-loading">{{ t('common.loading') }}</div>

            <!-- Environment info -->
            <div class="inspector-section">
              <div class="inspector-section-title">{{ t('snapshots.environment') }}</div>
              <div class="inspector-grid">
                <div class="inspector-field">
                  <span class="inspector-field-label">{{ t('snapshots.comfyuiVersion') }}</span>
                  <span class="inspector-field-value">{{ detail.comfyui.displayVersion || detail.comfyui.ref }}{{ detail.comfyui.commit ? ` (${detail.comfyui.commit.slice(0, 7)})` : '' }}</span>
                </div>
                <div class="inspector-field">
                  <span class="inspector-field-label">{{ t('snapshots.releaseTag') }}</span>
                  <span class="inspector-field-value">{{ detail.comfyui.releaseTag || '—' }}</span>
                </div>
                <div class="inspector-field">
                  <span class="inspector-field-label">{{ t('snapshots.variant') }}</span>
                  <span class="inspector-field-value">{{ context?.variantLabel || detail.comfyui.variant || '—' }}</span>
                </div>
                <div class="inspector-field">
                  <span class="inspector-field-label">{{ t('snapshots.updateChannel') }}</span>
                  <span class="inspector-field-value">{{ detail.updateChannel || context?.updateChannel || '—' }}</span>
                </div>
                <div class="inspector-field">
                  <span class="inspector-field-label">{{ t('snapshots.pythonVersion') }}</span>
                  <span class="inspector-field-value">{{ detail.pythonVersion || context?.pythonVersion || '—' }}</span>
                </div>
                <div class="inspector-field">
                  <span class="inspector-field-label">{{ t('snapshots.capturedAt') }}</span>
                  <span class="inspector-field-value">{{ formatDate(detail.createdAt) }}</span>
                </div>
              </div>
            </div>

            <!-- Custom nodes -->
            <div class="inspector-section">
              <div
                class="inspector-section-title collapsible"
                @click="nodesExpanded = !nodesExpanded"
              >
                <span>{{ t('snapshots.customNodes') }} ({{ detail.customNodes.length }})</span>
                <span class="collapse-indicator">{{ nodesExpanded ? '▾' : '▸' }}</span>
              </div>
              <template v-if="nodesExpanded">
                <input
                  v-if="detail.customNodes.length > 5"
                  v-model="nodeSearch"
                  class="pip-search"
                  type="text"
                  :placeholder="t('snapshots.searchNodes')"
                >
                <div v-if="filteredCustomNodes.length === 0" class="inspector-empty">—</div>
                <div v-else class="node-list">
                  <div v-for="node in filteredCustomNodes" :key="node.id" class="node-row">
                    <span class="node-status" :class="node.enabled ? 'node-enabled' : 'node-disabled'" />
                    <span class="node-name">{{ node.id }}</span>
                    <span class="node-type-badge">{{ node.type }}</span>
                    <span class="node-version">{{ formatNodeVersion(node) }}</span>
                  </div>
                </div>
              </template>
            </div>

            <!-- Pip packages -->
            <div class="inspector-section">
              <div
                class="inspector-section-title collapsible"
                @click="pipExpanded = !pipExpanded"
              >
                <span>{{ t('snapshots.pipPackages') }} ({{ detail.pipPackageCount }})</span>
                <span class="collapse-indicator">{{ pipExpanded ? '▾' : '▸' }}</span>
              </div>
              <template v-if="pipExpanded">
                <input
                  v-model="pipSearch"
                  class="pip-search"
                  type="text"
                  :placeholder="t('snapshots.searchPackages')"
                >
                <div class="pip-list">
                  <div v-for="[name, version] in filteredPipPackages" :key="name" class="pip-row">
                    <span class="pip-name">{{ name }}</span>
                    <span class="pip-version">{{ version }}</span>
                  </div>
                </div>
              </template>
            </div>
          </template>
        </div>
        </div>
      </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.snapshot-tab {
  padding: 8px 0;
}

.snapshot-header {
  display: flex;
  justify-content: flex-end;
  padding: 0 4px 12px;
}

.snapshot-save-btn {
  padding: 6px 16px;
  font-size: 13px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  cursor: pointer;
  transition: all 0.15s;
}
.snapshot-save-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.snapshot-empty {
  text-align: center;
  color: var(--text-muted);
  padding: 40px 20px;
  font-size: 14px;
}

.snapshot-loading {
  color: var(--text-muted);
  font-size: 13px;
  padding: 16px 0;
}

/* Timeline */
.snapshot-timeline {
  display: flex;
  flex-direction: column;
}

.timeline-entry {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 0 10px;
}

.timeline-gutter {
  grid-column: 1;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.timeline-content {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
}

.timeline-line {
  width: 2px;
  background: var(--border);
}
.timeline-line-top {
  width: 2px;
  height: 16px;
  background: var(--border);
  flex-shrink: 0;
}
.timeline-line-rest {
  width: 2px;
  flex: 1;
  background: var(--border);
}
.timeline-line.invisible,
.timeline-line-top.invisible,
.timeline-line-rest.invisible {
  visibility: hidden;
}

.timeline-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-faint);
  border: 2px solid var(--surface);
  box-sizing: content-box;
}
.timeline-dot.trigger-boot { background: var(--text-muted); }
.timeline-dot.trigger-manual { background: var(--success, #00cd72); }
.timeline-dot.trigger-preupdate { background: var(--success, #00cd72); }
.timeline-dot.trigger-postupdate { background: var(--warning, #fd9903); }
.timeline-dot.trigger-postrestore { background: var(--warning, #fd9903); }
.timeline-dot.trigger-restart { background: var(--info, #58a6ff); }
.timeline-dot.trigger-copy { background: var(--text-muted); }

.timeline-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.timeline-card:hover {
  border-color: var(--border-hover);
}
.timeline-entry.selected .timeline-card {
  border-color: var(--accent);
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  border-bottom-color: transparent;
  margin-bottom: 0;
}

.timeline-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.timeline-trigger {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--bg);
}
.timeline-trigger.trigger-boot { color: var(--text-muted); }
.timeline-trigger.trigger-manual { color: var(--success, #00cd72); }
.timeline-trigger.trigger-preupdate { color: var(--success, #00cd72); }
.timeline-trigger.trigger-postupdate { color: var(--warning, #fd9903); }
.timeline-trigger.trigger-postrestore { color: var(--warning, #fd9903); }
.timeline-trigger.trigger-restart { color: var(--info, #58a6ff); }
.timeline-trigger.trigger-copy { color: var(--text-muted); }

/* Copy event card */
.timeline-copy-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  margin-bottom: 6px;
  border-radius: 8px;
  border: 1px dashed var(--border);
  background: var(--surface);
  font-size: 12px;
}

.timeline-copy-name {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.timeline-copy-name.clickable {
  background: none;
  border: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.timeline-copy-name.clickable:hover {
  text-decoration: underline;
}

.timeline-current-tag {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  padding: 1px 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}

.timeline-time {
  font-size: 12px;
  color: var(--text-faint);
  margin-left: auto;
}

.timeline-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  margin-bottom: 4px;
}

.timeline-meta {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.timeline-meta-sep {
  color: var(--text-faint);
}

.timeline-changes {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.timeline-change-badge {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg);
  padding: 1px 6px;
  border-radius: 3px;
}

.timeline-card-body {
  display: flex;
  align-items: center;
  gap: 8px;
}

.timeline-restore-btn {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 4px;
  background: none;
  border: 1px solid var(--border);
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s;
  flex-shrink: 0;
}
.timeline-card:hover .timeline-restore-btn,
.timeline-restore-btn:focus-visible {
  opacity: 1;
}
.timeline-restore-btn:hover {
  color: var(--text);
  border-color: var(--accent);
}

.timeline-delete-btn {
  padding: 3px 6px;
  font-size: 11px;
  border-radius: 4px;
  background: none;
  border: 1px solid transparent;
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s;
  flex-shrink: 0;
  line-height: 1;
}
.timeline-card:hover .timeline-delete-btn,
.timeline-delete-btn:focus-visible {
  opacity: 1;
}
.timeline-delete-btn:hover {
  color: var(--danger);
  border-color: var(--danger);
}

.timeline-expand-icon {
  color: var(--text-faint);
  flex-shrink: 0;
  margin-left: auto;
  transition: transform 0.15s;
}
.timeline-expand-icon.expanded {
  transform: rotate(180deg);
}
.timeline-card:hover .timeline-expand-icon {
  color: var(--text-muted);
}

/* Inspector (inline below the card) */
.snapshot-inspector {
  background: var(--surface);
  border: 1px solid var(--accent);
  border-top: none;
  border-radius: 0 0 8px 8px;
  padding: 12px 14px;
  margin-bottom: 6px;
}

/* Diff toggle */
.diff-toggle {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
}
.diff-toggle button {
  flex: 1;
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 5px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}
.diff-toggle button:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-hover);
}
.diff-toggle button.active {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  border-color: var(--accent);
  color: var(--accent);
}
.diff-toggle button:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Diff view */
.diff-view {
  margin-bottom: 12px;
  background: var(--bg);
  border-radius: 6px;
  padding: 10px 12px;
}

.diff-section {
  margin-bottom: 8px;
}
.diff-section:last-child {
  margin-bottom: 0;
}

.diff-section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 4px;
}

.diff-line {
  font-size: 12px;
  font-family: monospace;
  padding: 1px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.diff-added { color: var(--success, #00cd72); }
.diff-removed { color: var(--danger); }
.diff-changed { color: var(--warning, #fd9903); }

.diff-empty {
  font-size: 13px;
  color: var(--text-muted);
  text-align: center;
  padding: 8px 0;
}

/* Inspector sections */
.inspector-section {
  margin-bottom: 12px;
}
.inspector-section:last-child {
  margin-bottom: 0;
}

.inspector-section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 6px;
}
.inspector-section-title.collapsible {
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  user-select: none;
}
.collapse-indicator {
  font-size: 12px;
}

.inspector-empty {
  font-size: 13px;
  color: var(--text-faint);
}

/* Environment grid */
.inspector-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 16px;
}

.inspector-field {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.inspector-field-label {
  font-size: 11px;
  color: var(--text-faint);
}

.inspector-field-value {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Node list */
.node-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 240px;
  overflow-y: auto;
}

.node-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;
}

.node-status {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.node-enabled { background: var(--info, #58a6ff); }
.node-disabled { background: var(--text-faint); }

.node-name {
  color: var(--text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-type-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-faint);
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  flex-shrink: 0;
}

.node-version {
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
  font-family: monospace;
}

/* Pip packages */
.pip-search {
  width: 100%;
  padding: 6px 10px;
  font-size: 12px;
  border-radius: 5px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  margin-bottom: 6px;
  box-sizing: border-box;
}
.pip-search:focus {
  outline: none;
  border-color: var(--accent);
}

.pip-list {
  max-height: 300px;
  overflow-y: auto;
}

.pip-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
  font-size: 12px;
}

.pip-name {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.pip-version {
  color: var(--text-muted);
  font-family: monospace;
  flex-shrink: 0;
  margin-left: 12px;
}
</style>
