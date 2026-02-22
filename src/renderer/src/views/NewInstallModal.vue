<script setup lang="ts">
import { ref, onMounted, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import type { Source, SourceField, FieldOption } from '../types/ipc'

const emit = defineEmits<{
  close: []
  'show-progress': [
    opts: {
      installationId: string
      title: string
      apiCall: () => Promise<unknown>
      cancellable?: boolean
      returnTo?: string
    }
  ]
  'navigate-list': []
}>()

const { t } = useI18n()
const modal = useModal()

const sources = ref<Source[]>([])
const currentSource = ref<Source | null>(null)
const selections = ref<Record<string, FieldOption>>({})
const instName = ref('')
const instPath = ref('')
const detectedGpu = ref('')
const saveDisabled = ref(true)

// Per-field state
const fieldOptions = ref(new Map<string, FieldOption[]>())
const fieldLoading = ref(new Map<string, boolean>())
const fieldErrors = ref(new Map<string, string>())
const textFieldValues = ref(new Map<string, string>())

/** Deep-strip Vue reactive proxies for safe IPC serialization */
function rawSelections(): Record<string, FieldOption> {
  const raw = toRaw(selections.value)
  const result: Record<string, FieldOption> = {}
  for (const [key, val] of Object.entries(raw)) {
    result[key] = JSON.parse(JSON.stringify(toRaw(val))) as FieldOption
  }
  return result
}

let gpuPromise: Promise<string> | null = null
let installDirPromise: Promise<string> | null = null

onMounted(() => {
  gpuPromise = window.api
    .detectGPU()
    .then((gpu) => {
      if (gpu) {
        detectedGpu.value = t('newInstall.detectedGpu', { label: gpu.label })
      } else {
        detectedGpu.value = t('newInstall.noGpuDetected')
      }
      return detectedGpu.value
    })
    .catch(() => {
      detectedGpu.value = t('newInstall.noGpuDetected')
      return detectedGpu.value
    })

  installDirPromise = window.api.getDefaultInstallDir().catch(() => '')
})

async function open(): Promise<void> {
  instName.value = ''
  selections.value = {}
  saveDisabled.value = true

  detectedGpu.value = t('newInstall.detectingGpu')
  if (gpuPromise) await gpuPromise

  instPath.value = (await installDirPromise) ?? ''

  await initSources()
}

async function initSources(): Promise<void> {
  if (sources.value.length > 0) {
    const first = sources.value[0]
    if (first) await selectSource(first)
    return
  }
  sources.value = await window.api.getSources()
  const first = sources.value[0]
  if (first) await selectSource(first)
}

async function selectSource(source: Source): Promise<void> {
  currentSource.value = source
  selections.value = {}
  fieldOptions.value.clear()
  fieldLoading.value.clear()
  fieldErrors.value.clear()
  textFieldValues.value.clear()
  saveDisabled.value = true

  // Initialize text fields with defaults
  for (const f of source.fields) {
    if (f.type === 'text') {
      const defaultVal = f.defaultValue ?? ''
      textFieldValues.value.set(f.id, defaultVal)
      if (f.defaultValue !== undefined) {
        selections.value[f.id] = { value: f.defaultValue, label: f.defaultValue }
      }
    }
  }

  // Start loading from the first loadable (non-text) field
  const firstLoadable = source.fields.findIndex((f) => f.type !== 'text')
  if (firstLoadable >= 0) {
    await loadFieldOptions(firstLoadable)
  }

  // Sources with only text fields and skipInstall can be saved immediately
  if (source.skipInstall && source.fields.every((f) => f.type === 'text')) {
    saveDisabled.value = false
  }
}

async function handleSourceChange(event: Event): Promise<void> {
  const idx = parseInt((event.target as HTMLSelectElement).value, 10)
  const source = sources.value[idx]
  if (source) await selectSource(source)
}

async function loadFieldOptions(fieldIndex: number): Promise<void> {
  const source = currentSource.value
  if (!source) return
  const field = source.fields[fieldIndex]
  if (!field) return

  fieldLoading.value.set(field.id, true)
  fieldOptions.value.delete(field.id)
  saveDisabled.value = true

  // Clear downstream select fields
  for (let i = fieldIndex + 1; i < source.fields.length; i++) {
    const df = source.fields[i]
    if (!df || df.type === 'text') continue
    fieldOptions.value.delete(df.id)
    fieldLoading.value.set(df.id, false)
    delete selections.value[df.id]
  }

  // Clear any previous error on the error target field
  const clearTarget =
    field.errorTarget ||
    (() => {
      for (let i = fieldIndex - 1; i >= 0; i--) {
        const sf = source.fields[i]
        if (sf?.type === 'text') return sf.id
      }
      return null
    })()
  if (clearTarget) {
    fieldErrors.value.delete(clearTarget)
  }

  try {
    const options = await window.api.getFieldOptions(
      source.id,
      field.id,
      rawSelections()
    )
    fieldLoading.value.set(field.id, false)

    if (options.length === 0) {
      fieldOptions.value.set(field.id, [])
      return
    }

    fieldOptions.value.set(field.id, options)

    let defaultIndex = options.findIndex((opt) => opt.recommended)
    if (defaultIndex < 0) defaultIndex = 0
    const defaultOption = options[defaultIndex]
    if (defaultOption) selections.value[field.id] = defaultOption

    // Load next select field
    const nextSelect = source.fields.findIndex(
      (f, i) => i > fieldIndex && f.type !== 'text'
    )
    if (nextSelect >= 0) {
      await loadFieldOptions(nextSelect)
    } else {
      saveDisabled.value = false
    }
  } catch (err: unknown) {
    fieldLoading.value.set(field.id, false)
    const errMsg = (err as Error).message || String(err)

    // Show error on the declared errorTarget, or fall back to preceding text field
    let errorFieldId = field.errorTarget
    if (!errorFieldId) {
      for (let i = fieldIndex - 1; i >= 0; i--) {
        const sf = source.fields[i]
        if (sf?.type === 'text') {
          errorFieldId = sf.id
          break
        }
      }
    }
    if (errorFieldId) {
      fieldErrors.value.set(errorFieldId, errMsg)
    } else {
      fieldErrors.value.set(field.id, errMsg)
    }
  }
}

function handleFieldSelectChange(field: SourceField, fieldIndex: number, value: string): void {
  const source = currentSource.value
  if (!source) return
  const options = fieldOptions.value.get(field.id)
  if (!options) return

  const idx = parseInt(value, 10)
  const selected = options[idx]
  if (selected) selections.value[field.id] = selected

  const nextSelect = source.fields.findIndex(
    (f, i) => i > fieldIndex && f.type !== 'text'
  )
  if (nextSelect >= 0) {
    loadFieldOptions(nextSelect)
  } else {
    saveDisabled.value = false
  }
}

function handleTextAction(field: SourceField): void {
  const source = currentSource.value
  if (!source) return
  const value = textFieldValues.value.get(field.id) ?? ''

  fieldErrors.value.delete(field.id)
  selections.value[field.id] = { value, label: value }

  const fieldIndex = source.fields.findIndex((f) => f.id === field.id)
  const nextLoadable = source.fields.findIndex(
    (f, i) => i > fieldIndex && f.type !== 'text'
  )
  if (nextLoadable >= 0) {
    loadFieldOptions(nextLoadable)
  }
}

async function handleBrowse(): Promise<void> {
  const chosen = await window.api.browseFolder(instPath.value)
  if (chosen) instPath.value = chosen
}

async function handleSave(): Promise<void> {
  const source = currentSource.value
  if (!source) return

  // Sync text field values into selections before building
  for (const f of source.fields) {
    if (f.type === 'text') {
      const value = textFieldValues.value.get(f.id) ?? ''
      selections.value[f.id] = { value, label: value }
    }
  }

  const instData = await window.api.buildInstallation(source.id, rawSelections())
  const name =
    instName.value.trim() ||
    `ComfyUI (${(instData as Record<string, unknown>).version || source.label})`

  if (source.skipInstall) {
    const result = await window.api.addInstallation({
      name,
      installPath: '',
      status: 'installed',
      ...instData
    })
    if (!result.ok) {
      await modal.alert({
        title: t('errors.cannotAdd'),
        message: result.message || ''
      })
      return
    }
    emit('close')
    emit('navigate-list')
    return
  }

  const result = await window.api.addInstallation({
    name,
    installPath: instPath.value,
    ...instData
  })
  if (!result.ok) {
    await modal.alert({
      title: t('errors.cannotAdd'),
      message: result.message || ''
    })
    return
  }
  emit('close')
  if (result.entry) {
    emit('show-progress', {
      installationId: result.entry.id,
      title: t('newInstall.installing'),
      apiCall: () => window.api.installInstance(result.entry!.id)
    })
  }
}

function getSelectedIndex(field: SourceField): number {
  const options = fieldOptions.value.get(field.id)
  if (!options) return 0
  const sel = selections.value[field.id]
  if (!sel) return 0
  const idx = options.findIndex((o) => o.value === sel.value)
  return idx >= 0 ? idx : 0
}

function handleOverlayMouseDown(event: MouseEvent): void {
  mouseDownOnOverlay.value = event.target === (event.currentTarget as HTMLElement)
}

const mouseDownOnOverlay = ref(false)

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
        <div class="view-modal-title">{{ $t('newInstall.title') }}</div>
        <button class="view-modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="view-modal-body">
        <div class="view-scroll">
          <!-- Installation name -->
          <div class="field">
            <label for="inst-name">{{ $t('common.name') }}</label>
            <input
              id="inst-name"
              type="text"
              v-model="instName"
              :placeholder="$t('common.namePlaceholder')"
            />
          </div>

          <!-- Source select -->
          <div class="field">
            <label for="source">{{ $t('newInstall.installMethod') }}</label>
            <select
              id="source"
              :disabled="sources.length <= 1"
              @change="handleSourceChange"
            >
              <option
                v-for="(s, i) in sources"
                :key="s.id"
                :value="i"
              >
                {{ s.label }}
              </option>
            </select>
          </div>

          <!-- Detected GPU -->
          <div class="detected-hardware">{{ detectedGpu }}</div>

          <!-- Dynamic source fields -->
          <div v-if="currentSource" id="source-fields">
            <div
              v-for="(field, fieldIndex) in currentSource.fields"
              :key="field.id"
              class="field"
            >
              <label :for="`sf-${field.id}`">{{ field.label }}</label>

              <!-- Text field -->
              <template v-if="field.type === 'text'">
                <div class="path-input">
                  <input
                    type="text"
                    :id="`sf-${field.id}`"
                    :value="textFieldValues.get(field.id) ?? ''"
                    :placeholder="field.defaultValue || ''"
                    @input="textFieldValues.set(field.id, ($event.target as HTMLInputElement).value)"
                  />
                  <button
                    v-if="field.action"
                    type="button"
                    :id="`sf-${field.id}-action`"
                    @click="handleTextAction(field)"
                  >
                    {{ field.action.label }}
                  </button>
                </div>
                <div
                  v-if="fieldErrors.get(field.id)"
                  class="field-error"
                >
                  {{ fieldErrors.get(field.id) }}
                </div>
              </template>

              <!-- Select field -->
              <template v-else>
                <select
                  :id="`sf-${field.id}`"
                  :disabled="
                    fieldLoading.get(field.id) ||
                    !fieldOptions.has(field.id) ||
                    fieldOptions.get(field.id)?.length === 0
                  "
                  :value="getSelectedIndex(field)"
                  @change="
                    handleFieldSelectChange(
                      field,
                      fieldIndex,
                      ($event.target as HTMLSelectElement).value
                    )
                  "
                >
                  <option v-if="fieldLoading.get(field.id)">
                    {{ $t('newInstall.loading') }}
                  </option>
                  <option
                    v-else-if="
                      !fieldOptions.has(field.id) ||
                      fieldOptions.get(field.id)?.length === 0
                    "
                  >
                    {{
                      fieldErrors.get(field.id)
                        ? `Error: ${fieldErrors.get(field.id)}`
                        : fieldOptions.has(field.id)
                          ? $t('newInstall.noOptions')
                          : '—'
                    }}
                  </option>
                  <option
                    v-else
                    v-for="(opt, i) in fieldOptions.get(field.id)"
                    :key="opt.value"
                    :value="i"
                  >
                    {{ opt.label }}
                  </option>
                </select>
              </template>
            </div>
          </div>

          <!-- Install path -->
          <div
            v-if="!currentSource?.hideInstallPath"
            class="field"
          >
            <label for="inst-path">{{ $t('newInstall.installLocation') }}</label>
            <div class="path-input">
              <input
                id="inst-path"
                type="text"
                v-model="instPath"
              />
              <button @click="handleBrowse">{{ $t('common.browse') }}</button>
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
            {{ $t('newInstall.addInstallation') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
