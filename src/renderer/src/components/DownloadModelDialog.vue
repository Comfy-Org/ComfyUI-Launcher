<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Download, X } from 'lucide-vue-next'

const { t } = useI18n()

const open = defineModel<boolean>({ default: false })

const url = ref('')
const filename = ref('')
const directory = ref('')
const folders = ref<string[]>([])
const submitting = ref(false)
const error = ref('')

function extractFilename(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    const segments = parsed.pathname.split('/')
    const last = segments[segments.length - 1] || ''
    const clean = last.split('?')[0] || ''
    if (clean) return decodeURIComponent(clean)
  } catch {}
  return ''
}

watch(url, (newUrl) => {
  if (newUrl && !filename.value) {
    filename.value = extractFilename(newUrl)
  }
})

const canSubmit = computed(() => {
  return url.value.trim() && filename.value.trim() && directory.value && !submitting.value
})

function formatFolderLabel(folder: string): string {
  return folder.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

async function handleSubmit(): Promise<void> {
  if (!canSubmit.value) return
  error.value = ''
  submitting.value = true
  try {
    const ok = await window.api.startModelDownload(url.value.trim(), filename.value.trim(), directory.value)
    if (ok) {
      url.value = ''
      filename.value = ''
      open.value = false
    } else {
      error.value = t('downloads.downloadFailed')
    }
  } catch (e) {
    error.value = (e as Error).message || t('downloads.downloadFailed')
  } finally {
    submitting.value = false
  }
}

function handleClose(): void {
  open.value = false
  error.value = ''
}

onMounted(async () => {
  folders.value = await window.api.getModelFolders()
  if (folders.value.length > 0 && !directory.value) {
    directory.value = folders.value[0]!
  }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-overlay" @click.self="handleClose">
      <div class="modal-box" style="max-width: 520px; padding: 0;">
        <div class="modal-header">
          <span class="modal-title" style="margin-bottom: 0;">{{ t('downloads.downloadModel') }}</span>
          <button class="detail-header-btn" @click="handleClose">
            <X :size="16" />
          </button>
        </div>
        <div class="modal-body" style="display: flex; flex-direction: column; gap: 14px;">
          <div class="field" style="margin-bottom: 0;">
            <label>{{ t('downloads.urlLabel') }}</label>
            <input
              v-model="url"
              type="text"
              :placeholder="t('downloads.urlPlaceholder')"
              class="field-input"
              @keydown.enter="handleSubmit"
            />
          </div>
          <div class="field" style="margin-bottom: 0;">
            <label>{{ t('downloads.filenameLabel') }}</label>
            <input
              v-model="filename"
              type="text"
              :placeholder="t('downloads.filenamePlaceholder')"
              class="field-input"
            />
          </div>
          <div class="field" style="margin-bottom: 0;">
            <label>{{ t('downloads.directoryLabel') }}</label>
            <select v-model="directory" class="field-input">
              <option v-for="folder in folders" :key="folder" :value="folder">
                {{ formatFolderLabel(folder) }}
              </option>
            </select>
          </div>
          <div v-if="error" class="field-error">{{ error }}</div>
        </div>
        <div class="modal-footer">
          <button @click="handleClose">{{ t('common.cancel') }}</button>
          <button class="primary" :disabled="!canSubmit" @click="handleSubmit">
            <Download :size="14" style="vertical-align: -2px; margin-right: 4px;" />
            {{ t('downloads.startDownload') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
