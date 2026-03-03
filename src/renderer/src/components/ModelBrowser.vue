<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Search, FolderOpen, File, ExternalLink } from 'lucide-vue-next'
import type { ModelFileInfo } from '../types/ipc'

const { t } = useI18n()

const folders = ref<string[]>([])
const selectedFolder = ref('')
const files = ref<ModelFileInfo[]>([])
const searchQuery = ref('')
const loading = ref(false)

const filteredFiles = computed(() => {
  if (!searchQuery.value) return files.value
  const q = searchQuery.value.toLowerCase()
  return files.value.filter((f) => f.name.toLowerCase().includes(q))
})

function fmtSize(bytes: number): string {
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB'
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'
  return (bytes / 1073741824).toFixed(2) + ' GB'
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

async function loadFolders(): Promise<void> {
  folders.value = await window.api.getModelFolders()
  if (folders.value.length > 0 && !selectedFolder.value) {
    selectedFolder.value = folders.value[0]!
  }
}

async function loadFiles(): Promise<void> {
  if (!selectedFolder.value) return
  loading.value = true
  try {
    files.value = await window.api.getModelFiles(selectedFolder.value)
  } finally {
    loading.value = false
  }
}

function showInFolder(file: ModelFileInfo): void {
  window.api.showDownloadInFolder(file.fullPath)
}

watch(selectedFolder, () => loadFiles())

onMounted(async () => {
  await loadFolders()
  await loadFiles()
})

defineExpose({ refresh: loadFiles })
</script>

<template>
  <div class="model-browser">
    <div class="model-browser-sidebar">
      <div class="model-browser-sidebar-title">{{ t('models.folderTypes') }}</div>
      <button
        v-for="folder in folders"
        :key="folder"
        class="model-browser-folder-item"
        :class="{ active: selectedFolder === folder }"
        @click="selectedFolder = folder"
      >
        <FolderOpen :size="14" style="flex-shrink: 0" />
        <span>{{ folder }}</span>
      </button>
    </div>
    <div class="model-browser-main">
      <div class="model-browser-search">
        <Search :size="16" class="model-browser-search-icon" />
        <input
          v-model="searchQuery"
          type="text"
          :placeholder="t('models.searchPlaceholder')"
          class="model-browser-search-input"
        />
      </div>
      <div class="model-browser-list">
        <div v-if="loading" class="model-browser-empty">{{ t('common.loading') }}</div>
        <div v-else-if="filteredFiles.length === 0" class="model-browser-empty">
          {{ t('models.noFiles') }}
        </div>
        <div
          v-for="file in filteredFiles"
          :key="file.name"
          class="model-file-card"
        >
          <div class="model-file-info">
            <File :size="14" style="flex-shrink: 0; opacity: 0.5" />
            <div class="model-file-details">
              <div class="model-file-name" :title="file.name">{{ file.name }}</div>
              <div class="model-file-meta">
                {{ fmtSize(file.sizeBytes) }} · {{ fmtDate(file.modifiedAt) }}
              </div>
            </div>
          </div>
          <button
            class="model-file-action"
            :title="t('models.openFolder')"
            @click="showInFolder(file)"
          >
            <ExternalLink :size="14" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-browser {
  display: flex;
  height: 100%;
  min-height: 300px;
  gap: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg);
}
.model-browser-sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 12px 0;
  overflow-y: auto;
}
.model-browser-sidebar-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 4px 14px 8px;
}
.model-browser-folder-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 14px;
  border: none;
  border-radius: 0;
  background: none;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.model-browser-folder-item:hover {
  background: var(--border);
  color: var(--text);
}
.model-browser-folder-item.active {
  background: var(--border);
  color: var(--text);
  font-weight: 600;
}
.model-browser-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.model-browser-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.model-browser-search-icon {
  color: var(--text-faint);
  flex-shrink: 0;
}
.model-browser-search-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 14px;
}
.model-browser-search-input::placeholder {
  color: var(--text-faint);
}
.model-browser-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.model-browser-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 14px;
}
.model-file-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 6px;
  gap: 8px;
}
.model-file-card:hover {
  background: var(--surface);
}
.model-file-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.model-file-details {
  min-width: 0;
  flex: 1;
}
.model-file-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-file-meta {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}
.model-file-action {
  flex-shrink: 0;
  background: none;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-faint);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
}
.model-file-action:hover {
  color: var(--text);
  border-color: var(--border);
  background: none;
}
</style>
