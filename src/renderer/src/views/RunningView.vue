<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import InstanceCard from '../components/InstanceCard.vue'
import type { Installation } from '../types/ipc'

const { t } = useI18n()
const sessionStore = useSessionStore()
const installationStore = useInstallationStore()

const instMap = computed(() => {
  const map = new Map<string, Installation>()
  for (const inst of installationStore.installations) {
    map.set(inst.id, inst)
  }
  return map
})

const inProgressIds = computed(() => {
  const ids: string[] = []
  sessionStore.activeSessions.forEach((_session, id) => {
    if (!sessionStore.runningInstances.has(id)) ids.push(id)
  })
  return ids
})

const needsHeaders = computed(() => {
  return (
    (sessionStore.runningInstances.size > 0 ? 1 : 0) +
    (sessionStore.errorInstances.size > 0 ? 1 : 0) +
    (inProgressIds.value.length > 0 ? 1 : 0) >
    1
  )
})

const isEmpty = computed(() => {
  return (
    sessionStore.runningInstances.size === 0 &&
    sessionStore.errorInstances.size === 0 &&
    inProgressIds.value.length === 0
  )
})

interface MetaPart {
  text: string
  class?: string
}

function getRunningMetaParts(installationId: string): MetaPart[] {
  const info = sessionStore.runningInstances.get(installationId)
  const inst = instMap.value.get(installationId)
  const parts: MetaPart[] = []
  if (inst) parts.push({ text: inst.sourceLabel })
  if (inst?.version) parts.push({ text: inst.version })
  parts.push({ text: t('list.running'), class: 'status-running' })
  if (info) {
    parts.push({ text: info.url || `http://127.0.0.1:${info.port || 8188}` })
  }
  return parts
}

function getErrorMetaParts(installationId: string): MetaPart[] {
  const errorInfo = sessionStore.errorInstances.get(installationId)
  const inst = instMap.value.get(installationId)
  const parts: MetaPart[] = [{ text: t('running.crashed'), class: 'status-danger' }]
  if (inst) parts.push({ text: inst.sourceLabel })
  const exitCode = errorInfo?.exitCode ?? 'unknown'
  parts.push({ text: t('running.exitCode', { code: exitCode }) })
  return parts
}

function getInProgressMetaParts(installationId: string): MetaPart[] {
  const session = sessionStore.activeSessions.get(installationId)
  const inst = instMap.value.get(installationId)
  const parts: MetaPart[] = []
  if (inst) parts.push({ text: inst.sourceLabel })
  if (inst?.version) parts.push({ text: inst.version })
  if (session) {
    parts.push({ text: session.label, class: 'status-in-progress' })
  }
  return parts
}

function getRunningName(installationId: string): string {
  return sessionStore.runningInstances.get(installationId)?.installationName || ''
}

function getErrorName(installationId: string): string {
  return sessionStore.errorInstances.get(installationId)?.installationName || ''
}

function getInProgressName(installationId: string): string {
  const inst = instMap.value.get(installationId)
  if (inst) return inst.name
  const session = sessionStore.activeSessions.get(installationId)
  return session?.label || ''
}

function focusComfyWindow(installationId: string): void {
  window.api.focusComfyWindow(installationId)
}

function stopComfyUI(installationId: string): void {
  window.api.stopComfyUI(installationId)
}

onMounted(() => installationStore.fetchInstallations())

const emit = defineEmits<{
  'show-detail': [inst: Installation]
  'show-console': [installationId: string]
  'show-progress': [opts: {
    installationId: string
    title: string
    apiCall: () => Promise<unknown>
    cancellable?: boolean
  }]
}>()
</script>

