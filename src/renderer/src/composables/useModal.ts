import { reactive, readonly } from 'vue'
import { i18n } from '../main'

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

export interface ModalState {
  visible: boolean
  type: ModalType
  title: string
  message: string
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
  title: '',
  message: '',
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
  state.title = ''
  state.message = ''
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

function close(value: unknown): void {
  const resolve = state.resolve
  reset()
  if (resolve) resolve(value)
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
    confirmLabel?: string
    confirmStyle?: string
  }): Promise<boolean> {
    return new Promise((resolve) => {
      reset()
      state.visible = true
      state.type = 'confirm'
      state.title = opts.title
      state.message = opts.message
      state.confirmLabel = opts.confirmLabel ?? i18n.global.t('modal.confirm')
      state.confirmStyle = opts.confirmStyle ?? 'danger'
      state.resolve = resolve as (value: unknown) => void
    })
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
    confirmWithOptions,
    prompt,
    select,
    close,
  }
}
