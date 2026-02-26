<script setup lang="ts">
import { ref, reactive, watch, nextTick } from 'vue'
import type { DetailItem, DetailField, DetailFieldOption, ActionDef } from '../types/ipc'

interface Props {
  title?: string
  description?: string
  collapsed?: boolean | null
  items?: DetailItem[]
  fields?: DetailField[]
  actions?: ActionDef[]
  installationId: string
}

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
  description: undefined,
  collapsed: null,
  items: undefined,
  fields: undefined,
  actions: undefined,
})

const emit = defineEmits<{
  'run-action': [action: ActionDef, button: HTMLButtonElement | null]
  'refresh': [sectionTitle: string]
  'refresh-all': []
}>()

const isCollapsed = ref(props.collapsed === true)
const sectionRef = ref<HTMLDivElement | null>(null)

// Track-cards draft state: local selection before committing
const draftValues = reactive<Record<string, string>>({})
const switchingTrack = ref(false)

function getDraft(f: DetailField): string {
  return draftValues[f.id] ?? String(f.value)
}

function getSelectedOption(f: DetailField): DetailFieldOption | undefined {
  const draft = getDraft(f)
  return f.options?.find((o) => o.value === draft)
}

// Reset draft when the committed value changes (e.g., after refresh)
watch(() => props.fields, () => {
  for (const f of props.fields ?? []) {
    if (f.editType === 'track-cards' && draftValues[f.id] === String(f.value)) {
      delete draftValues[f.id]
    }
  }
}, { deep: true })

async function switchTrack(field: DetailField): Promise<void> {
  const draft = draftValues[field.id]
  if (!draft || draft === String(field.value)) return
  switchingTrack.value = true
  try {
    await handleFieldChange(field, draft)
  } finally {
    switchingTrack.value = false
    delete draftValues[field.id]
  }
}

