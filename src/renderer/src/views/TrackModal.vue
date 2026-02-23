<script setup lang="ts">
import { ref, computed, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import type { ProbeResult } from '../types/ipc'

const emit = defineEmits<{
  close: []
  'navigate-list': []
}>()

const { t } = useI18n()
const modal = useModal()

const trackPath = ref('')
const trackName = ref('')
const probeResults = ref<ProbeResult[]>([])
const selectedProbe = ref<ProbeResult | null>(null)
const probing = ref(false)
const mouseDownOnOverlay = ref(false)

const saveDisabled = computed(() => !trackPath.value || !selectedProbe.value)

function open(): void {
  trackPath.value = ''
  trackName.value = ''
  probeResults.value = []
  selectedProbe.value = null
}

async function handleBrowse(): Promise<void> {
  const dir = await window.api.browseFolder(trackPath.value || undefined)
  if (dir) {
    trackPath.value = dir
    await probe(dir)
  }
}

async function probe(dirPath: string): Promise<void> {
  probing.value = true
  selectedProbe.value = null
  probeResults.value = []

  try {
    probeResults.value = await window.api.probeInstallation(dirPath)
  } finally {
    probing.value = false
  }

  if (probeResults.value.length > 0) {
    selectedProbe.value = probeResults.value[0] ?? null
  }
}

function handleSourceChange(event: Event): void {
  const idx = parseInt((event.target as HTMLSelectElement).value, 10)
  selectedProbe.value = probeResults.value[idx] ?? null
}

interface DetailFieldEntry {
  label: string
  value: string
}

const detailFields = computed<DetailFieldEntry[]>(() => {
  if (!selectedProbe.value) return []
  const p = selectedProbe.value
  const fields: DetailFieldEntry[] = []
  if (p.version && p.version !== 'unknown') {
    fields.push({ label: t('track.version'), value: p.version })
  }
  if (p.repo) {
    fields.push({ label: t('track.repository'), value: p.repo })
  }
  if (p.branch) {
    fields.push({ label: t('track.branch'), value: p.branch })
  }
  return fields
})

async function handleSave(): Promise<void> {
  if (!selectedProbe.value) return

  const name =
    trackName.value.trim() ||
    `ComfyUI (${selectedProbe.value.sourceLabel})`

  const rawProbe = JSON.parse(JSON.stringify(toRaw(selectedProbe.value))) as Record<string, unknown>
  const data: Record<string, unknown> = {
    name,
    installPath: trackPath.value,
    ...rawProbe
  }

  const result = await window.api.trackInstallation(data)
  if (!result.ok) {
    await modal.alert({
      title: t('track.cannotTrack'),
      message: result.message || ''
    })
    return
  }
  emit('close')
  emit('navigate-list')
}

function handleOverlayMouseDown(event: MouseEvent): void {
  mouseDownOnOverlay.value = event.target === (event.currentTarget as HTMLElement)
}

function handleOverlayClick(event: MouseEvent): void {
  if (mouseDownOnOverlay.value && event.target === (event.currentTarget as HTMLElement)) {
    emit('close')
  }
  mouseDownOnOverlay.value = false
}

defineExpose({ open })
</script>

<template>
  <div
    class="view-modal active"
    @mousedown="handleOverlayMouseDown"
    @click="handleOverlayClick"
  >
    <div class="view-modal-content">
      <div class="view-modal-header">
        <div class="view-modal-title">{{ $t('track.title') }}</div>
        <button class="view-modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="view-modal-body">
        <div class="view-scroll">
          <!-- Track path -->
          <div class="field">
            <label for="track-path">{{ $t('track.installDir') }}</label>
            <div class="path-input">
              <input
                id="track-path"
                v-model="trackPath"
                type="text"
                :placeholder="$t('track.selectDir')"
              />
              <button @click="handleBrowse">{{ $t('common.browse') }}</button>
            </div>
          </div>

          <!-- Installation name -->
          <div class="field">
            <label for="track-name">{{ $t('common.name') }}</label>
            <input
              id="track-name"
              v-model="trackName"
              type="text"
              :placeholder="$t('common.namePlaceholder')"
            />
          </div>

          <!-- Detected type -->
          <div class="field">
            <label for="track-source">{{ $t('track.detectedType') }}</label>
            <select
              id="track-source"
              :disabled="probeResults.length <= 1"
              @change="handleSourceChange"
            >
              <option v-if="probing">{{ $t('track.detecting') }}</option>
              <option v-else-if="probeResults.length === 0">
                {{
                  trackPath
                    ? $t('track.noDetected')
                    : $t('track.browseDirFirst')
                }}
              </option>
              <template v-else>
                <option
                  v-for="(r, i) in probeResults"
                  :key="i"
                  :value="i"
                >
                  {{ r.sourceLabel }}
                </option>
              </template>
            </select>
          </div>

          <!-- Probe detail fields -->
          <div v-if="detailFields.length > 0" class="detail-fields">
            <div v-for="field in detailFields" :key="field.label">
              <div class="detail-field-label">{{ field.label }}</div>
              <div class="detail-field-value">{{ field.value }}</div>
            </div>
          </div>
        </div>

        <!-- Save button -->
        <div class="view-bottom">
          <button
            class="primary"
            :disabled="saveDisabled"
            @click="handleSave"
          >
            {{ $t('track.trackInstallation') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
