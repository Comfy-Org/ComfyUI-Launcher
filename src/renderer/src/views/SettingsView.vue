<script setup lang="ts">
import { ref, onMounted } from 'vue'
import SettingField from '../components/SettingField.vue'
import type { SettingsSection } from '../types/ipc'

function openUrl(url: string): void {
  window.api.openExternal(url)
}

const sections = ref<SettingsSection[]>([])

async function loadSettings(): Promise<void> {
  sections.value = await window.api.getSettingsSections()
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

        <div v-if="section.actions?.length" class="detail-actions" style="margin-top: 8px">
          <button
            v-for="(action, aIdx) in section.actions"
            :key="aIdx"
            @click="action.url && openUrl(action.url)"
          >
            {{ action.label }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
