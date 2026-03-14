import fs from 'fs'
import path from 'path'
import { shell } from 'electron'
import { untrackAction } from '../lib/actions'
import { findDesktopExecutable } from '../lib/desktopDetect'
import { t } from '../lib/i18n'
import type { InstallationRecord } from '../installations'
import type {
  SourcePlugin,
  FieldOption,
  ActionResult,
  ActionTools,
  LaunchCommand,
  StatusTag,
} from '../types/sources'

export const desktop: SourcePlugin = {
  id: 'desktop',
  get label() { return t('desktop.label') },
  get description() { return t('desktop.desc') },
  category: 'local',
  hasConsole: true,
  skipInstall: true,
  platforms: ['win32', 'darwin'],
  hidden: true,

  get fields() {
    return []
  },

  buildInstallation(): Record<string, unknown> {
    return {
      version: 'desktop',
      launchMode: 'external',
      useSharedPaths: false,
    }
  },

  getListPreview(installation: InstallationRecord): string | null {
    return installation.installPath || null
  },

  getStatusTag(installation: InstallationRecord): StatusTag | undefined {
    if (installation.status === 'installed') {
      return { label: t('migrate.migrateToStandalonePill'), style: 'migrate' }
    }
    return undefined
  },

  getLaunchCommand(installation: InstallationRecord): LaunchCommand | null {
    const execPath = (installation.desktopExePath as string | undefined) || findDesktopExecutable()
    if (!execPath || !fs.existsSync(execPath)) return null
    // macOS .app bundles cannot be spawned directly — use `open` to launch them
    if (process.platform === 'darwin' && execPath.endsWith('.app')) {
      return {
        cmd: '/usr/bin/open',
        args: [execPath],
        cwd: path.dirname(execPath),
        showWindow: true,
        skipPortWait: true,
        skipSharedPaths: true,
      }
    }
    return {
      cmd: execPath,
      args: [],
      cwd: path.dirname(execPath),
      showWindow: true,
      skipPortWait: true,
      skipSharedPaths: true,
    }
  },

  getListActions(installation: InstallationRecord): Record<string, unknown>[] {
    return [
      {
        id: 'launch',
        label: t('actions.launch'),
        style: 'primary',
        enabled: installation.status === 'installed',
      },
    ]
  },

  getDetailSections(installation: InstallationRecord): Record<string, unknown>[] {
    const execPath = (installation.desktopExePath as string | undefined) || findDesktopExecutable()
    return [
      {
        tab: 'status',
        title: t('desktop.installInfo'),
        fields: [
          { label: t('common.installMethod'), value: t('desktop.label') },
          { label: t('desktop.basePath'), value: installation.installPath || '—' },
          ...(execPath
            ? [{ label: t('desktop.executable'), value: execPath }]
            : []),
          { label: t('desktop.tracked'), value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
      {
        title: 'Actions',
        pinBottom: true,
        actions: [
          {
            id: 'migrate-to-standalone',
            label: t('desktop.migrateToStandalone'),
            style: 'default',
            enabled: installation.status === 'installed',
            showProgress: true,
            progressTitle: t('desktop.migrating'),
            cancellable: true,
            confirm: {
              title: t('desktop.migrateConfirmTitle'),
              message: t('desktop.migrateConfirmMessage'),
              confirmLabel: t('desktop.migrateConfirm'),
            },
          },
          {
            id: 'open-folder',
            label: t('actions.openDirectory'),
            style: 'default',
            enabled: !!installation.installPath,
          },
          untrackAction(),
        ],
      },
    ]
  },

  probeInstallation(dirPath: string): Record<string, unknown> | null {
    const hasModels = fs.existsSync(path.join(dirPath, 'models'))
    const hasUser = fs.existsSync(path.join(dirPath, 'user'))
    const hasVenv = fs.existsSync(path.join(dirPath, '.venv'))
    const hasStandaloneEnv = fs.existsSync(path.join(dirPath, 'standalone-env'))

    if (!hasModels || !hasUser) return null
    if (hasStandaloneEnv) return null
    if (!hasVenv) return null

    return {
      version: 'desktop',
      launchMode: 'external',
      useSharedPaths: false,
      desktopExePath: findDesktopExecutable() || undefined,
    }
  },

  async handleAction(
    actionId: string,
    installation: InstallationRecord,
    _actionData: Record<string, unknown> | undefined,
    _tools: ActionTools
  ): Promise<ActionResult> {
    if (actionId === 'open-folder') {
      if (installation.installPath) {
        await shell.openPath(installation.installPath)
        return { ok: true }
      }
      return { ok: false, message: 'No install path.' }
    }

    return { ok: false, message: `Action "${actionId}" not implemented.` }
  },

  async getFieldOptions(): Promise<FieldOption[]> {
    return []
  },
}
