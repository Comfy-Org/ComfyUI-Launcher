<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import { useModal } from '../composables/useModal'
import { useLocalInstanceGuard } from '../composables/useLocalInstanceGuard'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { useProgressStore } from '../stores/progressStore'
import { DraggableList } from '../lib/draggableList'
import InstanceCard from '../components/InstanceCard.vue'
import ContextMenu from '../components/ContextMenu.vue'
import type { Installation, ListAction } from '../types/ipc'

const { t } = useI18n()
const sessionStore = useSessionStore()
const installationStore = useInstallationStore()
const progressStore = useProgressStore()
const modal = useModal()
const localInstanceGuard = useLocalInstanceGuard()

const filter = ref('all')
const listActions = ref(new Map<string, ListAction[]>())

const cardProgress = computed(() => {
  const map = new Map<string, { status: string; percent: number }>()
  for (const inst of installationStore.installations) {
    const info = progressStore.getProgressInfo(inst.id)
    if (info) map.set(inst.id, info)
  }
  return map
})

const filteredInstallations = computed(() => {
  if (filter.value === 'all') return installationStore.installations
  return installationStore.installations.filter((i) => i.sourceCategory === filter.value)
})

const hasLocal = computed(() =>
  installationStore.installations.some((i) => i.sourceCategory === 'local')
)

async function refresh(): Promise<void> {
  await installationStore.fetchInstallations()
  for (const inst of installationStore.installations) {
    if (
      !sessionStore.isRunning(inst.id) &&
      !sessionStore.activeSessions.has(inst.id)
    ) {
      const actions = await window.api.getListActions(inst.id)
      listActions.value.set(inst.id, actions)
    }
  }
}

onMounted(() => refresh())

watch(
  [
    () => sessionStore.runningInstances.size,
    () => sessionStore.activeSessions.size,
    () => sessionStore.errorInstances.size,
  ],
  () => refresh()
)

function setFilter(f: string): void {
  filter.value = f
}

interface MetaPart {
  text: string
  class?: string
  wrapClass?: string
}

function getMetaParts(inst: Installation): MetaPart[] {
  const parts: MetaPart[] = [{ text: inst.sourceLabel }]
  if (inst.version) parts.push({ text: inst.version })
  if (sessionStore.isRunning(inst.id)) {
    parts.push({ text: t('list.running'), class: 'status-running' })
  } else if (sessionStore.errorInstances.has(inst.id)) {
    parts.push({ text: t('running.crashed'), class: 'status-danger' })
  }
  const activeSession = sessionStore.activeSessions.get(inst.id)
  if (!sessionStore.isRunning(inst.id) && activeSession) {
    parts.push({ text: activeSession.label, class: 'status-in-progress' })
  }
  if (inst.statusTag) {
    parts.push({ text: inst.statusTag.label, class: `status-${inst.statusTag.style}` })
  }
  if (inst.seen === false) {
    parts.push({ text: t('list.new'), class: 'status-new', wrapClass: 'status-new-wrap' })
  }
  return parts
}

function getLaunchMeta(inst: Installation): string {
  if (inst.listPreview) return inst.listPreview
  if (inst.launchMode) {
    return inst.launchMode + (inst.launchArgs ? ' · ' + inst.launchArgs : '')
  }
  return ''
}

async function handleListAction(inst: Installation, action: ListAction): Promise<void> {
  if (action.enabled === false && action.disabledMessage) {
    await modal.alert({ title: action.label, message: action.disabledMessage })
    return
  }
  if (inst.seen === false) {
    inst.seen = true
    window.api.updateInstallation(inst.id, { seen: true })
  }
  if (action.confirm) {
    const confirmed = await modal.confirm({
      title: action.confirm.title || 'Confirm',
      message: action.confirm.message || 'Are you sure?',
      confirmLabel: action.label,
      confirmStyle: action.style || 'danger',
    })
    if (!confirmed) return
  }
  if (action.id === 'launch') {
    const canLaunch = await localInstanceGuard.checkBeforeLaunch(inst.id)
    if (!canLaunch) return
  }
  if (action.showProgress) {
    emit('show-progress', {
      installationId: inst.id,
      title: `${action.progressTitle || action.label} — ${inst.name}`,
      apiCall: () => window.api.runAction(inst.id, action.id),
      cancellable: !!action.cancellable,
    })
    return
  }
  const result = await window.api.runAction(inst.id, action.id)
  if (result.navigate === 'list') {
    await refresh()
  } else if (result.message) {
    await modal.alert({ title: action.label, message: result.message })
  }
}

