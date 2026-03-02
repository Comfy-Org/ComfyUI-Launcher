<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const allowMetrics = ref(true)

async function submit(): Promise<void> {
  await window.api.setSetting('sendAnalytics', allowMetrics.value)
  emit('close')
}

function openPrivacyPolicy(): void {
  window.api.openExternal('https://comfy.org/privacy')
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay">
      <div class="modal-box consent-box">
        <div class="modal-title consent-title">
          {{ t('analytics.consentTitle') }}
        </div>
        <div class="modal-message consent-message">
          {{ t('analytics.consentDescription') }}
        </div>
        <div class="modal-message consent-message consent-privacy">
          {{ t('analytics.consentPrivacy') }}
          <a href="#" @click.prevent="openPrivacyPolicy">{{ t('analytics.privacyPolicy') }}</a>.
        </div>
        <div class="consent-toggle">
          <input v-model="allowMetrics" type="checkbox" />
          <span>
            {{ allowMetrics ? t('analytics.metricsEnabled') : t('analytics.metricsDisabled') }}
          </span>
        </div>
        <div class="modal-actions">
          <button class="primary" @click="submit">{{ t('modal.ok') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.consent-box {
  max-width: 480px;
}
.consent-title {
  font-size: 18px;
  margin-bottom: 12px;
}
.consent-message {
  white-space: normal;
}
.consent-privacy {
  margin-bottom: 16px;
}
.consent-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
  font-size: 14px;
}
</style>
