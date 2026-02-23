<script setup lang="ts">
defineProps<{
  phase: string
  label: string
  status: 'pending' | 'active' | 'done'
  statusText?: string
  percent?: number
  summaryText?: string
  stepNumber: number
  error?: string
}>()
</script>

<template>
  <div class="progress-step" :class="status" :data-phase="phase">
    <div class="progress-step-header">
      <span class="progress-step-indicator">
        {{ status === 'done' ? '✓' : stepNumber }}
      </span>
      <span class="progress-step-label">{{ label }}</span>
    </div>
    <div v-if="status === 'active'" class="progress-step-detail">
      <div class="progress-step-status">{{ error ?? statusText }}</div>
      <div v-if="!error" class="progress-bar-track">
        <div
          class="progress-bar-fill"
          :class="{ indeterminate: (percent ?? -1) < 0 }"
          :style="{ width: (percent ?? -1) >= 0 ? `${percent}%` : '100%' }"
        ></div>
      </div>
    </div>
    <div v-if="status === 'done' && summaryText" class="progress-step-summary">
      {{ summaryText }}
    </div>
  </div>
</template>
