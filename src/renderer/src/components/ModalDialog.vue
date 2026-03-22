<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal, type ModalOption } from '../composables/useModal'
import { sortedCardOptions, getVariantImage } from '../lib/variants'
import type { FieldOption } from '../types/ipc'
import InfoTooltip from './InfoTooltip.vue'

const { t } = useI18n()

const { state, close, updateConfirm } = useModal()

const sortedVariants = computed(() => sortedCardOptions(state.variantCards))

function selectVariant(opt: FieldOption): void {
  updateConfirm({ selectedVariant: opt })
}

const inputValue = ref('')
const error = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const overlayRef = ref<HTMLDivElement | null>(null)
const mouseDownOnOverlay = ref(false)
const spNodesExpanded = ref(true)
const spPipExpanded = ref(false)

const localOptions = reactive<(ModalOption & { checked: boolean })[]>([])

const anyChecked = computed(() => localOptions.some((o) => o.checked))

function formatNodeVersion(node: { version?: string; commit?: string }): string {
  if (node.version) return node.version
  if (node.commit) return node.commit.slice(0, 7)
  return '—'
}

const confirmClass = computed(() =>
  state.confirmStyle === 'danger' ? 'danger-solid' : state.confirmStyle
)

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

const URL_RE = /https?:\/\/[^\s<>"']+/g

const linkifiedMessage = computed(() => {
  if (!state.message) return ''
  const escaped = escapeHtml(state.message)
  return escaped.replace(URL_RE, (url) => {
    return `<a href="#" class="modal-link" data-url="${escapeHtml(url)}">${escapeHtml(url)}</a>`
  })
})

function handleMessageClick(event: MouseEvent): void {
  const target = event.target as HTMLElement
  if (target.classList.contains('modal-link')) {
    event.preventDefault()
    const url = target.dataset.url
    if (url) {
      window.api.openExternal(url)
    }
  }
}

function submitPrompt(): void {
  const value = inputValue.value.trim()
  if (state.required && !value) {
    error.value = typeof state.required === 'string' ? state.required : 'This field is required'
    return
  }
  close(value)
}

function submitOptions(): void {
  const result: Record<string, boolean> = {}
  for (const opt of localOptions) {
    result[opt.id] = opt.checked
  }
  close(result)
}

function handleOverlayMouseDown(event: MouseEvent): void {
  mouseDownOnOverlay.value = event.target === overlayRef.value
}

function handleOverlayClick(event: MouseEvent): void {
  if (mouseDownOnOverlay.value && event.target === overlayRef.value) {
    if (state.type === 'alert') {
      close(undefined)
    } else {
      close(state.type === 'confirm' ? false : null)
    }
  }
  mouseDownOnOverlay.value = false
}

function resetSnapshotExpansion(): void {
  const sp = state.snapshotPreview
  const hasVariantCards = state.variantCards.length > 0 || state.variantLoading
  spNodesExpanded.value = hasVariantCards ? false : sp ? sp.customNodes.length > 0 : true
  spPipExpanded.value = false
}

watch(() => state.snapshotPreview, () => {
  if (state.visible && state.type === 'confirm') {
    resetSnapshotExpansion()
  }
})

watch(() => state.variantCards, () => {
  if (state.visible && state.type === 'confirm' && state.variantCards.length > 0) {
    spNodesExpanded.value = false
  }
})

function handleKeydown(event: KeyboardEvent): void {
  if (!state.visible) return
  if (event.key === 'Escape') {
    if (state.type === 'alert') {
      close(undefined)
    } else {
      close(state.type === 'confirm' ? false : null)
    }
  }
}

watch(
  () => state.visible,
  async (visible) => {
    if (!visible) return

    if (state.type === 'prompt') {
      inputValue.value = state.defaultValue
      error.value = ''
      await nextTick()
      inputRef.value?.focus()
      inputRef.value?.select()
    }

    if (state.type === 'confirm') {
      resetSnapshotExpansion()
    }

    if (state.type === 'confirmWithOptions') {
      localOptions.length = 0
      for (const opt of state.options) {
        localOptions.push({ id: opt.id, label: opt.label, checked: opt.checked ?? false })
      }
    }
  }
)

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state.visible"
      ref="overlayRef"
      class="modal-overlay"
      @mousedown="handleOverlayMouseDown"
      @click="handleOverlayClick"
    >
      <!-- Alert -->
      <div v-if="state.type === 'alert'" class="modal-box">
        <div class="modal-title">{{ state.title }}</div>
        <div
          class="modal-message"
          @click="handleMessageClick"
          v-html="linkifiedMessage"
        ></div>
        <div class="modal-actions">
          <button class="primary" @click="close(undefined)">{{ state.buttonLabel }}</button>
        </div>
      </div>

      <!-- Confirm -->
      <div v-else-if="state.type === 'confirm'" class="modal-box" :class="{ 'modal-box-wide': state.snapshotPreview || state.loading || state.variantLoading || state.variantCards.length > 0 }">
        <div class="modal-title">{{ state.title }}</div>
        <div class="modal-body">
          <div
            class="modal-message"
            @click="handleMessageClick"
            v-html="linkifiedMessage"
          ></div>

          <!-- Loading -->
          <div v-if="state.loading" class="modal-loading">
            <div class="modal-loading-spinner" />
            <span>{{ $t('common.loading') }}</span>
          </div>

          <!-- Snapshot preview -->
          <template v-if="!state.loading && state.snapshotPreview">
            <div class="sp-grid">
              <div class="sp-field">
                <span class="sp-label">{{ $t('snapshots.comfyuiVersion') }}</span>
                <span class="sp-value">{{ state.snapshotPreview.comfyuiVersion }}</span>
              </div>
              <div class="sp-field">
                <span class="sp-label">{{ $t('snapshots.variant') }}</span>
                <span class="sp-value">{{ state.snapshotPreview.comfyui.variant || '—' }}</span>
              </div>
              <div v-if="state.snapshotPreview.pythonVersion" class="sp-field">
                <span class="sp-label">{{ $t('snapshots.pythonVersion') }}</span>
                <span class="sp-value">{{ state.snapshotPreview.pythonVersion }}</span>
              </div>

            </div>

            <div class="sp-subsection">
              <div class="sp-subsection-title" @click="spNodesExpanded = !spNodesExpanded">
                <span>{{ $t('snapshots.customNodes') }} ({{ state.snapshotPreview.customNodes.length }})<InfoTooltip :text="t('tooltips.customNodes')" side="bottom" /></span>
                <span class="sp-collapse">{{ spNodesExpanded ? '▾' : '▸' }}</span>
              </div>
              <template v-if="spNodesExpanded">
                <div v-if="state.snapshotPreview.customNodes.length > 0" class="sp-recessed-list">
                  <div v-for="node in state.snapshotPreview.customNodes" :key="node.id" class="sp-node-row">
                    <span class="sp-node-status" :class="node.enabled ? 'sp-node-enabled' : 'sp-node-disabled'" />
                    <span class="sp-node-name">{{ node.id }}</span>
                    <span class="sp-node-type">{{ node.type }}</span>
                    <span class="sp-node-version">{{ formatNodeVersion(node) }}</span>
                  </div>
                </div>
                <div v-else class="sp-empty">—</div>
              </template>
            </div>

            <div class="sp-subsection">
              <div class="sp-subsection-title" @click="spPipExpanded = !spPipExpanded">
                <span>{{ $t('snapshots.pipPackages') }} ({{ state.snapshotPreview.pipPackageCount }})<InfoTooltip :text="t('tooltips.pipPackages')" side="bottom" /></span>
                <span class="sp-collapse">{{ spPipExpanded ? '▾' : '▸' }}</span>
              </div>
              <template v-if="spPipExpanded">
                <div v-if="state.snapshotPreview.pipPackageCount > 0" class="sp-recessed-list">
                  <div v-for="(version, name) in state.snapshotPreview.pipPackages" :key="name" class="sp-pip-row">
                    <span class="sp-pip-name">{{ name }}</span>
                    <span class="sp-pip-version" :title="version">{{ version }}</span>
                  </div>
                </div>
                <div v-else class="sp-empty">—</div>
              </template>
            </div>
          </template>

          <!-- Variant / device selection -->
          <div v-if="!state.loading && (state.variantCards.length > 0 || state.variantLoading)" class="sp-subsection">
            <div class="sp-subsection-title">
              <span>{{ $t('list.snapshotDevice') }}</span>
            </div>
            <div v-if="state.variantLoading" class="modal-loading">
              <div class="modal-loading-spinner" />
              <span>{{ $t('common.loading') }}</span>
            </div>
            <div v-else class="variant-cards">
              <div
                v-for="opt in sortedVariants"
                :key="opt.value"
                role="button"
                tabindex="0"
                :class="['variant-card', {
                  selected: state.selectedVariant?.value === opt.value,
                  recommended: opt.recommended,
                }]"
                @click="selectVariant(opt)"
                @keydown.enter.prevent="selectVariant(opt)"
              >
                <div class="variant-card-icon">
                  <img
                    v-if="getVariantImage(opt)"
                    :src="getVariantImage(opt)!"
                    :alt="opt.label"
                    draggable="false"
                  />
                  <span v-else class="variant-card-icon-text">{{ opt.label }}</span>
                </div>
                <div class="variant-card-label">{{ opt.label }}</div>
                <div v-if="opt.recommended" class="variant-card-badge">
                  {{ $t('newInstall.recommended') }}
                </div>
                <div v-if="opt.description" class="variant-card-desc">
                  {{ opt.description }}
                </div>
              </div>
            </div>
          </div>

          <div v-if="state.messageDetails.length" class="modal-details">
            <div v-for="(group, gi) in state.messageDetails" :key="gi" class="modal-detail-group">
              <span class="modal-detail-label">{{ group.label }}</span>
              <ul class="modal-detail-list">
                <li v-for="(item, ii) in group.items" :key="ii">{{ item }}</li>
              </ul>
            </div>
          </div>
          <div v-if="state.checkboxes.length" class="modal-options">
            <label v-for="cb in state.checkboxes" :key="cb.id" class="modal-option">
              <input v-model="cb.checked" type="checkbox" />
              <span>{{ cb.label }}</span>
            </label>
          </div>
        </div>
        <div class="modal-actions">
          <button @click="close(false)">{{ $t('common.cancel') }}</button>
          <button :class="confirmClass" :disabled="state.loading || state.variantLoading || (state.variantCards.length > 0 && !state.selectedVariant)" @click="close(true)">
            {{ state.confirmLabel }}
          </button>
        </div>
      </div>

      <!-- ConfirmWithOptions -->
      <div v-else-if="state.type === 'confirmWithOptions'" class="modal-box">
        <div class="modal-title">{{ state.title }}</div>
        <div class="modal-message">{{ state.message }}</div>
        <div class="modal-options">
          <label v-for="opt in localOptions" :key="opt.id" class="modal-option">
            <input v-model="opt.checked" type="checkbox" />
            <span>{{ opt.label }}</span>
          </label>
        </div>
        <div class="modal-actions">
          <button @click="close(null)">{{ $t('common.cancel') }}</button>
          <button
            :class="confirmClass"
            :disabled="!anyChecked"
            @click="submitOptions()"
          >
            {{ state.confirmLabel }}
          </button>
        </div>
      </div>

      <!-- Prompt -->
      <div v-else-if="state.type === 'prompt'" class="modal-box">
        <div class="modal-title">{{ state.title }}</div>
        <div class="modal-message">{{ state.message }}</div>
        <div class="modal-input-wrap">
          <input
            ref="inputRef"
            v-model="inputValue"
            type="text"
            class="modal-input"
            :placeholder="state.placeholder"
            @keydown.enter="submitPrompt"
          />
        </div>
        <div v-if="error" class="modal-error">{{ error }}</div>
        <div class="modal-actions">
          <button @click="close(null)">{{ $t('common.cancel') }}</button>
          <button class="primary" @click="submitPrompt">{{ state.confirmLabel }}</button>
        </div>
      </div>

      <!-- Select -->
      <div v-else-if="state.type === 'select'" class="modal-box modal-select-box">
        <div class="modal-title">{{ state.title }}</div>
        <div v-if="state.message" class="modal-message">{{ state.message }}</div>
        <div class="modal-select-list">
          <button
            v-for="item in state.items"
            :key="item.value"
            class="modal-select-item"
            @click="close(item.value)"
          >
            <span class="modal-select-item-label">{{ item.label }}</span>
            <span v-if="item.description" class="modal-select-item-desc">
              {{ item.description }}
            </span>
          </button>
        </div>
        <div class="modal-actions">
          <button @click="close(null)">{{ $t('common.cancel') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