// --- Drag-to-reorder ---
const listContainerRef = useTemplateRef<HTMLElement>('listContainer')
let draggableList: DraggableList | null = null

function initDraggable(): void {
  draggableList?.dispose()
  draggableList = null
  if (!listContainerRef.value) return
  draggableList = new DraggableList(
    listContainerRef.value,
    '.instance-card',
    { onReorder: handleReorder }
  )
}

async function handleReorder(oldIndex: number, newIndex: number): Promise<void> {
  const visible = filteredInstallations.value
  const movedId = visible[oldIndex]?.id
  const targetId = visible[newIndex]?.id
  if (!movedId || !targetId || movedId === targetId) return
  const ids = installationStore.installations.map((i) => i.id)
  const fromIdx = ids.indexOf(movedId)
  const toIdx = ids.indexOf(targetId)
  if (fromIdx === -1 || toIdx === -1) return
  const moved = ids.splice(fromIdx, 1)[0]
  if (moved) ids.splice(toIdx, 0, moved)
  // Optimistically reorder the store so Vue re-renders before next paint
  const byId = new Map(installationStore.installations.map((i) => [i.id, i]))
  installationStore.installations = ids.map((id) => byId.get(id)!).filter(Boolean)
  await window.api.reorderInstallations(ids)
  refresh()
}

watch(
  () => filteredInstallations.value.map((i) => i.id).join('|'),
  () => initDraggable(),
  { flush: 'post' }
)

onMounted(() => initDraggable())
onBeforeUnmount(() => draggableList?.dispose())

function markSeen(inst: Installation): void {
  if (inst.seen === false) {
    inst.seen = true
    window.api.updateInstallation(inst.id, { seen: true })
  }
}

function focusComfyWindow(installationId: string): void {
  window.api.focusComfyWindow(installationId)
}

function stopComfyUI(installationId: string): void {
  window.api.stopComfyUI(installationId)
}

const filterKeys = ['all', 'local', 'remote', 'cloud'] as const

function filterLabel(f: string): string {
  return t(`list.filter${f.charAt(0).toUpperCase() + f.slice(1)}`)
}

const filterStats = computed(() => {
  const stats: Record<string, { count: number; hasNew: boolean }> = {}
  for (const f of filterKeys) {
    const list = f === 'all'
      ? installationStore.installations
      : installationStore.installations.filter((i) => i.sourceCategory === f)
    stats[f] = { count: list.length, hasNew: list.some((i) => i.seen === false) }
  }
  return stats
})

const emit = defineEmits<{
  'show-detail': [inst: Installation]
  'show-console': [installationId: string]
  'show-progress': [opts: {
    installationId: string
    title: string
    apiCall: () => Promise<unknown>
    cancellable?: boolean
  }]
  'show-new-install': []
  'show-track': []
}>()

// --- Context menu ---
const { ctxMenu, ctxMenuItems, openCardMenu, handleCtxMenuSelect, closeMenu } =
  useInstallContextMenu((inst) => emit('show-detail', inst))

defineExpose({ refresh })
</script>

