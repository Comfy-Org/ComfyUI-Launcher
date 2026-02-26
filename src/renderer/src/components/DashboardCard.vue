<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import { Play, ExternalLink, Square } from 'lucide-vue-next'
import type { Installation, ListAction } from '../types/ipc'

const props = defineProps<{
  installation: Installation
  actions: ListAction[]
}>()

const emit = defineEmits<{
  launch: [inst: Installation, actions: ListAction[]]
  'show-detail': [inst: Installation]
  'show-console': [installationId: string]
  'show-progress': [opts: {
    installationId: string
    title: string
    apiCall: () => Promise<unknown>
    cancellable?: boolean
  }]
}>()

const sessionStore = useSessionStore()
const progressStore = useProgressStore()

const running = computed(() =>
  sessionStore.runningInstances.get(props.installation.id) ?? null
)

const progress = computed(() =>
  progressStore.getProgressInfo(props.installation.id)
)

const launchAction = computed(() =>
  props.actions.find((a) => a.style === 'primary') ?? props.actions[0] ?? null
)

const isInstalled = computed(() => props.installation.status === 'installed')

function focusComfyWindow(): void {
  window.api.focusComfyWindow(props.installation.id)
}

function stopComfyUI(): void {
  window.api.stopComfyUI(props.installation.id)
}
</script>

<template>
  <div class="dashboard-card-info">
    <div class="dashboard-card-name">{{ installation.name }}</div>
    <div class="dashboard-card-meta">
      <span>{{ installation.listPreview || installation.sourceLabel }}</span>
      <template v-if="installation.version && !installation.listPreview">
        <span> · </span>
        <span>{{ installation.version }}</span>
      </template>
      <template v-if="running">
        <span> · </span>
        <span class="status-running">{{ $t('list.running') }}</span>
      </template>
    </div>
    <slot name="detail" />

    <div v-if="progress" class="card-progress">
      <div class="card-progress-status">{{ progress.status }}</div>
      <div class="card-progress-track">
        <div
          class="card-progress-fill"
          :class="{ indeterminate: progress.percent < 0 }"
          :style="progress.percent >= 0 ? { width: progress.percent + '%' } : { width: '100%' }"
        ></div>
      </div>
    </div>
  </div>

  <div class="dashboard-card-actions">
    <!-- Running -->
    <template v-if="running">
      <button
        v-if="running.mode !== 'console'"
        class="primary dashboard-cta-btn"
        @click="focusComfyWindow()"
      >
        <ExternalLink :size="18" />
        {{ $t('running.showWindow') }}
      </button>
      <button v-if="installation.hasConsole" @click="emit('show-console', installation.id)">
        {{ $t('list.console') }}
      </button>
      <button class="danger" @click="stopComfyUI()">
        <Square :size="16" />
        {{ $t('console.stop') }}
      </button>
    </template>

    <!-- In-progress -->
    <template v-else-if="sessionStore.activeSessions.has(installation.id)">
      <button
        class="primary dashboard-cta-btn"
        @click="emit('show-progress', {
          installationId: installation.id,
          title: '',
          apiCall: async () => ({}),
        })"
      >
        {{ $t('list.viewProgress') }}
      </button>
    </template>

    <!-- Idle -->
    <template v-else-if="isInstalled">
      <button
        v-if="launchAction"
        class="primary dashboard-cta-btn"
        :class="{ 'looks-disabled': launchAction.enabled === false && launchAction.disabledMessage }"
        :disabled="launchAction.enabled === false && !launchAction.disabledMessage"
        @click="emit('launch', installation, actions)"
      >
        <Play :size="18" />
        {{ launchAction.label }}
      </button>
    </template>

    <button @click="emit('show-detail', installation)">
      {{ $t('list.view') }}
    </button>
  </div>
</template>