async function toggleCollapse(): Promise<void> {
  if (props.collapsed != null) {
    isCollapsed.value = !isCollapsed.value
    if (!isCollapsed.value) {
      await nextTick()
      sectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }
}

async function handleFieldChange(field: DetailField, value: string | boolean): Promise<void> {
  await window.api.updateInstallation(props.installationId, { [field.id]: value })
  if (field.refreshSection && props.title) {
    emit('refresh', props.title)
  }
  if (field.onChangeAction) {
    const result = await window.api.runAction(props.installationId, field.onChangeAction)
    if (result.navigate === 'detail') {
      emit('refresh-all')
    }
  }
}

function handleItemAction(action: ActionDef, event: MouseEvent): void {
  const button = event.currentTarget as HTMLButtonElement | null
  emit('run-action', action, button)
}

function handleAction(action: ActionDef, event: MouseEvent): void {
  const button = event.currentTarget as HTMLButtonElement | null
  emit('run-action', action, button)
}
</script>

<template>
  <div ref="sectionRef" class="detail-section" :data-section-title="title">
    <div
v-if="title" class="detail-section-title"
         :class="{ collapsible: collapsed != null }"
         :data-collapsed="isCollapsed ? 'true' : 'false'"
         @click="toggleCollapse">
      {{ title }}
    </div>
    <div v-show="!isCollapsed" class="detail-section-body">
      <div v-if="description" class="detail-section-desc">{{ description }}</div>

      <!-- Items -->
      <div v-if="items?.length" class="detail-item-list">
        <div v-for="item in items" :key="item.label" class="detail-item" :class="{ active: item.active }">
          <div class="detail-item-label">{{ item.label }}{{ item.active ? ' (active)' : '' }}</div>
          <div v-if="item.actions" class="detail-item-actions">
            <button
v-for="a in item.actions" :key="a.id"
                    :class="a.style" :disabled="a.enabled === false && !a.disabledMessage"
                    @click="handleItemAction(a, $event)">
              {{ a.label }}
            </button>
          </div>
        </div>
      </div>

      <!-- Fields -->
      <div v-if="fields?.length" class="detail-fields">
        <div v-for="f in fields" :key="f.id">
          <!-- Track cards -->
          <template v-if="f.editable && f.editType === 'track-cards'">
            <div class="detail-field-label">{{ f.label }}</div>
            <div class="track-cards-row">
              <button
                v-for="opt in f.options" :key="opt.value"
                class="track-card"
                :class="{ selected: getDraft(f) === opt.value, current: String(f.value) === opt.value }"
                @click="draftValues[f.id] = opt.value"
              >
                <div class="track-card-header">
                  <span class="track-card-label">{{ opt.label }}</span>
                  <span v-if="opt.recommended" class="track-card-badge">{{ $t('newInstall.recommended') }}</span>
                </div>
                <div v-if="opt.description" class="track-card-desc">{{ opt.description }}</div>
              </button>
            </div>
            <div v-if="getSelectedOption(f)?.data" class="track-preview">
              <div class="track-preview-row">
                <span class="track-preview-label">{{ $t('trackCards.installedVersion') }}</span>
                <span class="track-preview-value">{{ (getSelectedOption(f)!.data as Record<string, unknown>).installedVersion }}</span>
              </div>
              <div class="track-preview-row">
                <span class="track-preview-label">{{ $t('trackCards.latestVersion') }}</span>
                <span class="track-preview-value">{{ (getSelectedOption(f)!.data as Record<string, unknown>).latestVersion }}</span>
              </div>
              <div class="track-preview-row">
                <span class="track-preview-label">{{ $t('trackCards.lastChecked') }}</span>
                <span class="track-preview-value">{{ (getSelectedOption(f)!.data as Record<string, unknown>).lastChecked }}</span>
              </div>
              <div class="track-preview-row">
                <span class="track-preview-label">{{ $t('trackCards.status') }}</span>
                <span class="track-preview-value">{{ (getSelectedOption(f)!.data as Record<string, unknown>).updateAvailable ? $t('trackCards.updateAvailable') : $t('trackCards.upToDate') }}</span>
              </div>
            </div>
            <div v-else-if="getDraft(f) !== String(f.value)" class="track-preview track-preview-empty">
              {{ $t('trackCards.noInfo') }}
            </div>
            <button
              v-if="getDraft(f) !== String(f.value)"
              class="primary track-switch-btn"
              :disabled="switchingTrack"
              @click="switchTrack(f)"
            >
              {{ switchingTrack ? $t('trackCards.switching') : $t('trackCards.switchTrack') }}
            </button>
          </template>
          <template v-else>
            <div class="detail-field-label">{{ f.label }}</div>
            <!-- Select -->
            <select
v-if="f.editable && f.editType === 'select'" class="detail-field-input"
                    :value="f.value" @change="handleFieldChange(f, ($event.target as HTMLSelectElement).value)">
              <option v-for="opt in f.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
            <!-- Boolean -->
            <input
v-else-if="f.editable && f.editType === 'boolean'" type="checkbox" class="detail-field-toggle"
                   :checked="f.value !== false" @change="handleFieldChange(f, ($event.target as HTMLInputElement).checked)">
            <!-- Text editable -->
            <input
v-else-if="f.editable" type="text" class="detail-field-input"
                   :value="f.value ?? ''" @change="handleFieldChange(f, ($event.target as HTMLInputElement).value)">
            <!-- Read-only -->
            <div v-else class="detail-field-value">{{ f.value }}</div>
          </template>
        </div>
      </div>

      <!-- Actions -->
      <div v-if="actions?.length" class="detail-actions">
        <button
v-for="a in actions" :key="a.id"
                :class="[a.style, { 'looks-disabled': a.enabled === false && a.disabledMessage }]"
                :disabled="a.enabled === false && !a.disabledMessage"
                @click="handleAction(a, $event)">
          {{ a.label }}
        </button>
      </div>
    </div>
  </div>
</template>
