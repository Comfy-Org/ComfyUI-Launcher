<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingField from '../components/SettingField.vue'
import { useModal } from '../composables/useModal'
import type { SettingsSection, SettingsAction } from '../types/ipc'

const { t } = useI18n()
const modal = useModal()

function openUrl(url: string): void {
  window.api.openExternal(url)
}

const sections = ref<SettingsSection[]>([])
const checkingForUpdates = ref(false)
const systemManaged = ref(false)

async function loadSettings(): Promise<void> {
  sections.value = await window.api.getSettingsSections()
  const caps = await window.api.getUpdateCapabilities()
  systemManaged.value = caps.systemManaged
}

async function handleAction(action: SettingsAction): Promise<void> {
  if (action.url) {
    openUrl(action.url)
    return
  }
  if (action.action === 'check-for-update') {
    checkingForUpdates.value = true
    try {
      const result = await window.api.checkForUpdate()
      if (!result.available && !result.error) {
        const message = systemManaged.value ? t('update.debUpToDate') : t('update.upToDate')
        await modal.alert({ title: t('update.updateCheck'), message })
      } else if (result.error) {
        await modal.alert({ title: t('update.updateError'), message: result.error })
      }
    } finally {
      checkingForUpdates.value = false
    }
  }
}

onMounted(() => loadSettings())

defineExpose({ loadSettings })
</script>

<template>
  <div class="view active">
    <div class="toolbar">
      <div class="breadcrumb">
        <span class="breadcrumb-current">{{ $t('settings.title') }}</span>
      </div>
    </div>

    <div class="view-scroll">
      <div
        v-for="(section, sIdx) in sections"
        :key="sIdx"
        class="settings-section"
      >
        <div v-if="section.title" class="detail-section-title">{{ section.title }}</div>

        <div class="detail-fields">
          <SettingField
            v-for="field in section.fields"
            :key="field.id"
            :field="field"
            @setting-updated="loadSettings"
          />
        </div>

        <div v-if="section.actions?.length" class="detail-actions">
          <button
            v-for="(action, aIdx) in section.actions"
            :key="aIdx"
            :disabled="action.action === 'check-for-update' && checkingForUpdates"
            @click="handleAction(action)"
          >
            {{ action.action === 'check-for-update' && checkingForUpdates ? $t('settings.checkingForUpdates') : action.label }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
