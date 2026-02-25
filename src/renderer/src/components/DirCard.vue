<script setup lang="ts">
interface Props {
  path: string
  isPrimary: boolean
  isDefault: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  remove: []
  'make-primary': []
  open: []
}>()
</script>

<template>
  <div class="dir-card">
    <div class="dir-card-info">
      <span class="dir-card-path" :title="path">{{ path }}</span>
      <span v-if="isPrimary" class="dir-card-tag tag-primary">{{ $t('models.primary') }}</span>
      <span v-if="isDefault" class="dir-card-tag tag-default">{{ $t('models.default') }}</span>
    </div>
    <div class="dir-card-actions">
      <button @click="emit('open')">{{ $t('settings.open') }}</button>

      <button v-if="!isDefault" class="danger" @click="emit('remove')">{{ $t('models.removeDir') }}</button>
      <button v-if="!isPrimary" class="accent" @click="emit('make-primary')">{{ $t('models.makePrimary') }}</button>
    </div>
  </div>
</template>
