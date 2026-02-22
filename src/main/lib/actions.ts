import { t } from './i18n'

interface ActionDef {
  id: string
  label: string
  style: string
  enabled: boolean
  showProgress?: boolean
  progressTitle?: string
  cancellable?: boolean
  confirm: { title: string; message: string }
}

export function deleteAction(installation: { installPath: string }): ActionDef {
  return {
    id: 'delete',
    label: t('actions.delete'),
    style: 'danger',
    enabled: true,
    showProgress: true,
    progressTitle: 'Deleting…',
    cancellable: true,
    confirm: {
      title: t('actions.deleteConfirmTitle'),
      message: t('actions.deleteConfirmMessage') + `\n${installation.installPath}`,
    },
  }
}

export function untrackAction(): ActionDef {
  return {
    id: 'remove',
    label: t('actions.untrack'),
    style: 'danger',
    enabled: true,
    confirm: {
      title: t('actions.untrackConfirmTitle'),
      message: t('actions.untrackConfirmMessage'),
    },
  }
}
