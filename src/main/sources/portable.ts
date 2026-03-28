import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { fetchJSON } from '../lib/fetch'
import { deleteAction, untrackAction, launchAction, openFolderAction, migrateToStandaloneAction } from '../lib/actions'
import { downloadAndExtract } from '../lib/installer'
import { runLoggedProcess, formatProcessError } from '../lib/logged-process'
import * as releaseCache from '../lib/release-cache'
import { parseArgs, extractPort } from '../lib/util'
import { t } from '../lib/i18n'
import { fetchLatestRelease, truncateNotes } from '../lib/comfyui-releases'
import { buildChannelCards, buildChannelLabelMap } from '../lib/channel-cards'
import type { ChannelDef } from '../lib/channel-cards'
import { buildLaunchSettingsFields } from './common/launchSettingsFields'
import type { InstallationRecord } from '../installations'
import type {
  SourcePlugin,
  FieldOption,
  ActionResult,
  ActionTools,
  InstallTools,
  LaunchCommand,
  StatusTag,
} from '../types/sources'

const COMFYUI_REPO = 'Comfy-Org/ComfyUI'
const DEFAULT_LAUNCH_ARGS = '--windows-standalone-build --disable-auto-launch'

interface GitHubRelease {
  tag_name: string
  name: string
  assets: GitHubAsset[]
}

interface GitHubAsset {
  name: string
  browser_download_url: string
  size: number
}

function findPortableRoot(installPath: string): string | null {
  if (fs.existsSync(path.join(installPath, 'python_embeded'))) return installPath
  const entries = fs.readdirSync(installPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sub = path.join(installPath, entry.name)
      if (fs.existsSync(path.join(sub, 'python_embeded'))) return sub
    }
  }
  return null
}

