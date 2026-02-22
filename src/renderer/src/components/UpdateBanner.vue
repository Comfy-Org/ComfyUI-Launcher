<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useElectronApi } from '../composables/useElectronApi'
import { useModal } from '../composables/useModal'
import type { UpdateInfo, UpdateDownloadProgress } from '../types/ipc'

type UpdateState =
  | { type: 'available'; version: string }
  | { type: 'downloading'; transferred: string; total: string; percent: number }
  | { type: 'ready'; version: string }
  | { type: 'error'; message: string }

const { api, listen } = useElectronApi()
const modal = useModal()
const { t } = useI18n()

const state = ref<UpdateState | null>(null)
const visible = ref(false)

function boldify(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

const bannerMessage = computed<string>(() => {
  if (!state.value) return ''
  switch (state.value.type) {
    case 'available':
      return boldify(t('update.available', { version: state.value.version }))
    case 'downloading':
      return t('update.downloading', { progress: `${state.value.transferred} / ${state.value.total} MB (${Math.round(state.value.percent)}%)` })
    case 'ready':
      return boldify(t('update.ready', { version: state.value.version }))
    case 'error':
      return t('update.checkFailed')
    default:
      return ''
  }
})

function dismiss() {
  visible.value = false
  state.value = null
}

async function download() {
  state.value = { type: 'downloading', transferred: '0', total: '0', percent: 0 }
  await api.downloadUpdate()
}

async function install() {
  await api.installUpdate()
}

function retry() {
  state.value = null
  visible.value = false
  api.checkForUpdate()
}

async function showErrorDetails(message: string) {
  await modal.alert({
    title: t('update.updateError'),
    message,
  })
}

listen<UpdateInfo>(api.onUpdateAvailable, (info) => {
  state.value = { type: 'available', version: info.version }
  visible.value = true
})

listen<UpdateDownloadProgress>(api.onUpdateDownloadProgress, (progress) => {
  state.value = {
    type: 'downloading',
    transferred: progress.transferred,
    total: progress.total,
    percent: progress.percent,
  }
  visible.value = true
})

listen<UpdateInfo>(api.onUpdateDownloaded, (info) => {
  state.value = { type: 'ready', version: info.version }
  visible.value = true
})

listen<{ message: string }>(api.onUpdateError, (err) => {
  state.value = { type: 'error', message: err.message }
  visible.value = true
})

onMounted(async () => {
  const pending = await api.getPendingUpdate()
  if (pending) {
    state.value = { type: 'ready', version: pending.version }
    visible.value = true
  }
})
</script>

<template>
  <div v-if="visible && state" class="update-banner" :class="state.type">
    <span class="update-banner-message" v-html="bannerMessage"></span>

    <div class="update-banner-actions">
      <!-- available -->
      <template v-if="state.type === 'available'">
        <button class="primary" @click="download">{{ $t('update.download') }}</button>
        <button @click="dismiss">{{ $t('update.dismiss') }}</button>
      </template>

      <!-- downloading: no actions, just the message -->

      <!-- ready -->
      <template v-else-if="state.type === 'ready'">
        <button class="primary" @click="install">{{ $t('update.restartUpdate') }}</button>
        <button @click="dismiss">{{ $t('update.later') }}</button>
      </template>

      <!-- error -->
      <template v-else-if="state.type === 'error'">
        <button @click="showErrorDetails(state.message)">{{ $t('update.details') }}</button>
        <button @click="retry">{{ $t('update.retry') }}</button>
        <button @click="dismiss">{{ $t('update.dismiss') }}</button>
      </template>
    </div>
  </div>
</template>
