<script setup lang="ts">
import { ref, onMounted } from 'vue'
import SettingField from '../components/SettingField.vue'
import type { SettingsSection } from '../types/ipc'

const sections = ref<SettingsSection[]>([])

async function loadMedia(): Promise<void> {
  sections.value = await window.api.getMediaSections()
}

onMounted(() => loadMedia())

defineExpose({ loadMedia })
</script>

<template>
  <div class="view active">
    <div class="toolbar">
      <div class="breadcrumb">
        <span class="breadcrumb-current">{{ $t('media.title') }}</span>
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
            @setting-updated="loadMedia"
          />
        </div>
      </div>
    </div>
  </div>
</template>
