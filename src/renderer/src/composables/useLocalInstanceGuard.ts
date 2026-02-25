import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import { useModal } from './useModal'

/**
 * Guard that checks whether another local ComfyUI instance is already running
 * before launching a new one, and prompts the user for how to proceed.
 */
export function useLocalInstanceGuard() {
  const { t } = useI18n()
  const sessionStore = useSessionStore()
  const installationStore = useInstallationStore()
  const modal = useModal()

  /**
   * Check if another local instance is running before launching.
   * Returns true if launch should proceed, false if cancelled.
   * If the user chooses to replace, the running instance(s) are stopped before returning.
   */
  async function checkBeforeLaunch(targetId: string): Promise<boolean> {
    const target = installationStore.installations.find((i) => i.id === targetId)
    if (target && target.sourceCategory !== 'local') return true

    const runningLocal: { id: string; name: string }[] = []
    for (const [id, instance] of sessionStore.runningInstances) {
      if (id === targetId) continue
      const inst = installationStore.installations.find((i) => i.id === id)
      if (!inst || inst.sourceCategory === 'local') {
        runningLocal.push({ id, name: instance.installationName })
      }
    }

    if (runningLocal.length === 0) return true

    const names = runningLocal.map((r) => r.name).join(', ')

    const choice = await modal.select({
      title: t('launch.instanceRunningTitle'),
      message: t('launch.instanceRunningMessage', { name: names }),
      items: [
        {
          value: 'proceed',
          label: t('launch.instanceRunningProceed'),
        },
        {
          value: 'replace',
          label: t('launch.instanceRunningReplace'),
        },
      ],
    })

    if (choice === 'replace') {
      await Promise.all(runningLocal.map((r) => window.api.stopComfyUI(r.id)))
      return true
    }

    return choice === 'proceed'
  }

  return { checkBeforeLaunch }
}
