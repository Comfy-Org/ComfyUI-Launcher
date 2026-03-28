import { t } from './i18n'

interface ActionDef {
  [key: string]: unknown
  id: string
  label: string
  style: string
  enabled: boolean
  showProgress?: boolean
  progressTitle?: string
  cancellable?: boolean
  confirm?: { title: string; message: string; confirmLabel?: string }
  disabledMessage?: string
}

export function deleteAction(installation: { installPath: string }): ActionDef {
  return {
    id: 'delete',
    label: t('actions.delete'),
    style: 'danger',
    enabled: true,
    showProgress: true,
    progressTitle: 'Deleting',
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

export function launchAction(enabled: boolean, disabledMessage?: string): ActionDef {
  return {
    id: 'launch',
    label: t('actions.launch'),
    style: 'primary',
    enabled,
    ...(!enabled && disabledMessage ? { disabledMessage } : {}),
    showProgress: true,
    progressTitle: t('common.startingComfyUI'),
    cancellable: true,
  }
}

export function openFolderAction(installPath: string): ActionDef {
  return {
    id: 'open-folder',
    label: t('actions.openDirectory'),
    style: 'default',
    enabled: !!installPath,
  }
}

export function migrateToStandaloneAction(enabled: boolean): ActionDef {
  return {
    id: 'migrate-to-standalone',
    label: t('migrate.migrateToStandalone'),
    style: 'default',
    enabled,
    showProgress: true,
    progressTitle: t('migrate.migrating'),
    cancellable: true,
    confirm: {
      title: t('migrate.migrateToStandaloneConfirmTitle'),
      message: t('migrate.migrateToStandaloneConfirmMessage'),
      confirmLabel: t('migrate.migrateToStandaloneConfirm'),
    },
  }
}
