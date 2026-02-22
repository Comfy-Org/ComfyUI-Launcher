<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted, reactive } from 'vue'
import { useModal, type ModalOption } from '../composables/useModal'

const { state, close } = useModal()

const inputValue = ref('')
const error = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const overlayRef = ref<HTMLDivElement | null>(null)
const mouseDownOnOverlay = ref(false)

const localOptions = reactive<(ModalOption & { checked: boolean })[]>([])

const anyChecked = computed(() => localOptions.some((o) => o.checked))

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
      <div v-else-if="state.type === 'confirm'" class="modal-box">
        <div class="modal-title">{{ state.title }}</div>
        <div
          class="modal-message"
          @click="handleMessageClick"
          v-html="linkifiedMessage"
        ></div>
        <div class="modal-actions">
          <button @click="close(false)">{{ $t('common.cancel') }}</button>
          <button :class="state.confirmStyle" @click="close(true)">
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
            :class="state.confirmStyle"
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

