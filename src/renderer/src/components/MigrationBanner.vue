<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMigrateAction } from '../composables/useMigrateAction'
import { useProgressStore } from '../stores/progressStore'
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
const { confirmMigration } = useMigrateAction()
const progressStore = useProgressStore()
const migrating = ref(false)

const activeOp = computed(() => {
  const op = progressStore.operations.get(props.installation.id)
  return op && !op.finished ? op : null
})

const progressInfo = computed(() =>
  progressStore.getProgressInfo(props.installation.id)
)

async function startMigration(): Promise<void> {
  if (migrating.value) return
  migrating.value = true
  try {
    const result = await confirmMigration(props.installation)
    if (!result) return

    emit('show-progress', {
      installationId: props.installation.id,
      title: `${t('desktop.migrating')} — ${props.installation.name}`,
      apiCall: () => window.api.runAction(
        props.installation.id,
        'migrate-to-standalone',
        result,
      ),
      cancellable: true,
    })
  } finally {
    migrating.value = false
  }
}

function viewProgress(): void {
  // Emit with a dummy apiCall — App.vue's showProgress detects the existing
  // in-progress operation and just reopens the ProgressModal without starting a new one.
  emit('show-progress', {
    installationId: props.installation.id,
    title: '',
    apiCall: () => Promise.resolve({} as unknown),
  })
}
</script>

<template>
  <div class="dashboard-welcome">
    <div class="dashboard-welcome-icon">
      <ArrowRightLeft :size="48" />
    </div>

    <!-- In-progress state -->
    <template v-if="activeOp">
      <h1 class="dashboard-welcome-title">{{ $t('desktop.migrating') }}</h1>
      <p class="dashboard-welcome-desc">{{ progressInfo?.status || $t('progress.starting') }}</p>
      <div
        class="progress-bar-track migration-banner-progress"
        :class="{ indeterminate: !progressInfo || progressInfo.percent < 0 }"
      >
        <div
          class="progress-bar-fill"
          :style="{ width: progressInfo && progressInfo.percent >= 0 ? `${progressInfo.percent}%` : '0%' }"
        ></div>
      </div>
      <button class="primary dashboard-cta-btn" @click="viewProgress">
        {{ $t('list.viewProgress') }}
      </button>
    </template>

    <!-- Default state -->
    <template v-else>
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
    </template>

    <p class="dashboard-telemetry-notice">
      {{ $t('dashboard.telemetryNotice') }}
      <button class="dashboard-telemetry-link" @click="emit('show-settings')">
        {{ $t('dashboard.telemetrySettings') }}
      </button>
    </p>
  </div>
</template>
