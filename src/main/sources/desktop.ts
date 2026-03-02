import fs from 'fs'
import path from 'path'
import { shell } from 'electron'
import { untrackAction } from '../lib/actions'
import { detectDesktopInstall, findDesktopExecutable } from '../lib/desktopDetect'
import { t } from '../lib/i18n'
import type { InstallationRecord } from '../installations'
import type {
  SourcePlugin,
  FieldOption,
  ActionResult,
  ActionTools,
  LaunchCommand,
} from '../types/sources'

export const desktop: SourcePlugin = {
  id: 'desktop',
  get label() { return t('desktop.label') },
  get description() { return t('desktop.desc') },
  category: 'local',
  hasConsole: false,
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
    }
  },

  getListPreview(installation: InstallationRecord): string | null {
    return installation.installPath || null
  },

  getLaunchCommand(installation: InstallationRecord): LaunchCommand | null {
    const execPath = (installation.desktopExePath as string | undefined) || findDesktopExecutable()
    if (!execPath || !fs.existsSync(execPath)) return null
    return {
      cmd: execPath,
      args: [],
      cwd: path.dirname(execPath),
    }
  },

  getListActions(installation: InstallationRecord): Record<string, unknown>[] {
    const execPath = (installation.desktopExePath as string | undefined) || findDesktopExecutable()
    return [
      {
        id: 'open-desktop',
        label: t('desktop.openApp'),
        style: 'primary',
        enabled: installation.status === 'installed' && !!execPath,
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
            id: 'open-desktop',
            label: t('desktop.openApp'),
            style: 'primary',
            enabled: !!execPath,
          },
          {
            id: 'open-folder',
            label: t('actions.openFolder'),
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
      desktopExePath: findDesktopExecutable() || undefined,
    }
  },

  async handleAction(
    actionId: string,
    installation: InstallationRecord,
    _actionData: Record<string, unknown> | undefined,
    _tools: ActionTools
  ): Promise<ActionResult> {
    if (actionId === 'open-desktop') {
      const execPath = (installation.desktopExePath as string | undefined) || findDesktopExecutable()
      if (!execPath) return { ok: false, message: t('desktop.notFound') }
      const err = await shell.openPath(execPath)
      if (err) return { ok: false, message: err }
      return { ok: true }
    }

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

export function autoDetectDesktop(): {
  installPath: string
  data: Record<string, unknown>
} | null {
  const info = detectDesktopInstall()
  if (!info) return null
  return {
    installPath: info.basePath,
    data: {
      version: 'desktop',
      launchMode: 'external',
      desktopExePath: info.executablePath || undefined,
    },
  }
}
