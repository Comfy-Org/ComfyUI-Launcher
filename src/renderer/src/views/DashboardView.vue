<script setup lang="ts">
import { computed, watch, ref } from 'vue'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import { useModal } from '../composables/useModal'
import { useLocalInstanceGuard } from '../composables/useLocalInstanceGuard'
import { Play, Download, ExternalLink, Square } from 'lucide-vue-next'
import type { Installation, ListAction } from '../types/ipc'

const props = defineProps<{
  visible: boolean
}>()

const installationStore = useInstallationStore()
const sessionStore = useSessionStore()
const progressStore = useProgressStore()
const modal = useModal()
const localInstanceGuard = useLocalInstanceGuard()

const emit = defineEmits<{
  'show-new-install': []
  'show-detail': [inst: Installation]
  'show-console': [installationId: string]
  'show-progress': [opts: {
    installationId: string
    title: string
    apiCall: () => Promise<unknown>
    cancellable?: boolean
  }]
}>()

// Primary install: first local installation in the list.
// TODO: Change to most recently-launched local install.
const primaryInstall = computed(() =>
  installationStore.installations.find(
    (i) => i.sourceCategory === 'local'
  ) ?? null
)

const primaryIsInstalled = computed(() =>
  primaryInstall.value?.status === 'installed'
)

const primaryActions = ref<ListAction[]>([])

watch(
  [
    () => primaryInstall.value?.id,
    () => props.visible,
    () => sessionStore.runningInstances.size,
    () => sessionStore.activeSessions.size,
    () => sessionStore.errorInstances.size,
  ],
  async () => {
    const id = primaryInstall.value?.id
    if (!id || !props.visible) { primaryActions.value = []; return }
    if (
      !sessionStore.isRunning(id) &&
      !sessionStore.activeSessions.has(id) &&
      !sessionStore.errorInstances.has(id)
    ) {
      primaryActions.value = await window.api.getListActions(id)
    } else {
      primaryActions.value = []
    }
  },
  { immediate: true }
)

const launchAction = computed(() =>
  primaryActions.value.find((a) => a.style === 'primary') ?? primaryActions.value[0] ?? null
)

const primaryProgress = computed(() => {
  if (!primaryInstall.value) return null
  return progressStore.getProgressInfo(primaryInstall.value.id)
})

const primaryRunning = computed(() => {
  const id = primaryInstall.value?.id
  return id ? sessionStore.runningInstances.get(id) ?? null : null
})

async function handleLaunch(): Promise<void> {
  const inst = primaryInstall.value
  const action = launchAction.value
  if (!inst || !action) return

  if (action.enabled === false && action.disabledMessage) {
    await modal.alert({ title: action.label, message: action.disabledMessage })
    return
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
  if (result.message) {
    await modal.alert({ title: action.label, message: result.message })
  }
}

function focusComfyWindow(): void {
  const id = primaryInstall.value?.id
  if (id) window.api.focusComfyWindow(id)
}

function stopComfyUI(): void {
  const id = primaryInstall.value?.id
  if (id) window.api.stopComfyUI(id)
}
</script>

<template>
  <div class="view active">
    <div class="toolbar">
      <div class="breadcrumb">
        <span class="breadcrumb-current">{{ $t('dashboard.title') }}</span>
      </div>
    </div>

    <div class="view-scroll">
      <!-- Welcome state: no local installations -->
      <div v-if="!primaryInstall" class="dashboard-welcome">
        <div class="dashboard-welcome-icon">
          <Download :size="48" />
        </div>
        <h1 class="dashboard-welcome-title">{{ $t('dashboard.welcome') }}</h1>
        <p class="dashboard-welcome-desc">{{ $t('dashboard.welcomeDesc') }}</p>
        <button class="primary dashboard-cta-btn" @click="emit('show-new-install')">
          <Download :size="18" />
          {{ $t('dashboard.installComfyUI') }}
        </button>
      </div>

      <!-- Primary install -->
      <div v-else class="dashboard-primary">
        <div class="dashboard-section-label">{{ $t('dashboard.primaryInstall') }}</div>
        <div class="dashboard-primary-card">
          <div class="dashboard-primary-info">
            <div class="dashboard-primary-name">{{ primaryInstall.name }}</div>
            <div class="dashboard-primary-meta">
              <span>{{ primaryInstall.sourceLabel }}</span>
              <template v-if="primaryInstall.version">
                <span> · </span>
                <span>{{ primaryInstall.version }}</span>
              </template>
              <template v-if="primaryRunning">
                <span> · </span>
                <span class="status-running">{{ $t('list.running') }}</span>
              </template>
            </div>

            <div v-if="primaryProgress" class="card-progress">
              <div class="card-progress-status">{{ primaryProgress.status }}</div>
              <div class="card-progress-track">
                <div
                  class="card-progress-fill"
                  :class="{ indeterminate: primaryProgress.percent < 0 }"
                  :style="primaryProgress.percent >= 0 ? { width: primaryProgress.percent + '%' } : { width: '100%' }"
                ></div>
              </div>
            </div>
          </div>

          <div class="dashboard-primary-actions">
            <!-- Running -->
            <template v-if="primaryRunning">
              <button
                v-if="primaryRunning.mode !== 'console'"
                class="primary dashboard-cta-btn"
                @click="focusComfyWindow()"
              >
                <ExternalLink :size="18" />
                {{ $t('running.showWindow') }}
              </button>
              <button v-if="primaryInstall.hasConsole" @click="emit('show-console', primaryInstall.id)">
                {{ $t('list.console') }}
              </button>
              <button class="danger" @click="stopComfyUI()">
                <Square :size="16" />
                {{ $t('console.stop') }}
              </button>
            </template>

            <!-- In-progress -->
            <template v-else-if="sessionStore.activeSessions.has(primaryInstall.id)">
              <button
                class="primary dashboard-cta-btn"
                @click="emit('show-progress', {
                  installationId: primaryInstall.id,
                  title: '',
                  apiCall: async () => ({}),
                })"
              >
                {{ $t('list.viewProgress') }}
              </button>
            </template>

            <!-- Idle -->
            <template v-else-if="primaryIsInstalled">
              <button
                v-if="launchAction"
                class="primary dashboard-cta-btn"
                :class="{ 'looks-disabled': launchAction.enabled === false && launchAction.disabledMessage }"
                :disabled="launchAction.enabled === false && !launchAction.disabledMessage"
                @click="handleLaunch"
              >
                <Play :size="18" />
                {{ launchAction.label }}
              </button>
            </template>

            <button @click="emit('show-detail', primaryInstall)">
              {{ $t('list.view') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