<template>
  <div class="view active">
    <div class="toolbar">
      <div class="breadcrumb">
        <span class="breadcrumb-current">{{ $t('running.title') }}</span>
      </div>
    </div>

    <div class="view-list-scroll">
      <!-- Empty state -->
      <div v-if="isEmpty" class="empty-state">{{ $t('running.empty') }}</div>

      <template v-else>
        <!-- Running Instances -->
        <template v-if="sessionStore.runningInstances.size > 0">
          <div v-if="needsHeaders" class="detail-section-title">
            {{ $t('running.instances') }}
          </div>
          <div class="instance-list">
            <InstanceCard
              v-for="[installationId] in sessionStore.runningInstances"
              :key="installationId"
              :name="getRunningName(installationId)"
            >
              <template #meta>
                <template v-for="(part, i) in getRunningMetaParts(installationId)" :key="i">
                  <template v-if="i > 0"> · </template>
                  <span v-if="part.class" :class="part.class">{{ part.text }}</span>
                  <template v-else>{{ part.text }}</template>
                </template>
              </template>
              <template #actions>
                <button
                  v-if="sessionStore.runningInstances.get(installationId)?.mode !== 'console'"
                  class="primary"
                  @click="focusComfyWindow(installationId)"
                >
                  {{ $t('running.showWindow') }}
                </button>
                <button
                  v-if="!instMap.get(installationId) || instMap.get(installationId)?.hasConsole"
                  @click="emit('show-console', installationId)"
                >
                  {{ $t('list.console') }}
                </button>
                <button class="danger" @click="stopComfyUI(installationId)">
                  {{ $t('console.stop') }}
                </button>
                <button
                  v-if="instMap.get(installationId)"
                  class="manage-btn"
                  @click="emit('show-detail', instMap.get(installationId)!)"
                >
                  {{ $t('list.view') }}
                </button>
              </template>
            </InstanceCard>
          </div>
        </template>

        <!-- Errors -->
        <template v-if="sessionStore.errorInstances.size > 0">
          <div
            class="detail-section-title"
            :style="sessionStore.runningInstances.size > 0 ? 'margin-top: 18px' : ''"
          >
            {{ $t('running.errors') }}
          </div>
          <div class="instance-list">
            <InstanceCard
              v-for="[installationId] in sessionStore.errorInstances"
              :key="installationId"
              :name="getErrorName(installationId)"
            >
              <template #meta>
                <template v-for="(part, i) in getErrorMetaParts(installationId)" :key="i">
                  <template v-if="i > 0"> · </template>
                  <span v-if="part.class" :class="part.class">{{ part.text }}</span>
                  <template v-else>{{ part.text }}</template>
                </template>
              </template>
              <template #actions>
                <button
                  v-if="!instMap.get(installationId) || instMap.get(installationId)?.hasConsole"
                  @click="emit('show-console', installationId)"
                >
                  {{ $t('list.console') }}
                </button>
                <button @click="sessionStore.clearErrorInstance(installationId)">
                  {{ $t('running.dismiss') }}
                </button>
                <button
                  v-if="instMap.get(installationId)"
                  class="manage-btn"
                  @click="emit('show-detail', instMap.get(installationId)!)"
                >
                  {{ $t('list.view') }}
                </button>
              </template>
            </InstanceCard>
          </div>
        </template>

        <!-- In Progress -->
        <template v-if="inProgressIds.length > 0">
          <div
            class="detail-section-title"
            :style="
              (sessionStore.runningInstances.size > 0 || sessionStore.errorInstances.size > 0)
                ? 'margin-top: 18px'
                : ''
            "
          >
            {{ $t('running.inProgress') }}
          </div>
          <div class="instance-list">
            <InstanceCard
              v-for="installationId in inProgressIds"
              :key="installationId"
              :name="getInProgressName(installationId)"
            >
              <template #meta>
                <template v-for="(part, i) in getInProgressMetaParts(installationId)" :key="i">
                  <template v-if="i > 0"> · </template>
                  <span v-if="part.class" :class="part.class">{{ part.text }}</span>
                  <template v-else>{{ part.text }}</template>
                </template>
              </template>
              <template #actions>
                <button
                  class="primary"
                  @click="emit('show-progress', {
                    installationId,
                    title: '',
                    apiCall: async () => ({}),
                  })"
                >
                  {{ $t('list.viewProgress') }}
                </button>
                <button
                  v-if="instMap.get(installationId)"
                  class="manage-btn"
                  @click="emit('show-detail', instMap.get(installationId)!)"
                >
                  {{ $t('list.view') }}
                </button>
              </template>
            </InstanceCard>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>
