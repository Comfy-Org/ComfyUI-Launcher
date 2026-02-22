<script setup lang="ts">
import { ref } from 'vue'
import type { SettingsField } from '../types/ipc'

interface Props {
  field: SettingsField
}

const props = defineProps<Props>()
const emit = defineEmits<{ 'setting-updated': [] }>()

const localPaths = ref<string[]>(Array.isArray(props.field.value) ? [...props.field.value] : [])

async function updateSetting(value: string | boolean | number | string[]): Promise<void> {
  await window.api.setSetting(props.field.id, value)
  emit('setting-updated')
}

async function handleSelectChange(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value
  await updateSetting(value)
}

async function handleBooleanChange(event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked
  await updateSetting(checked)
}

async function handleNumberChange(event: Event): Promise<void> {
  let value = Number((event.target as HTMLInputElement).value)
  if (props.field.min != null && value < props.field.min) value = props.field.min
  if (props.field.max != null && value > props.field.max) value = props.field.max
  await updateSetting(value)
}

async function browseSinglePath(): Promise<void> {
  const dir = await window.api.browseFolder(props.field.value as string | undefined)
  if (dir) {
    await updateSetting(dir)
  }
}

async function openSinglePath(): Promise<void> {
  if (props.field.value && typeof props.field.value === 'string') {
    await window.api.openPath(props.field.value)
  }
}

async function browsePath(index: number): Promise<void> {
  const dir = await window.api.browseFolder(localPaths.value[index])
  if (dir) {
    localPaths.value[index] = dir
    await updateSetting([...localPaths.value])
  }
}

async function openPath(path: string): Promise<void> {
  await window.api.openPath(path)
}

async function removePath(index: number): Promise<void> {
  localPaths.value.splice(index, 1)
  await updateSetting([...localPaths.value])
}

async function addPath(): Promise<void> {
  const dir = await window.api.browseFolder()
  if (dir) {
    localPaths.value.push(dir)
    await updateSetting([...localPaths.value])
  }
}
</script>

<template>
  <div class="field">
    <div class="detail-field-label">{{ field.label }}</div>

    <!-- Readonly -->
    <div v-if="field.readonly" class="detail-field-value">
      {{ field.value }}
    </div>

    <!-- Path -->
    <div v-else-if="field.type === 'path'" class="path-input">
      <input type="text" class="detail-field-input" :value="field.value ?? ''" readonly />
      <button @click="browseSinglePath">{{ $t('common.browse') }}</button>
      <button v-if="field.openable" @click="openSinglePath">{{ $t('settings.open') }}</button>
    </div>

    <!-- Select -->
    <select
v-else-if="field.type === 'select'" class="detail-field-input"
            :value="field.value" @change="handleSelectChange">
      <option v-for="opt in field.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
    </select>

    <!-- Boolean -->
    <input
v-else-if="field.type === 'boolean'" type="checkbox" class="detail-field-toggle"
           :checked="field.value === true" @change="handleBooleanChange" />

    <!-- Number -->
    <input
v-else-if="field.type === 'number'" type="number" class="detail-field-input"
           :value="field.value" :min="field.min" :max="field.max" @change="handleNumberChange" />

    <!-- PathList -->
    <div v-else-if="field.type === 'pathList'" class="path-list">
      <div v-for="(p, index) in localPaths" :key="index" class="path-input">
        <span v-if="index === 0" class="path-primary-tag">{{ $t('models.primary') }}</span>
        <input type="text" class="detail-field-input" :value="p" readonly />
        <button @click="openPath(p)">{{ $t('settings.open') }}</button>
        <button @click="browsePath(index)">{{ $t('common.browse') }}</button>
        <button class="danger" @click="removePath(index)">{{ $t('models.removeDir') }}</button>
      </div>
      <button @click="addPath">{{ $t('models.addDir') }}</button>
    </div>

    <!-- Text (fallback) -->
    <input
v-else type="text" class="detail-field-input"
           :value="field.value ?? ''" @change="updateSetting(($event.target as HTMLInputElement).value)" />
  </div>
</template>
