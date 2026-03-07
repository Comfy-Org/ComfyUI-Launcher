<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import { ArrowRightLeft } from 'lucide-vue-next'
import type { Installation } from '../types/ipc'

const props = defineProps<{
  installation: Installation
}>()

const emit = defineEmits<{
  'show-progress': [opts: {
    installationId: string
    title: string
    apiCall: () => Promise<unknown>
    cancellable?: boolean
  }]
  'show-settings': []
}>()

const { t } = useI18n()
const modal = useModal()
const migrating = ref(false)

async function startMigration(): Promise<void> {
  if (migrating.value) return
  migrating.value = true
  try {
    let previewResult: Awaited<ReturnType<typeof window.api.previewDesktopMigration>>
    try {
      previewResult = await window.api.previewDesktopMigration()
    } catch (err) {
      await modal.alert({
        title: t('desktop.migrateToStandalone'),
        message: (err as Error)?.message ?? String(err),
      })
      return
    }
    if (!previewResult.ok) {
      if (previewResult.message) {
        await modal.alert({ title: t('desktop.migrateToStandalone'), message: previewResult.message })
      }
      return
    }
    const confirmed = await modal.confirm({
      title: t('desktop.migrateConfirmTitle'),
      message: t('desktop.migrateConfirmMessage'),
      snapshotPreview: previewResult.preview?.newestSnapshot,
      messageDetails: [{
        label: t('desktop.migrateConfirmTitle'),
        items: [
          t('desktop.copyingUserData'),
          t('desktop.copyingInput'),
          t('desktop.copyingOutput'),
          t('desktop.addingModels'),
        ],
      }],
      confirmLabel: t('desktop.migrateConfirm'),
      confirmStyle: 'primary',
    })
    if (!confirmed) return

    emit('show-progress', {
      installationId: props.installation.id,
      title: `${t('desktop.migrating')} — ${props.installation.name}`,
      apiCall: () => window.api.runAction(
        props.installation.id,
        'migrate-to-standalone',
        { snapshotPath: previewResult.snapshotPath }
      ),
      cancellable: true,
    })
  } finally {
    migrating.value = false
  }
}

</script>

<template>
  <div class="dashboard-welcome">
    <div class="dashboard-welcome-icon">
      <ArrowRightLeft :size="48" />
    </div>
    <h1 class="dashboard-welcome-title">{{ $t('dashboard.migrateBannerTitle') }}</h1>
    <p class="dashboard-welcome-desc">{{ $t('dashboard.migrateBannerDesc') }}</p>
    <button
      class="primary dashboard-cta-btn"
      :disabled="migrating"
      @click="startMigration"
    >
      <ArrowRightLeft :size="18" />
      {{ $t('dashboard.migrateBannerAction') }}
    </button>
    <p class="dashboard-telemetry-notice">
      {{ $t('dashboard.telemetryNotice') }}
      <button class="dashboard-telemetry-link" @click="emit('show-settings')">
        {{ $t('dashboard.telemetrySettings') }}
      </button>
    </p>
  </div>
</template>
