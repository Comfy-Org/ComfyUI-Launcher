<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useDownloadStore } from '../stores/downloadStore'
import type { ModelDownloadProgress } from '../types/ipc'

const { t } = useI18n()
const downloadStore = useDownloadStore()

function fmtBytes(b: number): string {
  if (!b || b <= 0) return ''
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'
  return (b / 1073741824).toFixed(2) + ' GB'
}

function fmtSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1048576) return (bytesPerSec / 1024).toFixed(0) + ' KB/s'
  return (bytesPerSec / 1048576).toFixed(1) + ' MB/s'
}

function fmtEta(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.ceil((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

function statusLabel(d: ModelDownloadProgress): string {
  const pct = Math.round(d.progress * 100)
  switch (d.status) {
    case 'pending':
      return t('downloads.pending')
    case 'downloading': {
      const parts: string[] = []
      if (d.totalBytes && d.totalBytes > 0 && d.receivedBytes != null) {
        parts.push(`${fmtBytes(d.receivedBytes)} / ${fmtBytes(d.totalBytes)}`)
      }
      parts.push(`${pct}%`)
      if (d.speedBytesPerSec && d.speedBytesPerSec > 0) {
        parts.push(fmtSpeed(d.speedBytesPerSec))
      }
      if (d.etaSeconds != null && d.etaSeconds > 0 && isFinite(d.etaSeconds)) {
        parts.push(fmtEta(d.etaSeconds))
      }
      return parts.join(' · ')
    }
    case 'paused': {
      const parts: string[] = [t('downloads.paused', { percent: pct })]
      if (d.totalBytes && d.totalBytes > 0 && d.receivedBytes != null) {
        parts.push(`${fmtBytes(d.receivedBytes)} / ${fmtBytes(d.totalBytes)}`)
      }
      return parts.join(' · ')
    }
    case 'completed':
      return t('downloads.completed')
    case 'error':
      return d.error || t('downloads.error')
    case 'cancelled':
      return t('downloads.cancelled')
    default:
      return ''
  }
}

function statusClass(d: ModelDownloadProgress): string {
  switch (d.status) {
    case 'downloading':
    case 'pending':
      return 'status-running'
    case 'paused':
      return 'status-update'
    case 'completed':
      return ''
    case 'error':
      return 'status-danger'
    default:
      return ''
  }
}

function barClass(d: ModelDownloadProgress): string {
  switch (d.status) {
    case 'paused':
      return 'dl-bar-paused'
    case 'error':
      return 'dl-bar-error'
    case 'completed':
      return 'dl-bar-success'
    default:
      return ''
  }
}

function fileLabel(d: ModelDownloadProgress): string {
  const dir = d.directory || ''
  return dir ? `${dir} / ${d.filename}` : d.filename
}

function pause(url: string): void {
  window.api.pauseModelDownload(url)
}

function resume(url: string): void {
  window.api.resumeModelDownload(url)
}

function cancel(url: string): void {
  window.api.cancelModelDownload(url)
}

function dismiss(url: string): void {
  downloadStore.dismiss(url)
}
</script>

<template>
  <div v-if="downloadStore.hasDownloads">
    <div class="detail-section-title" style="margin-top: 18px">
      {{ t('downloads.title') }}
    </div>
    <div class="instance-list">
      <!-- Active downloads -->
      <div
        v-for="d in downloadStore.activeDownloads"
        :key="d.url"
        class="instance-card dl-card"
      >
        <div class="instance-info">
          <div class="instance-name dl-filename" :title="d.filename">
            {{ fileLabel(d) }}
          </div>
          <div class="instance-meta">
            <span :class="statusClass(d)">{{ statusLabel(d) }}</span>
          </div>
          <div class="card-progress">
            <div class="card-progress-track">
              <div
                class="card-progress-fill"
                :class="[barClass(d), { indeterminate: d.status === 'pending' }]"
                :style="d.status !== 'pending' ? { width: Math.round(d.progress * 100) + '%' } : { width: '100%' }"
              />
            </div>
          </div>
        </div>
        <div class="instance-actions">
          <button
            v-if="d.status === 'downloading'"
            @click="pause(d.url)"
          >
            {{ t('downloads.pause') }}
          </button>
          <button
            v-if="d.status === 'paused'"
            class="primary"
            @click="resume(d.url)"
          >
            {{ t('downloads.resume') }}
          </button>
          <button
            v-if="d.status !== 'completed'"
            class="danger"
            @click="cancel(d.url)"
          >
            {{ t('downloads.cancel') }}
          </button>
        </div>
      </div>

      <!-- Finished downloads -->
      <div
        v-for="d in downloadStore.finishedDownloads"
        :key="d.url"
        class="instance-card dl-card"
      >
        <div class="instance-info">
          <div class="instance-name dl-filename" :title="d.filename">
            {{ fileLabel(d) }}
          </div>
          <div class="instance-meta">
            <span :class="statusClass(d)">{{ statusLabel(d) }}</span>
          </div>
        </div>
        <div class="instance-actions">
          <button @click="dismiss(d.url)">
            {{ t('downloads.dismiss') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dl-filename {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dl-card .card-progress {
  margin-top: 6px;
}
.dl-bar-paused {
  background: var(--warning) !important;
}
.dl-bar-error {
  background: var(--danger) !important;
}
.dl-bar-success {
  background: var(--success) !important;
}
</style>