export const portable: SourcePlugin = {
  id: 'portable',
  get label() { return t('portable.label') },
  get description() { return t('portable.desc') },
  category: 'local',
  platforms: ['win32'],
  hidden: app.isPackaged,

  get fields() {
    return [
      { id: 'release', label: t('common.release'), type: 'select' as const },
      { id: 'asset', label: t('portable.package'), type: 'select' as const },
    ]
  },

  defaultLaunchArgs: DEFAULT_LAUNCH_ARGS,

  get installSteps() {
    return [
      { phase: 'download', label: t('common.download') },
      { phase: 'extract', label: t('common.extract') },
    ]
  },

  getDefaults() {
    return { launchArgs: DEFAULT_LAUNCH_ARGS, launchMode: 'window', portConflict: 'auto' }
  },

  getStatusTag(installation: InstallationRecord): StatusTag | undefined {
    const channel = (installation.updateChannel as string | undefined) || 'stable'
    const info = releaseCache.getEffectiveInfo(COMFYUI_REPO, channel, installation)
    if (info && releaseCache.isUpdateAvailable(installation, channel, info)) {
      return { label: t('portable.updateAvailableTag', { version: info.releaseName || info.latestTag || '' }), style: 'update' }
    }
    if (installation.status === 'installed') {
      return { label: t('migrate.migrateToStandalonePill'), style: 'migrate' }
    }
    return undefined
  },

  buildInstallation(selections: Record<string, FieldOption | undefined>): Record<string, unknown> {
    return {
      version: selections.release?.value || 'unknown',
      asset: (selections.asset?.data as GitHubAsset | undefined)?.name ?? '',
      downloadUrl: selections.asset?.value || '',
      launchArgs: DEFAULT_LAUNCH_ARGS,
      launchMode: 'window',
      browserPartition: 'unique',
    }
  },

  getLaunchCommand(installation: InstallationRecord): LaunchCommand | null {
    const root = findPortableRoot(installation.installPath)
    if (!root) return null
    const userArgs = ((installation.launchArgs as string | undefined) ?? DEFAULT_LAUNCH_ARGS).trim()
    const parsed = userArgs.length > 0 ? parseArgs(userArgs) : []
    const port = extractPort(parsed)
    return {
      cmd: path.join(root, 'python_embeded', 'python.exe'),
      args: ['-s', path.join(root, 'ComfyUI', 'main.py'), ...parsed],
      cwd: root,
      port,
    }
  },

  getListActions(installation: InstallationRecord): Record<string, unknown>[] {
    const installed = installation.status === 'installed'
    return [
      launchAction(installed, !installed ? t('errors.installNotReady') : undefined),
    ]
  },

  getDetailSections(installation: InstallationRecord): Record<string, unknown>[] {
    const installed = installation.status === 'installed'
    const sections: Record<string, unknown>[] = [
      {
        tab: 'status',
        title: t('common.installInfo'),
        fields: [
          { label: t('common.installMethod'), value: installation.sourceLabel as string },
          { label: t('portable.version'), value: installation.version },
          { label: t('portable.packageLabel'), value: (installation.asset as string | undefined) || '—' },
          { label: t('common.location'), value: installation.installPath || '—' },
          { label: t('common.installed'), value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
    ]

    // Updates section
    const channel = (installation.updateChannel as string | undefined) || 'stable'

    // Build per-channel preview info and actions for cards
    const channelDefs: ChannelDef[] = [
      { value: 'stable', label: t('portable.channelStable'), description: t('portable.channelStableDesc'), recommended: true },
      { value: 'latest', label: t('portable.channelLatest'), description: t('portable.channelLatestDesc') },
    ]
    const channelLabelMap = buildChannelLabelMap(channelDefs)
    const baseCards = buildChannelCards(COMFYUI_REPO, channelDefs, installation)

    const channelOptions = baseCards.map((card) => {
      const actions: Record<string, unknown>[] = []
      if (card.data?.updateAvailable) {
        const channelInfo = releaseCache.getEffectiveInfo(COMFYUI_REPO, card.value, installation)!
        const isSwitching = card.value !== channel
        const msgKey = card.value === 'latest' ? 'portable.updateConfirmMessageLatest' : 'portable.updateConfirmMessage'
        const notes = truncateNotes(channelInfo.releaseNotes || '', 2000)
        const notesDetails = notes ? [{ label: t('portable.releaseNotesLabel'), items: [notes] }] : undefined
        const switchPrefix = isSwitching
          ? t('channelCards.switchChannelPrefix', { from: `**${channelLabelMap[channel] || channel}**`, to: `**${card.label}**` })
          : ''
        const boldInstalled = `**${channelInfo.installedTag || (installation.releaseTag as string | undefined) || ''}**`
        const boldLatest = `**${channelInfo.latestTag || ''}**`
        const confirmMessage = t(msgKey, {
          installed: boldInstalled,
          latest: boldLatest,
        })
        actions.push({
          id: 'update-comfyui', label: t('portable.updateNow'), style: 'primary', enabled: installed,
          tooltip: t('tooltips.updateNow'),
          showProgress: true, progressTitle: t('portable.updatingTitle', { version: channelInfo.latestTag || '' }),
          data: isSwitching ? { channel: card.value } : undefined,
          confirm: {
            title: t('portable.updateConfirmTitle'),
            message: switchPrefix + confirmMessage,
            messageDetails: notesDetails,
          },
        })
      } else if (card.value !== channel) {
        actions.push({
          id: 'switch-channel', label: t('channelCards.switchChannelOnly'), style: 'default', enabled: installed,
          data: { channel: card.value },
        })
      }
      return { ...card, data: card.data ? { ...card.data, actions: actions.length ? actions : undefined } : undefined }
    })

    const updateFields: Record<string, unknown>[] = [
      { id: 'updateChannel', label: t('portable.updateChannel'), value: channel, editable: true,
        refreshSection: true, onChangeAction: 'check-update', editType: 'channel-cards', options: channelOptions, tooltip: t('tooltips.updateChannel') },
    ]
    const updateActions: Record<string, unknown>[] = [
      { id: 'check-update', label: t('actions.checkForUpdate'), style: 'default', enabled: installed },
    ]
    sections.push({
      tab: 'update',
      title: t('portable.updates'),
      fields: updateFields,
      actions: updateActions,
    })

    sections.push(
      {
        tab: 'settings',
        title: t('common.launchSettings'),
        fields: buildLaunchSettingsFields(installation, { defaultLaunchArgs: DEFAULT_LAUNCH_ARGS, defaultBrowserPartition: 'unique' }),
      },
      {
        title: 'Actions',
        pinBottom: true,
        actions: [
          launchAction(installed, !installed ? t('errors.installNotReady') : undefined),
          openFolderAction(installation.installPath),
          migrateToStandaloneAction(installed),
          deleteAction(installation),
          untrackAction(),
        ],
      },
    )

    return sections
  },

  async install(installation: InstallationRecord, tools: InstallTools): Promise<void> {
    const cacheKey = `${installation.version ?? ''}_${(installation.asset as string | undefined) ?? ''}`
    await downloadAndExtract(installation.downloadUrl as string, installation.installPath, cacheKey, tools)
  },

  probeInstallation(dirPath: string): Record<string, unknown> | null {
    if (findPortableRoot(dirPath)) return { version: 'unknown', asset: '', launchArgs: DEFAULT_LAUNCH_ARGS, launchMode: 'window', browserPartition: 'unique' }
    return null
  },

  async handleAction(
    actionId: string,
    installation: InstallationRecord,
    actionData: Record<string, unknown> | undefined,
    { update, sendProgress, sendOutput }: ActionTools,
  ): Promise<ActionResult> {
    if (actionId === 'switch-channel') {
      const targetChannel = actionData?.channel as string | undefined
      if (!targetChannel) return { ok: false, message: 'No channel specified.' }
      await update({ updateChannel: targetChannel })
      return { ok: true, navigate: 'detail' }
    }

    if (actionId === 'check-update') {
      const channel = (installation.updateChannel as string | undefined) || 'stable'
      const otherChannels = ['stable', 'latest'].filter((ch) => ch !== channel)
      await Promise.allSettled(
        otherChannels.map((ch) =>
          releaseCache.getOrFetch(COMFYUI_REPO, ch, async () => {
            const release = await fetchLatestRelease(ch)
            if (!release) return null
            return {
              checkedAt: Date.now(),
              latestTag: release.tag_name as string,
              releaseName: (release.name as string) || (release.tag_name as string),
              releaseNotes: truncateNotes(release.body as string, 4000),
              releaseUrl: release.html_url as string,
              publishedAt: release.published_at as string,
            }
          }, true)
        )
      )
      const result = await releaseCache.checkForUpdate(COMFYUI_REPO, channel, installation, update)
      const root = findPortableRoot(installation.installPath)
      if (root) await releaseCache.enrichCommitsAhead(COMFYUI_REPO, path.join(root, 'ComfyUI'))
      return result
    }

    if (actionId === 'update-comfyui') {
      const root = findPortableRoot(installation.installPath)
      if (!root) {
        return { ok: false, message: t('portable.noUpdateDir') }
      }
      const updateDir = path.join(root, 'update')
      const pythonExe = path.join(root, 'python_embeded', 'python.exe')
      const updateScript = path.join(updateDir, 'update.py')
      const comfyuiDir = path.join(root, 'ComfyUI') + path.sep

      if (!fs.existsSync(updateScript)) {
        return { ok: false, message: t('portable.noUpdateDir') }
      }

      const targetChannel = (actionData?.channel as string | undefined) ?? (installation.updateChannel as string | undefined) ?? 'stable'
      if (targetChannel !== (installation.updateChannel as string | undefined)) {
        await update({ updateChannel: targetChannel })
      }
      const channel = targetChannel
      const stableArgs = channel === 'stable' ? ['--stable'] : []

      sendProgress('steps', { steps: [
        { phase: 'prepare', label: t('portable.updatePrepare') },
        { phase: 'run', label: t('portable.updateRun') },
        { phase: 'deps', label: t('portable.updateDeps') },
      ] })

      sendProgress('prepare', { percent: -1, status: 'Checking for updater updates…' })
      sendProgress('run', { percent: -1, status: 'Running update…' })

      const runUpdate = (extraArgs: string[]) =>
        runLoggedProcess(pythonExe, ['-s', updateScript, comfyuiDir, ...extraArgs, ...stableArgs], { cwd: updateDir, sendOutput })

      const errorContext = { cmd: pythonExe, script: updateScript }

      const result = await runUpdate([])

      if (result.exitCode !== 0) {
        const updateNewPy = path.join(updateDir, 'update_new.py')
        if (!fs.existsSync(updateNewPy)) {
          return { ok: false, message: formatProcessError(t('portable.updateFailed', { code: result.exitCode }), result, errorContext) }
        }
      }

      const updateNewPy = path.join(updateDir, 'update_new.py')
      if (fs.existsSync(updateNewPy)) {
        try {
          fs.renameSync(updateNewPy, updateScript)
          sendOutput('\nUpdater script updated — re-running…\n\n')
        } catch (err) {
          sendOutput(`Warning: could not replace updater: ${(err as Error).message}\n`)
        }
        const result2 = await runUpdate(['--skip_self_update'])
        if (result2.exitCode !== 0) {
          return { ok: false, message: formatProcessError(t('portable.updateFailed', { code: result2.exitCode }), result2, errorContext) }
        }
      }

      sendProgress('deps', { percent: -1, status: 'Dependencies checked.' })

      const cachedRelease = releaseCache.get(COMFYUI_REPO, channel)
      const latestTag = (cachedRelease?.latestTag as string | undefined) || (installation.version ?? 'unknown')
      const existing = (installation.updateInfoByChannel as Record<string, Record<string, unknown>> | undefined) || {}
      await update({
        version: latestTag,
        updateInfoByChannel: {
          ...existing,
          [channel]: { installedTag: latestTag },
        },
      })

      sendProgress('done', { percent: 100, status: 'Complete' })
      return { ok: true, navigate: 'detail' }
    }

    return { ok: false, message: `Action "${actionId}" not yet implemented.` }
  },

  async getFieldOptions(
    fieldId: string,
    selections: Record<string, FieldOption | undefined>,
    context: Record<string, unknown>,
  ): Promise<FieldOption[]> {
    if (fieldId === 'release') {
      const releases = await fetchJSON(
        'https://api.github.com/repos/Comfy-Org/ComfyUI/releases?per_page=30',
      ) as GitHubRelease[]
      return releases.map((r) => ({
        value: r.tag_name,
        label: r.name && r.name !== r.tag_name ? `${r.tag_name}  —  ${r.name}` : r.tag_name,
        data: r as unknown as Record<string, unknown>,
      }))
    }

    if (fieldId === 'asset') {
      const release = selections.release?.data as { assets: GitHubAsset[] } | undefined
      if (!release) return []
      const gpu = context.gpu as string | undefined
      return release.assets
        .filter((a) => a.name.endsWith('.7z'))
        .map((a) => ({
          value: a.browser_download_url,
          label: `${a.name}  (${(a.size / 1048576).toFixed(0)} MB)`,
          data: a as unknown as Record<string, unknown>,
          recommended: gpu ? a.name.toLowerCase().includes(gpu) : false,
        }))
    }

    return []
  },
}
