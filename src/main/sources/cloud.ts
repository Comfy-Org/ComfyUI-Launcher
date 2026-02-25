import { untrackAction } from '../lib/actions'
import { parseUrl } from '../lib/util'
import { t } from '../lib/i18n'
import type { InstallationRecord } from '../installations'
import type { SourcePlugin, FieldOption, ActionResult, ActionTools, LaunchCommand } from '../types/sources'

const DEFAULT_URL = 'https://cloud.comfy.org/'

export const cloud: SourcePlugin = {
  id: 'cloud',
  get label() { return t('cloud.label') },
  get description() { return t('cloud.desc') },
  category: 'cloud',
  hasConsole: false,
  skipInstall: true,

  get fields() {
    return [
      { id: 'url', label: t('remote.comfyuiUrl'), type: 'text' as const, defaultValue: DEFAULT_URL },
    ]
  },

  getDefaults() {
    return { launchMode: 'window', browserPartition: 'shared' }
  },

  buildInstallation(selections: Record<string, FieldOption | undefined>): Record<string, unknown> {
    const url = selections.url?.value || DEFAULT_URL
    const parsed = parseUrl(url)
    return {
      version: 'cloud',
      remoteUrl: parsed ? parsed.href : url,
      launchMode: 'window',
      browserPartition: 'shared',
    }
  },

  getListPreview(installation: InstallationRecord): string | null {
    return (installation.remoteUrl as string) || null
  },

  getLaunchCommand(installation: InstallationRecord): LaunchCommand | null {
    const parsed = parseUrl(installation.remoteUrl as string)
    if (!parsed) return null
    return {
      remote: true,
      url: parsed.href,
      host: parsed.hostname,
      port: parsed.port,
    }
  },

  getListActions(installation: InstallationRecord): Record<string, unknown>[] {
    return [
      { id: 'launch', label: t('actions.connect'), style: 'primary', enabled: installation.status === 'installed',
        showProgress: true, progressTitle: t('actions.connecting'), cancellable: true },
    ]
  },

  getDetailSections(installation: InstallationRecord): Record<string, unknown>[] {
    return [
      {
        title: t('remote.connectionInfo'),
        fields: [
          { label: t('common.installMethod'), value: installation.sourceLabel as string },
          { id: 'remoteUrl', label: t('remote.url'), value: (installation.remoteUrl as string) || '—', editable: true },
          { label: t('remote.added'), value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
      {
        title: t('common.launchSettings'),
        fields: [
          { id: 'browserPartition', label: t('common.browserPartition'), value: (installation.browserPartition as string) || 'shared', editable: true,
            editType: 'select', options: [
              { value: 'shared', label: t('common.partitionShared') },
              { value: 'unique', label: t('common.partitionUnique') },
            ] },
        ],
      },
      {
        title: 'Actions',
        pinBottom: true,
        actions: [
          { id: 'launch', label: t('actions.connect'), style: 'primary', enabled: installation.status === 'installed',
            showProgress: true, progressTitle: t('actions.connecting'), cancellable: true },
          untrackAction(),
        ],
      },
    ]
  },

  probeInstallation(_dirPath: string): Record<string, unknown> | null {
    return null
  },

  async handleAction(
    actionId: string,
    _installation: InstallationRecord,
    _actionData: Record<string, unknown> | undefined,
    _tools: ActionTools
  ): Promise<ActionResult> {
    return { ok: false, message: `Action "${actionId}" not yet implemented.` }
  },

  async getFieldOptions(
    _fieldId: string,
    _selections: Record<string, FieldOption | undefined>,
    _context: Record<string, unknown>
  ): Promise<FieldOption[]> {
    return []
  },
}


