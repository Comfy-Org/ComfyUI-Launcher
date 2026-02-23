<script setup lang="ts">
import { ref, onMounted, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from './stores/sessionStore'
import { useInstallationStore } from './stores/installationStore'
import { useModal } from './composables/useModal'
import { useTheme } from './composables/useTheme'
import type { Installation, ActionResult } from './types/ipc'

import ModalDialog from './components/ModalDialog.vue'
import UpdateBanner from './components/UpdateBanner.vue'
import InstallationList from './views/InstallationList.vue'
import RunningView from './views/RunningView.vue'
import SettingsView from './views/SettingsView.vue'
import ModelsView from './views/ModelsView.vue'
import DetailModal from './views/DetailModal.vue'
import ConsoleModal from './views/ConsoleModal.vue'
import ProgressModal from './views/ProgressModal.vue'
import NewInstallModal from './views/NewInstallModal.vue'
import TrackModal from './views/TrackModal.vue'

// Lucide icons
import { Box, Play, FolderOpen, Settings } from 'lucide-vue-next'

const { t, setLocaleMessage, locale } = useI18n()
const sessionStore = useSessionStore()
const installationStore = useInstallationStore()
const modal = useModal()
useTheme()

// --- View state ---
type TabView = 'list' | 'running' | 'models' | 'settings'
const activeView = ref<TabView>('list')

// --- Modal views ---
const detailInstallation = ref<Installation | null>(null)
const consoleInstallationId = ref<string | null>(null)
const progressInstallationId = ref<string | null>(null)
const showNewInstall = ref(false)
const showTrack = ref(false)

// --- Template refs ---
const listRef = ref<InstanceType<typeof InstallationList> | null>(null)
const settingsRef = ref<InstanceType<typeof SettingsView> | null>(null)
const modelsRef = ref<InstanceType<typeof ModelsView> | null>(null)
const progressRef = ref<InstanceType<typeof ProgressModal> | null>(null)
const newInstallRef = ref<InstanceType<typeof NewInstallModal> | null>(null)
const trackRef = ref<InstanceType<typeof TrackModal> | null>(null)

// --- Sidebar ---
const sidebarItems = computed(() => [
  { key: 'list' as const, icon: Box, labelKey: 'sidebar.installations' },
  { key: 'running' as const, icon: Play, labelKey: 'sidebar.running' },
  { key: 'models' as const, icon: FolderOpen, labelKey: 'models.title' },
  { key: 'settings' as const, icon: Settings, labelKey: 'settings.title' },
])

function switchView(view: TabView): void {
  activeView.value = view
  if (view === 'list') listRef.value?.refresh()
  else if (view === 'settings') settingsRef.value?.loadSettings()
  else if (view === 'models') modelsRef.value?.loadModels()
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
  showNewInstall.value = true
  await nextTick()
  newInstallRef.value?.open()
}

function closeNewInstall(): void {
  showNewInstall.value = false
}

async function openTrack(): Promise<void> {
  showTrack.value = true
  await nextTick()
  trackRef.value?.open()
}

function closeTrack(): void {
  showTrack.value = false
}

function showProgress(opts: {
  installationId: string
  title: string
  apiCall: () => Promise<unknown>
  cancellable?: boolean
  returnTo?: string
}): void {
  progressInstallationId.value = opts.installationId
  // If an operation already exists for this ID, just show it
  if (progressRef.value?.operations.has(opts.installationId)) {
    progressRef.value.showOperation(opts.installationId)
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
function setupQuitConfirmation(): void {
  window.api.onConfirmQuit(async () => {
    const confirmed = await modal.confirm({
      title: t('settings.closeQuitTitle'),
      message: t('settings.closeQuitMessage'),
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
        </button>
      </div>
    </nav>

    <!-- Content Area -->
    <main class="content">
      <InstallationList
        v-show="activeView === 'list'"
        ref="listRef"
        @show-detail="openDetail"
        @show-console="openConsole"
        @show-progress="showProgress"
        @show-new-install="openNewInstall"
        @show-track="openTrack"
      >
        <template #update-banner>
          <UpdateBanner />
        </template>
      </InstallationList>

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
    @update:installation="(inst) => detailInstallation = inst"
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

  <TrackModal
    v-if="showTrack"
    ref="trackRef"
    @close="closeTrack"
    @navigate-list="handleNavigateList"
  />

  <!-- Global modal dialog (alerts/confirms/prompts/selects) -->
  <ModalDialog />
</template>
