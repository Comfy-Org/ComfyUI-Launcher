<script setup lang="ts">
import { ref, onMounted } from 'vue'
import DirCard from '../components/DirCard.vue'
import type { ModelsSection } from '../types/ipc'

const systemDefault = ref('')
const sections = ref<ModelsSection[]>([])

function normalizePath(p: string): string {
  return (p || '').replace(/[\\/]+$/, '').toLowerCase()
}

async function loadModels(): Promise<void> {
  const result = await window.api.getModelsSections()
  systemDefault.value = result.systemDefault
  sections.value = result.sections
}

function isDefault(path: string): boolean {
  return normalizePath(path) === normalizePath(systemDefault.value)
}

async function handleBrowse(field: ModelsSection['fields'][number], index: number): Promise<void> {
  const dir = await window.api.browseFolder(field.value[index])
  if (dir) {
    field.value[index] = dir
    await window.api.setSetting(field.id, [...field.value])
  }
}

async function handleRemove(field: ModelsSection['fields'][number], index: number): Promise<void> {
  field.value.splice(index, 1)
  await window.api.setSetting(field.id, [...field.value])
}

async function handleMakePrimary(
  field: ModelsSection['fields'][number],
  index: number
): Promise<void> {
  const path = field.value[index]
  if (!path) return
  field.value.splice(index, 1)
  field.value.unshift(path)
  await window.api.setSetting(field.id, [...field.value])
}

function handleOpen(path: string): void {
  window.api.openPath(path)
}

async function handleAdd(field: ModelsSection['fields'][number]): Promise<void> {
  const dir = await window.api.browseFolder()
  if (dir) {
    field.value.push(dir)
    await window.api.setSetting(field.id, [...field.value])
  }
}

onMounted(() => loadModels())

defineExpose({ loadModels })
</script>

<template>
  <div class="view active">
    <div class="toolbar">
      <div class="breadcrumb">
        <span class="breadcrumb-current">{{ $t('models.title') }}</span>
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
          <div v-for="field in section.fields" :key="field.id" class="field">
            <label>{{ field.label }}</label>

            <div class="dir-card-list">
              <DirCard
                v-for="(path, index) in field.value"
                :key="index"
                :path="path"
                :is-primary="index === 0"
                :is-default="isDefault(path)"
                @open="handleOpen(path)"
                @browse="handleBrowse(field, index)"
                @remove="handleRemove(field, index)"
                @make-primary="handleMakePrimary(field, index)"
              />
              <button @click="handleAdd(field)">{{ $t('models.addDir') }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
