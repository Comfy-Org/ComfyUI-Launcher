import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useModal } from './useModal'

/**
 * Guard that checks whether an installation is busy (launching, in-progress operation)
 * or running before allowing a mutating action, and prompts the user to cancel/stop.
 */
export function useActionGuard() {
  const { t } = useI18n()
  const sessionStore = useSessionStore()
  const modal = useModal()

  /**
   * Check if the installation is busy or running and prompt the user.
   * Returns true if the action should proceed, false if cancelled.
   */
  async function checkBeforeAction(installationId: string, actionLabel: string): Promise<boolean> {
    // Check if an operation (launch/install) is already in progress
    const activeSession = sessionStore.activeSessions.get(installationId)
    const isBusy = sessionStore.isLaunching(installationId) || (activeSession && !sessionStore.isRunning(installationId))
    if (isBusy) {
      const operation = activeSession?.label || t('running.title')
      const confirmed = await modal.confirm({
        title: actionLabel,
        message: t('errors.operationInProgress', { operation }),
        confirmLabel: t('errors.cancelOperation'),
        confirmStyle: 'danger',
      })
      if (!confirmed) return false
      await window.api.cancelOperation(installationId)
      await new Promise((r) => setTimeout(r, 500))
    }

    // Check if the installation is running
    if (sessionStore.isRunning(installationId)) {
      const confirmed = await modal.confirm({
        title: t('errors.stopRunning'),
        message: t('errors.stopRequiredConfirm'),
        confirmLabel: t('errors.stopRunning'),
        confirmStyle: 'primary',
      })
      if (!confirmed) return false
      await window.api.stopComfyUI(installationId)
      await new Promise((r) => setTimeout(r, 500))
    }

    return true
  }

  return { checkBeforeAction }
}
