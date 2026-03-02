<script setup lang="ts">
import { ref } from 'vue'
import { useElectronApi } from '../composables/useElectronApi'

const { api, listen } = useElectronApi()

const visible = ref(false)

listen<number>(api.onZoomChanged, (level) => {
  visible.value = level !== 0
})

async function reset() {
  await api.resetZoom()
  visible.value = false
}

function dismiss() {
  visible.value = false
}
</script>

<template>
  <div v-if="visible" class="zoom-banner">
    <span>{{ $t('zoom.changed') }}</span>
    <div class="zoom-banner-actions">
      <button class="primary" @click="reset">{{ $t('zoom.reset') }}</button>
      <button @click="dismiss">{{ $t('zoom.dismiss') }}</button>
    </div>
  </div>
</template>
