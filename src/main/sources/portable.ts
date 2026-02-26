import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fetchJSON } from '../lib/fetch'
import { deleteAction, untrackAction } from '../lib/actions'
import { downloadAndExtract } from '../lib/installer'
import * as releaseCache from '../lib/release-cache'
import { parseArgs } from '../lib/util'
import { t } from '../lib/i18n'
import { truncateNotes } from '../lib/comfyui-releases'
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
    const track = (installation.updateTrack as string | undefined) || 'stable'
    const info = releaseCache.getEffectiveInfo(COMFYUI_REPO, track, installation)
    if (info && releaseCache.isUpdateAvailable(installation, track, info)) {
      return { label: t('portable.updateAvailableTag', { version: info.releaseName || info.latestTag || '' }), style: 'update' }
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
    const portIdx = parsed.indexOf('--port')
    const portArg = portIdx >= 0 ? parsed[portIdx + 1] : undefined
    const port = portArg ? parseInt(portArg, 10) || 8188 : 8188
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
      { id: 'launch', label: t('actions.launch'), style: 'primary', enabled: installed,
        ...(!installed && { disabledMessage: t('errors.installNotReady') }),
        showProgress: true, progressTitle: t('common.startingComfyUI'), cancellable: true },
    ]
  },

  getDetailSections(installation: InstallationRecord): Record<string, unknown>[] {
    const installed = installation.status === 'installed'
    const sections: Record<string, unknown>[] = [
      {
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
    const track = (installation.updateTrack as string | undefined) || 'stable'
    const info = releaseCache.getEffectiveInfo(COMFYUI_REPO, track, installation)

    // Build per-track preview info for cards
    const trackOptions = [
      { value: 'stable', label: t('portable.trackStable'), description: t('portable.trackStableDesc'), recommended: true },
      { value: 'latest', label: t('portable.trackLatest'), description: t('portable.trackLatestDesc') },
    ].map((opt) => {
      const trackInfo = releaseCache.getEffectiveInfo(COMFYUI_REPO, opt.value, installation)
      return {
        ...opt,
        data: trackInfo ? {
          installedVersion: trackInfo.installedTag || (installation.version as string | undefined) || 'unknown',
          latestVersion: trackInfo.releaseName || trackInfo.latestTag || '—',
          lastChecked: trackInfo.checkedAt ? new Date(trackInfo.checkedAt).toLocaleString() : '—',
          updateAvailable: releaseCache.isUpdateAvailable(installation, opt.value, trackInfo),
        } : undefined,
      }
    })

    const updateFields: Record<string, unknown>[] = [
      { id: 'updateTrack', label: t('portable.updateTrack'), value: track, editable: true,
        refreshSection: true, onChangeAction: 'check-update', editType: 'track-cards', options: trackOptions },
    ]
    const updateActions: Record<string, unknown>[] = []
    if (info && releaseCache.isUpdateAvailable(installation, track, info)) {
      const msgKey = track === 'latest' ? 'portable.updateConfirmMessageLatest' : 'portable.updateConfirmMessage'
      const notes = truncateNotes(info.releaseNotes || '', 2000)
      updateActions.push({
        id: 'update-comfyui', label: t('portable.updateNow'), style: 'primary', enabled: installed,
        showProgress: true, progressTitle: t('portable.updatingTitle', { version: info.latestTag || '' }),
        confirm: {
          title: t('portable.updateConfirmTitle'),
          message: t(msgKey, {
            installed: info.installedTag || installation.version || '',
            latest: info.latestTag || '',
            commit: notes || '',
            notes: notes || '(none)',
          }),
        },
      })
    }
    updateActions.push({
      id: 'check-update', label: t('actions.checkForUpdate'), style: 'default', enabled: installed,
    })
    sections.push({
      title: t('portable.updates'),
      fields: updateFields,
      actions: updateActions,
    })

    sections.push(
      {
        title: t('common.launchSettings'),
        fields: [
          { id: 'useSharedPaths', label: t('common.useSharedPaths'), value: (installation.useSharedPaths as boolean | undefined) !== false, editable: true, editType: 'boolean' },
          { id: 'launchArgs', label: t('common.startupArgs'), value: (installation.launchArgs as string | undefined) ?? DEFAULT_LAUNCH_ARGS, editable: true },
          { id: 'launchMode', label: t('common.launchMode'), value: (installation.launchMode as string | undefined) || 'window', editable: true,
            editType: 'select', options: [
              { value: 'window', label: t('common.launchModeWindow') },
              { value: 'console', label: t('common.launchModeConsole') },
            ] },
          { id: 'browserPartition', label: t('common.browserPartition'), value: (installation.browserPartition as string | undefined) || 'shared', editable: true,
            editType: 'select', options: [
              { value: 'shared', label: t('common.partitionShared') },
              { value: 'unique', label: t('common.partitionUnique') },
            ] },
          { id: 'portConflict', label: t('common.portConflict'), value: (installation.portConflict as string | undefined) || 'ask', editable: true,
            editType: 'select', options: [
              { value: 'ask', label: t('common.portConflictAsk') },
              { value: 'auto', label: t('common.portConflictAuto') },
            ] },
        ],
      },
      {
        title: 'Actions',
        pinBottom: true,
        actions: [
          { id: 'launch', label: t('actions.launch'), style: 'primary', enabled: installed,
            ...(!installed && { disabledMessage: t('errors.installNotReady') }),
            showProgress: true, progressTitle: t('common.startingComfyUI'), cancellable: true },
          { id: 'open-folder', label: t('actions.openDirectory'), style: 'default', enabled: !!installation.installPath },
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
    _actionData: Record<string, unknown> | undefined,
    { update, sendProgress, sendOutput }: ActionTools,
  ): Promise<ActionResult> {
    if (actionId === 'check-update') {
      const track = (installation.updateTrack as string | undefined) || 'stable'
      return releaseCache.checkForUpdate(COMFYUI_REPO, track, installation, update)
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

      const track = (installation.updateTrack as string | undefined) || 'stable'
      const stableArgs = track === 'stable' ? ['--stable'] : []

      sendProgress('steps', { steps: [
        { phase: 'prepare', label: t('portable.updatePrepare') },
        { phase: 'run', label: t('portable.updateRun') },
        { phase: 'deps', label: t('portable.updateDeps') },
      ] })

      sendProgress('prepare', { percent: -1, status: 'Checking for updater updates…' })
      sendProgress('run', { percent: -1, status: 'Running update…' })

      const runUpdateScript = (extraArgs: string[]): Promise<number> => {
        return new Promise<number>((resolve) => {
          const proc = spawn(pythonExe, ['-s', updateScript, comfyuiDir, ...extraArgs, ...stableArgs], {
            cwd: updateDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
          proc.stdout.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
          proc.stderr.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
          proc.on('error', (err: Error) => {
            sendOutput(`Error: ${err.message}\n`)
            resolve(1)
          })
          proc.on('exit', (code: number | null) => resolve(code ?? 1))
        })
      }

      const exitCode = await runUpdateScript([])

      if (exitCode !== 0) {
        const updateNewPy = path.join(updateDir, 'update_new.py')
        if (!fs.existsSync(updateNewPy)) {
          return { ok: false, message: t('portable.updateFailed', { code: exitCode }) }
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
        const exitCode2 = await runUpdateScript(['--skip_self_update'])
        if (exitCode2 !== 0) {
          return { ok: false, message: t('portable.updateFailed', { code: exitCode2 }) }
        }
      }

      sendProgress('deps', { percent: -1, status: 'Dependencies checked.' })

      const cachedRelease = releaseCache.get(COMFYUI_REPO, track)
      const latestTag = (cachedRelease?.latestTag as string | undefined) || (installation.version ?? 'unknown')
      const existing = (installation.updateInfoByTrack as Record<string, Record<string, unknown>> | undefined) || {}
      await update({
        version: latestTag,
        updateInfoByTrack: {
          ...existing,
          [track]: { installedTag: latestTag },
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
