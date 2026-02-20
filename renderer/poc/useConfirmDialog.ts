/**
 * PoC: Promise-based composable bridging Radix Dialog to the existing
 * window.Launcher.modal.confirm() API pattern.
 *
 * This shows how the current imperative API:
 *
 *   const confirmed = await window.Launcher.modal.confirm({
 *     title: "Delete?",
 *     message: "Are you sure?",
 *     confirmLabel: "Delete",
 *     confirmStyle: "danger",
 *   });
 *
 * Can be preserved as a Vue composable:
 *
 *   const { confirm, dialogProps } = useConfirmDialog()
 *   const confirmed = await confirm({
 *     title: "Delete?",
 *     message: "Are you sure?",
 *     confirmLabel: "Delete",
 *     confirmStyle: "danger",
 *   })
 *
 * The composable returns reactive props to bind to <ConfirmDialog v-bind="dialogProps" />.
 */
import { reactive } from 'vue'

interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  confirmStyle?: 'danger' | 'primary'
}

export function useConfirmDialog() {
  let resolvePromise: ((value: boolean) => void) | null = null

  const dialogProps = reactive({
    open: false,
    title: '',
    message: '',
    confirmLabel: 'Confirm',
    confirmStyle: 'danger' as 'danger' | 'primary',
  })

  function confirm(options: ConfirmOptions): Promise<boolean> {
    dialogProps.title = options.title
    dialogProps.message = options.message
    dialogProps.confirmLabel = options.confirmLabel ?? 'Confirm'
    dialogProps.confirmStyle = options.confirmStyle ?? 'danger'
    dialogProps.open = true

    return new Promise<boolean>((resolve) => {
      resolvePromise = resolve
    })
  }

  function onConfirm() {
    dialogProps.open = false
    resolvePromise?.(true)
    resolvePromise = null
  }

  function onCancel() {
    dialogProps.open = false
    resolvePromise?.(false)
    resolvePromise = null
  }

  function onUpdateOpen(value: boolean) {
    dialogProps.open = value
    if (!value) {
      resolvePromise?.(false)
      resolvePromise = null
    }
  }

  return {
    confirm,
    dialogProps,
    onConfirm,
    onCancel,
    onUpdateOpen,
  }
}
