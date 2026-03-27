import { reactive, readonly } from 'vue'
import { i18n } from '../main'
import type { SnapshotDetailData, FieldOption, ModalDetailGroup } from '../types/ipc'

export type ModalType = 'alert' | 'confirm' | 'confirmWithOptions' | 'prompt' | 'select'

export interface ModalSelectItem {
  value: string
  label: string
  description?: string
}

export interface ModalOption {
  id: string
  label: string
  checked?: boolean
}

export type { ModalDetailGroup }

export interface ModalCheckbox {
  id: string
  label: string
  checked: boolean
}

export interface ModalState {
  visible: boolean
  type: ModalType
  loading: boolean
  title: string
  message: string
  messageDetails: ModalDetailGroup[]
  snapshotPreview: SnapshotDetailData | null
  variantCards: FieldOption[]
  selectedVariant: FieldOption | null
  variantLoading: boolean
  checkboxes: ModalCheckbox[]
  buttonLabel: string
  confirmLabel: string
  confirmStyle: string
  placeholder: string
  defaultValue: string
  required: boolean | string
  items: ModalSelectItem[]
  options: ModalOption[]
  resolve: ((value: unknown) => void) | null
}

const state = reactive<ModalState>({
  visible: false,
  type: 'alert',
  loading: false,
  title: '',
  message: '',
  messageDetails: [],
  snapshotPreview: null,
  variantCards: [],
  selectedVariant: null,
  variantLoading: false,
  checkboxes: [],
  buttonLabel: 'OK',
  confirmLabel: 'Confirm',
  confirmStyle: 'danger',
  placeholder: '',
  defaultValue: '',
  required: false,
  items: [],
  options: [],
  resolve: null,
})

function reset(): void {
  state.visible = false
  state.type = 'alert'
  state.loading = false
  state.title = ''
  state.message = ''
  state.messageDetails = []
  state.snapshotPreview = null
  state.variantCards = []
  state.selectedVariant = null
  state.variantLoading = false
  state.checkboxes = []
  state.buttonLabel = 'OK'
  state.confirmLabel = 'Confirm'
  state.confirmStyle = 'danger'
  state.placeholder = ''
  state.defaultValue = ''
  state.required = false
  state.items = []
  state.options = []
  state.resolve = null
}

let _lastCheckboxValues: Record<string, boolean> = {}

function close(value: unknown): void {
  const resolve = state.resolve
  _lastCheckboxValues = Object.fromEntries(state.checkboxes.map((c) => [c.id, c.checked]))
  reset()
  if (resolve) resolve(value)
}

function getLastCheckboxValues(): Record<string, boolean> {
  return _lastCheckboxValues
}

export function useModal() {
  function alert(opts: {
    title: string
    message: string
    buttonLabel?: string
  }): Promise<void> {
    return new Promise((resolve) => {
      reset()
      state.visible = true
      state.type = 'alert'
      state.title = opts.title
      state.message = opts.message
      state.buttonLabel = opts.buttonLabel ?? i18n.global.t('modal.ok')
      state.resolve = () => resolve()
    })
  }

  function confirm(opts: {
    title: string
    message: string
    loading?: boolean
    messageDetails?: ModalDetailGroup[]
    snapshotPreview?: SnapshotDetailData | null
    checkboxes?: ModalCheckbox[]
    confirmLabel?: string
    confirmStyle?: string
  }): Promise<boolean> {
    return new Promise((resolve) => {
      reset()
      state.visible = true
      state.type = 'confirm'
      state.loading = opts.loading ?? false
      state.title = opts.title
      state.message = opts.message
      state.messageDetails = (opts.messageDetails ?? []).map((g) => ({ ...g, items: [...g.items] }))
      state.snapshotPreview = opts.snapshotPreview ?? null
      state.checkboxes = (opts.checkboxes ?? []).map((c) => ({ ...c }))
      state.confirmLabel = opts.confirmLabel ?? i18n.global.t('modal.confirm')
      state.confirmStyle = opts.confirmStyle ?? 'danger'
      state.resolve = resolve as (value: unknown) => void
    })
  }

  function updateConfirm(opts: {
    loading?: boolean
    message?: string
    messageDetails?: ModalDetailGroup[]
    snapshotPreview?: SnapshotDetailData | null
    variantCards?: FieldOption[]
    selectedVariant?: FieldOption | null
    variantLoading?: boolean
    checkboxes?: ModalCheckbox[]
  }): void {
    if (!state.visible || state.type !== 'confirm') return
    if (opts.loading !== undefined) state.loading = opts.loading
    if (opts.message !== undefined) state.message = opts.message
    if (opts.messageDetails !== undefined) state.messageDetails = opts.messageDetails.map((g) => ({ ...g, items: [...g.items] }))
    if (opts.snapshotPreview !== undefined) state.snapshotPreview = opts.snapshotPreview
    if (opts.variantCards !== undefined) state.variantCards = opts.variantCards
    if (opts.selectedVariant !== undefined) state.selectedVariant = opts.selectedVariant
    if (opts.variantLoading !== undefined) state.variantLoading = opts.variantLoading
    if (opts.checkboxes !== undefined) state.checkboxes = opts.checkboxes.map((c) => ({ ...c }))
  }

  function confirmWithOptions(opts: {
    title: string
    message: string
    options: ModalOption[]
    confirmLabel?: string
    confirmStyle?: string
  }): Promise<Record<string, boolean> | null> {
    return new Promise((resolve) => {
      reset()
      state.visible = true
      state.type = 'confirmWithOptions'
      state.title = opts.title
      state.message = opts.message
      state.options = opts.options.map((o) => ({ ...o }))
      state.confirmLabel = opts.confirmLabel ?? 'Confirm'
      state.confirmStyle = opts.confirmStyle ?? 'danger'
      state.resolve = resolve as (value: unknown) => void
    })
  }

  function prompt(opts: {
    title: string
    message: string
    placeholder?: string
    defaultValue?: string
    confirmLabel?: string
    required?: boolean | string
    messageDetails?: ModalDetailGroup[]
  }): Promise<string | null> {
    return new Promise((resolve) => {
      reset()
      state.visible = true
      state.type = 'prompt'
      state.title = opts.title
      state.message = opts.message
      state.placeholder = opts.placeholder ?? ''
      state.defaultValue = opts.defaultValue ?? ''
      state.confirmLabel = opts.confirmLabel ?? 'OK'
      state.required = opts.required ?? false
      state.messageDetails = (opts.messageDetails ?? []).map((g) => ({ ...g, items: [...g.items] }))
      state.resolve = resolve as (value: unknown) => void
    })
  }

  function select(opts: {
    title: string
    message?: string
    items: ModalSelectItem[]
    confirmLabel?: string
  }): Promise<string | null> {
    return new Promise((resolve) => {
      reset()
      state.visible = true
      state.type = 'select'
      state.title = opts.title
      state.message = opts.message ?? ''
      state.items = opts.items
      state.confirmLabel = opts.confirmLabel ?? 'OK'
      state.resolve = resolve as (value: unknown) => void
    })
  }

  return {
    state: readonly(state) as ModalState,
    alert,
    confirm,
    updateConfirm,
    confirmWithOptions,
    prompt,
    select,
    close,
    getLastCheckboxValues,
  }
}
