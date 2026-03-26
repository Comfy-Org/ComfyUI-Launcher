<script setup lang="ts">
import { ref, watch, computed } from 'vue'

const props = defineProps<{
  modelValue: Record<string, string>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, string>]
}>()

interface EnvVar {
  key: string
  value: string
}

const entries = ref<EnvVar[]>([])

// Sync from prop to local state
watch(() => props.modelValue, (val) => {
  const incoming = Object.entries(val || {}).map(([key, value]) => ({ key, value }))
  // Only reset if structurally different to avoid cursor jumps
  if (JSON.stringify(incoming) !== JSON.stringify(entries.value.filter(e => e.key || e.value))) {
    entries.value = incoming.length > 0 ? incoming : []
  }
}, { immediate: true })

const duplicateKeys = computed(() => {
  const seen = new Map<string, number>()
  for (const entry of entries.value) {
    const k = entry.key.trim()
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const dupes = new Set<string>()
  for (const [k, count] of seen) {
    if (count > 1) dupes.add(k)
  }
  return dupes
})

function isDuplicate(index: number): boolean {
  const k = entries.value[index]?.key.trim()
  return !!k && duplicateKeys.value.has(k)
}

function emitUpdate(): void {
  const result: Record<string, string> = {}
  for (const entry of entries.value) {
    const k = entry.key.trim()
    if (k) result[k] = entry.value
  }
  emit('update:modelValue', result)
}

function addEntry(): void {
  entries.value.push({ key: '', value: '' })
}

function removeEntry(index: number): void {
  entries.value.splice(index, 1)
  emitUpdate()
}

function onKeyChange(index: number, val: string): void {
  entries.value[index]!.key = val
  emitUpdate()
}

function onValueChange(index: number, val: string): void {
  entries.value[index]!.value = val
  emitUpdate()
}
</script>

<template>
  <div class="env-vars-editor">
    <div v-if="entries.length" class="env-vars-list">
      <div class="env-vars-notice">{{ $t('envVars.securityWarning') }}</div>
      <div v-for="(entry, i) in entries" :key="i" class="env-var-row">
        <input
          type="text"
          class="env-var-input env-var-key"
          :class="{ 'env-var-duplicate': isDuplicate(i) }"
          :value="entry.key"
          :placeholder="$t('envVars.namePlaceholder')"
          @change="onKeyChange(i, ($event.target as HTMLInputElement).value)"
        >
        <input
          type="text"
          class="env-var-input env-var-value"
          :value="entry.value"
          :placeholder="$t('envVars.valuePlaceholder')"
          @change="onValueChange(i, ($event.target as HTMLInputElement).value)"
        >
        <button class="env-var-remove" :title="$t('common.cancel')" aria-label="Remove variable" @click="removeEntry(i)">✕</button>
      </div>
    </div>
    <button class="env-var-add" @click="addEntry">+ {{ $t('envVars.add') }}</button>
  </div>
</template>

<style scoped>
.env-vars-notice {
  font-size: 12px;
  color: var(--info);
  margin-bottom: 4px;
}

.env-vars-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.env-var-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.env-var-input {
  font-size: 14px;
  padding: 6px 8px;
  margin-top: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  user-select: text;
}

.env-var-key {
  flex: 2;
  font-family: monospace;
}

.env-var-key.env-var-duplicate {
  border-color: var(--danger);
}

.env-var-value {
  flex: 3;
  font-family: monospace;
}

.env-var-remove {
  flex-shrink: 0;
  width: 28px;
  padding: 6px 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.env-var-remove:hover {
  color: var(--danger);
  border-color: var(--danger);
}

.env-var-add {
  font-size: 14px;
  padding: 6px 12px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.env-var-add:hover {
  color: var(--text);
  border-color: var(--text-muted);
}
</style>