<template>
  <div class="view active">
    <div class="toolbar">
      <div class="breadcrumb">
        <span class="breadcrumb-current">{{ $t('list.title') }}</span>
      </div>
      <div class="toolbar-actions">
        <button @click="emit('show-track')">{{ $t('list.trackExisting') }}</button>
        <button class="primary add-btn" @click="emit('show-new-install')">
          + {{ $t('list.newInstall') }}
        </button>
      </div>
    </div>

    <div class="filter-tabs">
      <button
        v-for="f in filterKeys"
        :key="f"
        class="filter-tab"
        :class="{ active: filter === f }"
        @click="setFilter(f)"
      >
        {{ filterLabel(f) }}<span v-if="filterStats[f]?.count" class="filter-count" :class="{ 'has-new': filterStats[f]?.hasNew }">{{ filterStats[f]?.count }}</span>
      </button>
    </div>

    <div class="view-list-scroll">
      <div ref="listContainer" class="instance-list">
        <!-- Empty: has local but filtered out -->
        <div v-if="filteredInstallations.length === 0 && hasLocal" class="empty-state">
          {{ $t('list.emptyFilter') }}
        </div>

        <!-- Empty: no installations at all -->
        <div v-else-if="filteredInstallations.length === 0" class="empty-state">
          <div style="font-weight: 700; color: var(--text-faint)">{{ $t('list.empty') }}</div>
          <div style="margin-top: 4px">{{ $t('list.emptyHint') }}</div>
          <button class="accent add-btn" style="margin-top: 8px" @click="emit('show-new-install')">
            + {{ $t('list.newInstall') }}
          </button>
        </div>

        <!-- Installation cards -->
        <InstanceCard
          v-for="inst in filteredInstallations"
          :key="inst.id"
          :installation-id="inst.id"
          :name="inst.name"
          :source-category="inst.sourceCategory"
          :draggable="true"
          @mousedown="markSeen(inst)"
          @contextmenu.prevent="openCardMenu($event, inst)"
        >
          <template #meta>
            <template v-for="(part, i) in getMetaParts(inst)" :key="i">
              <template v-if="i > 0"> · </template>
              <span v-if="part.wrapClass" :class="part.wrapClass"><span :class="part.class">{{ part.text }}</span></span>
              <span v-else-if="part.class" :class="part.class">{{ part.text }}</span>
              <template v-else>{{ part.text }}</template>
            </template>
          </template>

          <template #extra-info>
            <div v-if="getLaunchMeta(inst)" class="instance-meta">{{ getLaunchMeta(inst) }}</div>
            <div
              v-if="cardProgress.get(inst.id)"
              class="card-progress"
            >
              <div class="card-progress-status">{{ cardProgress.get(inst.id)!.status }}</div>
              <div class="card-progress-track">
                <div
                  class="card-progress-fill"
                  :class="{ indeterminate: cardProgress.get(inst.id)!.percent < 0 }"
                  :style="cardProgress.get(inst.id)!.percent >= 0
                    ? { width: cardProgress.get(inst.id)!.percent + '%' }
                    : { width: '100%' }"
                ></div>
              </div>
            </div>
          </template>

          <template #actions>
            <!-- In-progress -->
            <template v-if="sessionStore.activeSessions.has(inst.id) && !sessionStore.isRunning(inst.id)">
              <button
                class="primary"
                @click="emit('show-progress', {
                  installationId: inst.id,
                  title: '',
                  apiCall: async () => ({}),
                })"
              >
                {{ $t('list.viewProgress') }}
              </button>
            </template>

            <!-- Running -->
            <template v-else-if="sessionStore.isRunning(inst.id)">
              <button
                v-if="sessionStore.runningInstances.get(inst.id)?.mode !== 'console'"
                class="primary"
                @click="focusComfyWindow(inst.id)"
              >
                {{ $t('running.showWindow') }}
              </button>
              <button v-if="inst.hasConsole" @click="emit('show-console', inst.id)">
                {{ $t('list.console') }}
              </button>
              <button class="danger" @click="stopComfyUI(inst.id)">
                {{ $t('console.stop') }}
              </button>
            </template>

            <!-- Idle / Error: list actions -->
            <template v-else>
              <button
                v-for="a in (listActions.get(inst.id) || [])"
                :key="a.id"
                :class="[a.style, { 'looks-disabled': a.enabled === false && a.disabledMessage }]"
                :disabled="a.enabled === false && !a.disabledMessage"
                @click="handleListAction(inst, a)"
              >
                {{ a.label }}
              </button>
              <button v-if="sessionStore.errorInstances.has(inst.id) && inst.hasConsole" @click="emit('show-console', inst.id)">
                {{ $t('list.viewError') }}
              </button>
            </template>

            <button class="manage-btn" @click="emit('show-detail', inst)">
              {{ $t('list.view') }}
            </button>
          </template>
        </InstanceCard>

        <!-- Prompt to install when no local installations exist -->
        <div
          v-if="filteredInstallations.length > 0 && !hasLocal && (filter === 'all' || filter === 'local')"
          class="empty-state"
        >
          <div style="font-weight: 700; color: var(--text-faint)">{{ $t('list.empty') }}</div>
          <div style="margin-top: 4px">{{ $t('list.emptyHint') }}</div>
          <button class="accent add-btn" style="margin-top: 8px" @click="emit('show-new-install')">
            + {{ $t('list.newInstall') }}
          </button>
        </div>
      </div>
    </div>

    <slot name="update-banner" />

    <ContextMenu
      :open="ctxMenu.open"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenuItems"
      @close="closeMenu"
      @select="handleCtxMenuSelect"
    />
  </div>
</template>
