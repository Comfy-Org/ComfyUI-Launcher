<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'

interface Props {
  installationId: string | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const sessionStore = useSessionStore()

const api = window.api
const terminalRef = ref<HTMLDivElement | null>(null)
const isAtBottom = ref(true)
const mouseDownOnOverlay = ref(false)

const session = computed(() => {
  if (!props.installationId) return undefined
  return sessionStore.getSession(props.installationId)
})

const runningInfo = computed(() => {
  if (!props.installationId) return undefined
  return sessionStore.runningInstances.get(props.installationId)
})

const errorInfo = computed(() => {
  if (!props.installationId) return undefined
  return sessionStore.errorInstances.get(props.installationId)
})

const isExited = computed(() => {
  return session.value ? session.value.exited : true
})

const title = computed(() => {
  const instName = runningInfo.value?.installationName || errorInfo.value?.installationName
  return instName ? `${t('console.title')} — ${instName}` : t('console.title')
})

const showWindowBtn = computed(() => {
  return runningInfo.value && runningInfo.value.mode !== 'console'
})

const comfyUrl = computed(() => {
  if (!runningInfo.value) return null
  return (
    runningInfo.value.url ||
    `http://127.0.0.1:${runningInfo.value.port || 8188}`
  )
})

const terminalOutput = computed(() => {
  return session.value?.output ?? ''
})

function handleTerminalScroll(): void {
  if (!terminalRef.value) return
  const el = terminalRef.value
  isAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}

watch(
  terminalOutput,
  async () => {
    if (!isAtBottom.value) return
    await nextTick()
    if (terminalRef.value) terminalRef.value.scrollTop = terminalRef.value.scrollHeight
  }
)

watch(
  () => props.installationId,
  async () => {
    isAtBottom.value = true
    await nextTick()
    if (terminalRef.value) {
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight
    }
  }
)

function handleOverlayMouseDown(event: MouseEvent): void {
  mouseDownOnOverlay.value = event.target === (event.currentTarget as HTMLElement)
}

function handleOverlayClick(event: MouseEvent): void {
  if (mouseDownOnOverlay.value && event.target === (event.currentTarget as HTMLElement)) {
    emit('close')
  }
  mouseDownOnOverlay.value = false
}
</script>

<template>
  <div
    v-if="installationId"
    class="view-modal active"
    @mousedown="handleOverlayMouseDown"
    @click="handleOverlayClick"
  >
    <div class="view-modal-content">
      <div class="view-modal-header">
        <div class="view-modal-title">{{ title }}</div>
        <div class="view-modal-header-actions">
          <button
            v-if="showWindowBtn"
            class="primary"
            @click="api.focusComfyWindow(installationId!)"
          >
            {{ $t('running.showWindow') }}
          </button>
          <button
            v-if="comfyUrl"
            @click="api.openPath(comfyUrl)"
          >
            {{ $t('console.openInBrowser') }}
          </button>
          <button
            v-if="!isExited"
            class="danger"
            @click="api.stopComfyUI(installationId!)"
          >
            {{ $t('console.stop') }}
          </button>
        </div>
        <button class="view-modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="view-modal-body">
        <div
          id="console-terminal"
          ref="terminalRef"
          class="terminal-output"
          @scroll="handleTerminalScroll"
        >{{ terminalOutput }}</div>
      </div>
    </div>
  </div>
</template>
