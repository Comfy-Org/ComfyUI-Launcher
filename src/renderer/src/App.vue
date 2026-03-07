<script setup lang="ts">
import { ref, onMounted, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from './stores/sessionStore'
import { useInstallationStore } from './stores/installationStore'
import { useProgressStore } from './stores/progressStore'
import { useDownloadStore } from './stores/downloadStore'
import { useModal } from './composables/useModal'
import { useTheme } from './composables/useTheme'
import { useLauncherPrefs } from './composables/useLauncherPrefs'
import type { Installation, ActionResult, QuitActiveItem } from './types/ipc'
import type { ModalDetailGroup } from './composables/useModal'
import { emitTelemetryAction } from './lib/telemetry'

import ModalDialog from './components/ModalDialog.vue'
import UpdateBanner from './components/UpdateBanner.vue'
import ZoomBanner from './components/ZoomBanner.vue'
import DashboardView from './views/DashboardView.vue'
import InstallationList from './views/InstallationList.vue'
import RunningView from './views/RunningView.vue'
import SettingsView from './views/SettingsView.vue'
import ModelsView from './views/ModelsView.vue'
import MediaView from './views/MediaView.vue'
import DetailModal from './views/DetailModal.vue'
import ConsoleModal from './views/ConsoleModal.vue'
import ProgressModal from './views/ProgressModal.vue'
import NewInstallModal from './views/NewInstallModal.vue'
import QuickInstallModal from './views/QuickInstallModal.vue'
import TrackModal from './views/TrackModal.vue'
import LoadSnapshotModal from './views/LoadSnapshotModal.vue'

// Lucide icons
import { LayoutDashboard, Box, Play, FolderOpen, Image, Settings } from 'lucide-vue-next'

const { t, setLocaleMessage, locale } = useI18n()
const sessionStore = useSessionStore()
const installationStore = useInstallationStore()
const progressStore = useProgressStore()
const downloadStore = useDownloadStore()
const modal = useModal()
const launcherPrefs = useLauncherPrefs()
useTheme()

// --- View state ---
type TabView = 'dashboard' | 'list' | 'running' | 'models' | 'media' | 'settings'
const activeView = ref<TabView>('dashboard')

// --- Modal views ---
const detailInstallation = ref<Installation | null>(null)
const consoleInstallationId = ref<string | null>(null)
const progressInstallationId = ref<string | null>(null)
const showNewInstall = ref(false)
const showQuickInstall = ref(false)
const showTrack = ref(false)
const showLoadSnapshot = ref(false)

// --- Template refs ---
const listRef = ref<InstanceType<typeof InstallationList> | null>(null)
const settingsRef = ref<InstanceType<typeof SettingsView> | null>(null)
const modelsRef = ref<InstanceType<typeof ModelsView> | null>(null)
const mediaRef = ref<InstanceType<typeof MediaView> | null>(null)
const progressRef = ref<InstanceType<typeof ProgressModal> | null>(null)
const newInstallRef = ref<InstanceType<typeof NewInstallModal> | null>(null)
const quickInstallRef = ref<InstanceType<typeof QuickInstallModal> | null>(null)
const trackRef = ref<InstanceType<typeof TrackModal> | null>(null)
const loadSnapshotRef = ref<InstanceType<typeof LoadSnapshotModal> | null>(null)

// --- Sidebar ---
const sidebarItems = computed(() => [
  { key: 'dashboard' as const, icon: LayoutDashboard, labelKey: 'dashboard.title' },
  { key: 'list' as const, icon: Box, labelKey: 'sidebar.installations' },
  { key: 'running' as const, icon: Play, labelKey: 'sidebar.running' },
  { key: 'models' as const, icon: FolderOpen, labelKey: 'models.title' },
  { key: 'media' as const, icon: Image, labelKey: 'media.title' },
  { key: 'settings' as const, icon: Settings, labelKey: 'settings.title' },
])

function switchView(view: TabView): void {
  const fromView = activeView.value
  activeView.value = view
  if (view !== fromView) {
    emitTelemetryAction('launcher.view.opened', {
      view,
      from_view: fromView,
    })
  }
  if (view === 'list') listRef.value?.refresh()
  else if (view === 'settings') settingsRef.value?.loadSettings()
  else if (view === 'models') modelsRef.value?.loadModels()
  else if (view === 'media') mediaRef.value?.loadMedia()
}

// --- Modal handlers ---
function openDetail(inst: Installation): void {
  detailInstallation.value = inst
}

function closeDetail(): void {
  detailInstallation.value = null
}

function openConsole(installationId: string): void {
  consoleInstallationId.value = installationId
}

function closeConsole(): void {
  consoleInstallationId.value = null
}

async function openNewInstall(): Promise<void> {
  emitTelemetryAction('launcher.install.flow.opened', {
    flow: 'new_install',
    entrypoint: activeView.value,
  })
  showNewInstall.value = true
  await nextTick()
  newInstallRef.value?.open()
}

function closeNewInstall(): void {
  showNewInstall.value = false
}

async function openQuickInstall(): Promise<void> {
  emitTelemetryAction('launcher.install.flow.opened', {
    flow: 'quick_install',
    entrypoint: activeView.value,
  })
  showQuickInstall.value = true
  await nextTick()
  quickInstallRef.value?.open()
}

function closeQuickInstall(): void {
  showQuickInstall.value = false
}

async function openTrack(): Promise<void> {
  emitTelemetryAction('launcher.install.flow.opened', {
    flow: 'track_existing',
    entrypoint: activeView.value,
  })
  showTrack.value = true
  await nextTick()
  trackRef.value?.open()
}

function closeTrack(): void {
  showTrack.value = false
}

async function openLoadSnapshot(): Promise<void> {
  emitTelemetryAction('launcher.install.flow.opened', {
    flow: 'load_snapshot',
    entrypoint: activeView.value,
  })
  showLoadSnapshot.value = true
  await nextTick()
  loadSnapshotRef.value?.open()
}

function closeLoadSnapshot(): void {
  showLoadSnapshot.value = false
}

function showProgress(opts: {
  installationId: string
  title: string
  apiCall: () => Promise<unknown>
  cancellable?: boolean
  returnTo?: string
}): void {
  // Close any open modal so they don't stack visually
  if (opts.returnTo === 'detail') closeDetail()
  progressInstallationId.value = opts.installationId
  // If an in-progress operation already exists for this ID, just show it
  const existingOp = progressStore.operations.get(opts.installationId)
  if (existingOp && !existingOp.finished) {
    progressRef.value!.showOperation(opts.installationId)
    return
  }
  progressRef.value?.startOperation({
    installationId: opts.installationId,
    title: opts.title,
    apiCall: opts.apiCall as () => Promise<ActionResult>,
    cancellable: opts.cancellable,
    returnTo: opts.returnTo,
  })
}

function closeProgress(): void {
  progressInstallationId.value = null
  listRef.value?.refresh()
}

function handleNavigateList(): void {
  closeDetail()
  listRef.value?.refresh()
}

function handleProgressShowDetail(installationId: string): void {
  closeProgress()
  const inst = installationStore.getById(installationId)
  if (inst) openDetail(inst)
}

// --- Quit confirmation ---
function buildQuitDetails(details: QuitActiveItem[]): ModalDetailGroup[] {
  const groups: { label: string; type: QuitActiveItem['type'] }[] = [
    { label: t('settings.closeQuitSessions'), type: 'session' },
    { label: t('settings.closeQuitOperations'), type: 'operation' },
    { label: t('settings.closeQuitDownloads'), type: 'download' },
  ]
  return groups
    .map(({ label, type }) => ({ label, items: details.filter((d) => d.type === type).map((d) => d.name) }))
    .filter((g) => g.items.length > 0)
}

function setupQuitConfirmation(): void {
  window.api.onConfirmQuit(async (details) => {
    const confirmed = await modal.confirm({
      title: t('settings.closeQuitTitle'),
      message: t('settings.closeQuitMessage'),
      messageDetails: buildQuitDetails(details),
      confirmLabel: t('settings.closeQuitConfirm'),
      confirmStyle: 'danger',
    })
    if (confirmed) window.api.quitApp()
  })
}

// --- Locale ---
async function loadLocale(): Promise<void> {
  const messages = await window.api.getLocaleMessages()
  setLocaleMessage('en', messages)
  locale.value = 'en'
}

function setupLocaleListener(): void {
  window.api.onLocaleChanged((messages) => {
    setLocaleMessage('en', messages)
  })
}

// --- Init ---
onMounted(async () => {
  await loadLocale()
  await sessionStore.init()
  downloadStore.init()
  launcherPrefs.loadPrefs()
  setupQuitConfirmation()
  setupLocaleListener()
  listRef.value?.refresh()
})
</script>

<template>
  <div class="app-layout">
    <!-- Sidebar -->
    <nav class="sidebar">
      <div class="sidebar-brand">ComfyUI Launcher</div>
      <div class="sidebar-nav">
        <button
          v-for="item in sidebarItems"
          :key="item.key"
          class="sidebar-item"
          :class="{ active: activeView === item.key }"
          @click="switchView(item.key)"
        >
          <component :is="item.icon" :size="18" />
          <span>{{ $t(item.labelKey) }}</span>
          <template v-if="item.key === 'running'">
            <span
              v-if="sessionStore.hasErrors"
              class="sidebar-error-dot"
            ></span>
            <span
              v-if="sessionStore.runningTabCount > 0"
              class="sidebar-count"
            >{{ sessionStore.runningTabCount }}</span>
          </template>
          <template v-if="item.key === 'models'">
            <span
              v-if="downloadStore.activeDownloads.length > 0"
              class="sidebar-count"
            >{{ downloadStore.activeDownloads.length }}</span>
          </template>
        </button>
      </div>
    </nav>

    <!-- Content Area -->
    <main class="content">
      <UpdateBanner />
      <ZoomBanner />
      <DashboardView
        v-show="activeView === 'dashboard'"
        :visible="activeView === 'dashboard'"
        @show-quick-install="openQuickInstall"
        @show-settings="switchView('settings')"
        @show-detail="openDetail"
        @show-console="openConsole"
        @show-progress="showProgress"
      />

      <InstallationList
        v-show="activeView === 'list'"
        ref="listRef"
        @show-detail="openDetail"
        @show-console="openConsole"
        @show-progress="showProgress"
        @show-new-install="openNewInstall"
        @show-track="openTrack"
        @show-load-snapshot="openLoadSnapshot"
      />

      <RunningView
        v-show="activeView === 'running'"
        @show-detail="openDetail"
        @show-console="openConsole"
        @show-progress="showProgress"
      />

      <ModelsView
        v-show="activeView === 'models'"
        ref="modelsRef"
      />

      <MediaView
        v-show="activeView === 'media'"
        ref="mediaRef"
      />

      <SettingsView
        v-show="activeView === 'settings'"
        ref="settingsRef"
      />
    </main>
  </div>

  <!-- Modal views -->
  <DetailModal
    :installation="detailInstallation"
    @close="closeDetail"
    @show-progress="showProgress"
    @navigate-list="handleNavigateList"
    @update:installation="(inst) => { detailInstallation = inst; installationStore.fetchInstallations() }"
  />

  <ConsoleModal
    :installation-id="consoleInstallationId"
    @close="closeConsole"
  />

  <ProgressModal
    ref="progressRef"
    :installation-id="progressInstallationId"
    @close="closeProgress"
    @show-detail="handleProgressShowDetail"
    @show-console="openConsole"
  />

  <NewInstallModal
    v-if="showNewInstall"
    ref="newInstallRef"
    @close="closeNewInstall"
    @show-progress="showProgress"
    @navigate-list="handleNavigateList"
  />

  <QuickInstallModal
    v-if="showQuickInstall"
    ref="quickInstallRef"
    @close="closeQuickInstall"
    @show-progress="showProgress"
  />

  <TrackModal
    v-if="showTrack"
    ref="trackRef"
    @close="closeTrack"
    @navigate-list="handleNavigateList"
  />

  <LoadSnapshotModal
    v-if="showLoadSnapshot"
    ref="loadSnapshotRef"
    @close="closeLoadSnapshot"
    @show-progress="showProgress"
  />

  <!-- Global modal dialog (alerts/confirms/prompts/selects) -->
  <ModalDialog />
</template>
