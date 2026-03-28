import { untrackAction } from '../../lib/actions'
import { parseUrl } from '../../lib/util'
import { t } from '../../lib/i18n'
import type { InstallationRecord } from '../../installations'
import type { SourcePlugin, FieldOption, ActionResult, ActionTools, LaunchCommand } from '../../types/sources'

export interface UrlSourceConfig {
  id: string
  labelKey: string
  descKey: string
  category: 'remote' | 'cloud'
  defaultUrl: string
  /** Transform the stored URL before building the launch command (e.g., append UTM params). */
  transformUrl?: (url: string) => string
  /** Whether the URL field is editable in the detail section. */
  editableUrl?: boolean
  /** Whether to include the untrack action in the detail section. */
  includeUntrack?: boolean
}

export function createUrlSource(config: UrlSourceConfig): SourcePlugin {
  const {
    id, labelKey, descKey, category, defaultUrl,
    transformUrl, editableUrl = false, includeUntrack = false,
  } = config

  return {
    id,
    get label() { return t(labelKey) },
    get description() { return t(descKey) },
    category,
    hasConsole: false,
    skipInstall: true,

    get fields() {
      return [
        { id: 'url', label: t('remote.comfyuiUrl'), type: 'text' as const, defaultValue: defaultUrl },
      ]
    },

    getDefaults() {
      return { launchMode: 'window', browserPartition: 'shared' }
    },

    buildInstallation(selections: Record<string, FieldOption | undefined>): Record<string, unknown> {
      const url = selections.url?.value || defaultUrl
      const parsed = parseUrl(url)
      return {
        ...(category === 'remote' ? { version: 'remote' } : {}),
        remoteUrl: parsed ? parsed.href : url,
        launchMode: 'window',
        browserPartition: 'shared',
      }
    },

    getListPreview(installation: InstallationRecord): string | null {
      return (installation.remoteUrl as string) || null
    },

    getLaunchCommand(installation: InstallationRecord): LaunchCommand | null {
      const rawUrl = (installation.remoteUrl as string) || defaultUrl
      const finalUrl = transformUrl ? transformUrl(rawUrl) : rawUrl
      const parsed = parseUrl(finalUrl)
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
      const urlField: Record<string, unknown> = editableUrl
        ? { id: 'remoteUrl', label: t('remote.url'), value: (installation.remoteUrl as string) || '—', editable: true }
        : { label: t('remote.url'), value: (installation.remoteUrl as string) || '—' }

      const actions: Record<string, unknown>[] = [
        { id: 'launch', label: t('actions.connect'), style: 'primary', enabled: installation.status === 'installed',
          showProgress: true, progressTitle: t('actions.connecting'), cancellable: true },
      ]
      if (includeUntrack) {
        actions.push(untrackAction())
      }

      return [
        {
          tab: 'status',
          title: t('remote.connectionInfo'),
          fields: [
            { label: t('common.installMethod'), value: installation.sourceLabel as string },
            urlField,
            { label: t('remote.added'), value: new Date(installation.createdAt).toLocaleDateString() },
          ],
        },
        {
          tab: 'settings',
          title: t('common.launchSettings'),
          fields: [
            { id: 'browserPartition', label: t('common.browserPartition'), value: (installation.browserPartition as string) || 'shared', editable: true,
              editType: 'select', options: [
                { value: 'shared', label: t('common.partitionShared') },
                { value: 'unique', label: t('common.partitionUnique') },
              ], tooltip: t('tooltips.browserPartition') },
          ],
        },
        {
          title: 'Actions',
          pinBottom: true,
          actions,
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
}
