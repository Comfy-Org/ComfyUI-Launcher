import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { spawn, execFile } from 'child_process'
import { fetchJSON } from '../lib/fetch'
import { fetchLatestRelease, truncateNotes } from '../lib/comfyui-releases'
import * as releaseCache from '../lib/release-cache'
import { buildChannelCards, buildChannelLabelMap } from '../lib/channel-cards'
import type { ChannelDef } from '../lib/channel-cards'
import { formatComfyVersion } from '../lib/version'
import type { ComfyVersion } from '../lib/version'
import { deleteAction, untrackAction } from '../lib/actions'
import { downloadAndExtract, downloadAndExtractMulti } from '../lib/installer'
import { copyDirWithProgress } from '../lib/copy'
import { readGitHead, isGitAvailable, isPygit2Configured, tryConfigurePygit2Fallback, fetchTags } from '../lib/git'
import { resolveLocalVersion, clearVersionCache } from '../lib/version-resolve'
import { parseArgs, extractPort, formatTime } from '../lib/util'
import { PYTORCH_RE, installFilteredRequirements, getPipIndexArgs } from '../lib/pip'
import { t } from '../lib/i18n'
import * as installations from '../installations'
import { listCustomNodes, findComfyUIDir, backupDir, mergeDirFlat } from '../lib/migrate'
import * as settings from '../settings'
import * as snapshots from '../lib/snapshots'
import type { InstallationRecord } from '../installations'
import type {
  SourcePlugin,
  FieldOption,
  ActionResult,
  ActionTools,
  InstallTools,
  PostInstallTools,
  LaunchCommand,
  StatusTag,
} from '../types/sources'

const COMFYUI_REPO = 'Comfy-Org/ComfyUI'
const RELEASE_REPO = 'Comfy-Org/ComfyUI-Standalone-Environments'
const ENVS_DIR = 'envs'
const DEFAULT_ENV = 'default'
const ENV_METHOD = 'copy'
const MANIFEST_FILE = 'manifest.json'
const DEFAULT_LAUNCH_ARGS = '--enable-manager'

const VARIANT_LABELS: Record<string, string> = {
  'nvidia': 'NVIDIA',
  'intel-xpu': 'Intel Arc (XPU)',
  'amd': 'AMD',
  'cpu': 'CPU',
  'mps': 'Apple Silicon (MPS)',
}

const PLATFORM_PREFIX: Record<string, string> = {
  win32: 'win-',
  darwin: 'mac-',
  linux: 'linux-',
}

function getChannelDefs(): ChannelDef[] {
  return [
    { value: 'stable', label: t('standalone.channelStable'), description: t('standalone.channelStableDesc'), recommended: true },
    { value: 'latest', label: t('standalone.channelLatest'), description: t('standalone.channelLatestDesc') },
  ]
}

function getChannelLabel(channel: string): string {
  const map = buildChannelLabelMap(getChannelDefs())
  return map[channel] || channel
}

function stripPlatform(variantId: string): string {
  return variantId.replace(/^(win|mac|linux)-/, '')
}

export function getVariantLabel(variantId: string): string {
  const stripped = stripPlatform(variantId)
  if (VARIANT_LABELS[stripped]) return VARIANT_LABELS[stripped]!
  for (const [key, label] of Object.entries(VARIANT_LABELS)) {
    if (stripped === key || stripped.startsWith(key + '-')) {
      const suffix = stripped.slice(key.length + 1)
      return suffix ? `${label} (${suffix.toUpperCase()})` : label
    }
  }
  return stripped
}

function getUvPath(installPath: string): string {
  if (process.platform === 'win32') {
    return path.join(installPath, 'standalone-env', 'uv.exe')
  }
  return path.join(installPath, 'standalone-env', 'bin', 'uv')
}

function findSitePackages(envRoot: string): string | null {
  if (process.platform === 'win32') {
    return path.join(envRoot, 'Lib', 'site-packages')
  }
  const libDir = path.join(envRoot, 'lib')
  try {
    const pyDir = fs.readdirSync(libDir).find((d) => d.startsWith('python'))
    if (pyDir) return path.join(libDir, pyDir, 'site-packages')
  } catch {}
  return null
}

async function removeQuarantine(dir: string, log?: (text: string) => void): Promise<void> {
  if (process.platform !== 'darwin') return
  await new Promise<void>((resolve) => {
    execFile('xattr', ['-dr', 'com.apple.quarantine', dir], (err) => {
      if (err && log) log(`⚠ removeQuarantine: ${err.message}\n`)
      resolve()
    })
  })
}

async function repairMacBinaries(
  installPath: string,
  sendProgress: (step: string, data: { percent: number; status: string; [key: string]: unknown }) => void,
  sendOutput?: (text: string) => void
): Promise<void> {
  if (process.platform !== 'darwin') return
  const standaloneEnvDir = path.join(installPath, 'standalone-env')
  sendProgress('repair', { percent: -1, status: 'Removing quarantine flags…' })
  await removeQuarantine(standaloneEnvDir, sendOutput)
  sendProgress('repair', { percent: -1, status: 'Codesigning binaries…' })
  await codesignBinaries(standaloneEnvDir, sendOutput)
  const envsDir = path.join(installPath, ENVS_DIR)
  if (fs.existsSync(envsDir)) {
    sendProgress('repair', { percent: -1, status: 'Codesigning environment binaries…' })
    await removeQuarantine(envsDir, sendOutput)
    await codesignBinaries(envsDir, sendOutput)
  }
}

const NON_BINARY_EXTENSIONS = new Set([
  '.py', '.pyc', '.pyo', '.pyi', '.pyd',
  '.txt', '.md', '.rst', '.json', '.yaml', '.yml', '.toml', '.cfg', '.ini', '.csv',
  '.html', '.htm', '.css', '.js', '.ts', '.xml', '.svg',
  '.h', '.c', '.cpp', '.hpp', '.pxd', '.pyx',
  '.sh', '.bat', '.ps1',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot',
  '.egg-info', '.dist-info', '.data',
  '.typed', '.LICENSE', '.license',
])

function hasNonBinaryExtension(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return NON_BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

async function isMachO(filePath: string): Promise<boolean> {
  let fh: fs.promises.FileHandle | undefined
  try {
    fh = await fs.promises.open(filePath, 'r')
    const buf = Buffer.alloc(4)
    await fh.read(buf, 0, 4, 0)
    // Mach-O magic numbers: MH_MAGIC, MH_CIGAM, MH_MAGIC_64, MH_CIGAM_64, FAT_MAGIC, FAT_CIGAM
    const magic = buf.readUInt32BE(0)
    return (
      magic === 0xfeedface || magic === 0xcefaedfe ||
      magic === 0xfeedfacf || magic === 0xcffaedfe ||
      magic === 0xcafebabe || magic === 0xbebafeca
    )
  } catch {
    return false
  } finally {
    await fh?.close()
  }
}

async function codesignBinaries(dir: string, log?: (text: string) => void): Promise<void> {
  if (process.platform !== 'darwin') return
  const CONCURRENCY = 8
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let items: fs.Dirent[]
    try { items = await fs.promises.readdir(current, { withFileTypes: true }) } catch { continue }
    const candidates: string[] = []
    for (const item of items) {
      const full = path.join(current, item.name)
      if (item.isDirectory()) {
        stack.push(full)
      } else if (item.name.endsWith('.dylib') || item.name.endsWith('.so')) {
        candidates.push(full)
      } else if (!hasNonBinaryExtension(item.name)) {
        candidates.push(full)
      }
    }
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      await Promise.all(candidates.slice(i, i + CONCURRENCY).map((f) => checkAndSign(f, log)))
    }
  }
}

async function checkAndSign(filePath: string, log?: (text: string) => void): Promise<void> {
  const name = path.basename(filePath)
  if (!name.endsWith('.dylib') && !name.endsWith('.so') && !await isMachO(filePath)) return
  return new Promise<void>((resolve) => {
    execFile('codesign', ['--force', '--sign', '-', filePath], (err) => {
      if (err && log) log(`⚠ codesign failed: ${filePath}: ${err.message}\n`)
      resolve()
    })
  })
}

const BULKY_PREFIXES = ['torch', 'nvidia', 'triton', 'cuda']

async function stripMasterPackages(installPath: string): Promise<void> {
  try {
    const sitePackages = findSitePackages(path.join(installPath, 'standalone-env'))
    if (!sitePackages || !fs.existsSync(sitePackages)) return

    const entries = await fs.promises.readdir(sitePackages, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const lower = entry.name.toLowerCase()
      if (BULKY_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
        await fs.promises.rm(path.join(sitePackages, entry.name), { recursive: true, force: true })
      }
    }
  } catch (err) {
    console.warn('Failed to strip master packages:', err)
  }
}

async function createEnv(
  installPath: string,
  envName: string,
  onProgress: (copied: number, total: number, elapsedSecs: number, etaSecs: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const uvPath = getUvPath(installPath)
  const masterPython = getMasterPythonPath(installPath)
  const envPath = path.join(installPath, ENVS_DIR, envName)
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'))
    const proc = execFile(uvPath, ['venv', '--python', masterPython, envPath], { cwd: installPath }, (err, _stdout, stderr) => {
      if (signal?.aborted) return reject(new Error('Cancelled'))
      if (err) return reject(new Error(`Failed to create environment "${envName}": ${stderr || err.message}`))
      resolve()
    })
    signal?.addEventListener('abort', () => { try { proc.kill() } catch {} }, { once: true })
  })

  try {
    const masterSitePackages = findSitePackages(path.join(installPath, 'standalone-env'))
    const envSitePackages = findSitePackages(envPath)
    if (!masterSitePackages || !envSitePackages || !fs.existsSync(masterSitePackages)) {
      throw new Error(`Could not locate site-packages for environment "${envName}".`)
    }
    await copyDirWithProgress(masterSitePackages, envSitePackages, onProgress, { signal })
    await codesignBinaries(envSitePackages)
  } catch (err) {
    await fs.promises.rm(envPath, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

function getMasterPythonPath(installPath: string): string {
  if (process.platform === 'win32') {
    return path.join(installPath, 'standalone-env', 'python.exe')
  }
  return path.join(installPath, 'standalone-env', 'bin', 'python3')
}

function getEnvPythonPath(installPath: string, envName: string): string {
  const envDir = path.join(installPath, ENVS_DIR, envName)
  if (process.platform === 'win32') {
    return path.join(envDir, 'Scripts', 'python.exe')
  }
  return path.join(envDir, 'bin', 'python3')
}

function resolveActiveEnv(installation: InstallationRecord): string | null {
  const preferred = (installation.activeEnv as string | undefined) || DEFAULT_ENV
  const envs = listEnvs(installation.installPath)
  if (envs.includes(preferred)) return preferred
  return envs.length > 0 ? envs[0]! : null
}

function getActivePythonPath(installation: InstallationRecord): string | null {
  const env = resolveActiveEnv(installation)
  if (!env) return null
  const envPython = getEnvPythonPath(installation.installPath, env)
  if (fs.existsSync(envPython)) return envPython
  return null
}

function listEnvs(installPath: string): string[] {
  const envsPath = path.join(installPath, ENVS_DIR)
  if (!fs.existsSync(envsPath)) return []
  try {
    return fs.readdirSync(envsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

function recommendVariant(variantId: string, gpu: string | undefined): boolean {
  const stripped = stripPlatform(variantId)
  if (!gpu) return stripped === 'cpu'
  if (gpu === 'nvidia') return stripped === 'nvidia' || stripped.startsWith('nvidia-')
  if (gpu === 'amd') return stripped === 'amd' || stripped.startsWith('amd-')
  if (gpu === 'mps') return stripped === 'mps' || stripped.startsWith('mps-')
  if (gpu === 'intel') return stripped === 'intel-xpu' || stripped.startsWith('intel-xpu-')
  return false
}

// --- GitHub API response types ---

interface GitHubAsset {
  name: string
  browser_download_url: string
  size: number
}

interface GitHubRelease {
  id: number
  tag_name: string
  name: string | null
  assets: GitHubAsset[]
}

interface ManifestEntry {
  id: string
  comfyui_ref: string
  python_version: string
  files?: string[]
}

interface VariantData {
  variantId: string
  manifest: ManifestEntry
  downloadUrl: string
  downloadFiles: { url: string; filename: string; size: number }[]
}

export const standalone: SourcePlugin = {
  id: 'standalone',
  get label() { return t('standalone.label') },
  get description() { return t('standalone.desc') },
  category: 'local',

  get fields() {
    return [
      { id: 'release', label: t('common.release'), type: 'select' as const },
      { id: 'variant', label: t('standalone.variant'), type: 'select' as const, renderAs: 'cards' as const },
    ]
  },

  defaultLaunchArgs: DEFAULT_LAUNCH_ARGS,

  get installSteps() {
    return [
      { phase: 'download', label: t('common.download') },
      { phase: 'extract', label: t('common.extract') },
      { phase: 'setup', label: t('standalone.setupEnv') },
      { phase: 'cleanup', label: t('standalone.cleanupEnv') },
    ]
  },

  getDefaults() {
    return { launchArgs: DEFAULT_LAUNCH_ARGS, launchMode: 'window', portConflict: 'auto' }
  },

  getListPreview(installation: InstallationRecord): string | null {
    const channel = (installation.updateChannel as string | undefined) || 'stable'
    return getChannelLabel(channel)
  },

  getStatusTag(installation: InstallationRecord): StatusTag | undefined {
    const channel = (installation.updateChannel as string | undefined) || 'stable'
    const info = releaseCache.getEffectiveInfo(COMFYUI_REPO, channel, installation)
    if (info && releaseCache.isUpdateAvailable(installation, channel, info)) {
      return { label: t('standalone.updateAvailableTag', { version: info.releaseName || info.latestTag || '' }), style: 'update' }
    }
    return undefined
  },

  buildInstallation(selections: Record<string, FieldOption | undefined>): Record<string, unknown> {
    const vd = selections.variant?.data as VariantData | undefined
    const manifest = vd?.manifest
    const variantId = vd?.variantId || ''
    const isCpu = stripPlatform(variantId) === 'cpu' || stripPlatform(variantId).startsWith('cpu-')
    return {
      version: manifest?.comfyui_ref || selections.release?.value || 'unknown',
      releaseTag: selections.release?.value || 'unknown',
      variant: variantId,
      downloadUrl: vd?.downloadUrl || '',
      downloadFiles: vd?.downloadFiles || [],
      pythonVersion: manifest?.python_version || '',
      launchArgs: isCpu ? `${DEFAULT_LAUNCH_ARGS} --cpu` : DEFAULT_LAUNCH_ARGS,
      launchMode: 'window',
      browserPartition: 'unique',
    }
  },

  getLaunchCommand(installation: InstallationRecord): LaunchCommand | null {
    const pythonPath = getActivePythonPath(installation)
    if (!pythonPath || !fs.existsSync(pythonPath)) return null
    const mainPy = path.join(installation.installPath, 'ComfyUI', 'main.py')
    if (!fs.existsSync(mainPy)) return null
    const userArgs = ((installation.launchArgs as string | undefined) ?? DEFAULT_LAUNCH_ARGS).trim()
    const parsed = userArgs.length > 0 ? parseArgs(userArgs) : []
    const port = extractPort(parsed)
    return {
      cmd: pythonPath,
      args: ['-s', path.join('ComfyUI', 'main.py'), ...parsed],
      cwd: installation.installPath,
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

    const infoFields: Record<string, unknown>[] = [
      { label: t('common.installMethod'), value: installation.sourceLabel as string },
      { key: 'comfyui-version', label: t('standalone.comfyui'), value: installation.comfyVersion ? formatComfyVersion(installation.comfyVersion as ComfyVersion, 'detail') : (installation.version as string | undefined) || 'unknown' },
      { label: t('common.release'), value: (installation.releaseTag as string | undefined) || '—' },
      { label: t('standalone.variant'), value: (installation.variant as string | undefined) ? getVariantLabel(installation.variant as string) : '—' },
      { label: t('standalone.python'), value: (installation.pythonVersion as string | undefined) || '—' },
      { label: t('common.location'), value: installation.installPath || '—' },
      { label: t('common.installed'), value: new Date(installation.createdAt).toLocaleDateString() },
    ]

    const copiedFrom = installation.copiedFrom as string | undefined
    if (copiedFrom) {
      const copiedFromName = installation.copiedFromName as string | undefined
      const copiedAt = installation.copiedAt as string | undefined
      const copyReason = installation.copyReason as string | undefined
      const reasonLabel = copyReason === 'copy-update' ? t('standalone.lineageCopyUpdate')
        : copyReason === 'release-update' ? t('standalone.lineageReleaseUpdate')
        : t('standalone.lineageCopy')
      const dateStr = copiedAt ? new Date(copiedAt).toLocaleString() : ''
      const nameStr = copiedFromName || copiedFrom
      infoFields.push({
        label: t('standalone.lineage'),
        value: dateStr
          ? `${reasonLabel}: ${nameStr}  ·  ${dateStr}`
          : `${reasonLabel}: ${nameStr}`,
      })
    }

    const sections: Record<string, unknown>[] = [
      {
        tab: 'status',
        title: t('common.installInfo'),
        fields: infoFields,
      },
    ]

    // Snapshot tab — minimal section so the tab appears; SnapshotTab.vue handles rendering
    if (installed && installation.installPath) {
      sections.push({
        tab: 'snapshots',
        title: t('standalone.snapshotHistory'),
      })
    }

    // Updates section
    const hasGit = installed && installation.installPath && fs.existsSync(path.join(installation.installPath, 'ComfyUI', '.git'))
    const channel = (installation.updateChannel as string | undefined) || 'stable'

    // Build per-channel preview info and actions for cards
    const channelDefs = getChannelDefs()
    const baseCards = buildChannelCards(COMFYUI_REPO, channelDefs, installation)

    const channelOptions = baseCards.map((card) => {
      const actions: Record<string, unknown>[] = []
      if (card.data?.updateAvailable && hasGit) {
        const channelInfo = releaseCache.getEffectiveInfo(COMFYUI_REPO, card.value, installation)!
        const cv = installation.comfyVersion as ComfyVersion | undefined
        const installedDisplay = cv ? formatComfyVersion(cv, 'detail') : (channelInfo.installedTag || 'unknown')
        const latestCv = channelInfo.commitSha
          ? { commit: channelInfo.commitSha, baseTag: channelInfo.baseTag, commitsAhead: channelInfo.commitsAhead } as ComfyVersion
          : undefined
        const latestDisplay = latestCv ? formatComfyVersion(latestCv, 'detail') : (channelInfo.releaseName || channelInfo.latestTag || '—')
        const isSwitching = card.value !== channel
        const isDowngrade = card.value === 'stable' && cv ? (cv.commitsAhead === undefined ? !!cv.baseTag : cv.commitsAhead > 0) : false
        const msgKey = isDowngrade ? 'standalone.updateConfirmMessageDowngrade'
          : card.value === 'latest' ? 'standalone.updateConfirmMessageLatest'
          : 'standalone.updateConfirmMessage'
        const notes = truncateNotes(channelInfo.releaseNotes || '', 2000)
        const switchPrefix = isSwitching
          ? t('channelCards.switchChannelPrefix', { from: getChannelLabel(channel), to: card.label })
          : ''
        const confirmMessage = t(msgKey, {
          installed: installedDisplay,
          latest: latestDisplay,
          commit: notes || '',
          notes: notes || '(none)',
        })
        actions.push({
          id: 'update-comfyui', label: t('standalone.updateNow'), style: 'primary', enabled: installed,
          tooltip: t('tooltips.updateNow'),
          showProgress: true, progressTitle: t('standalone.updatingTitle', { version: latestDisplay }),
          data: isSwitching ? { channel: card.value } : undefined,
          confirm: {
            title: t('standalone.updateConfirmTitle'),
            message: switchPrefix + confirmMessage,
          },
        })
        actions.push({
          id: 'copy-update', label: t('standalone.copyAndUpdate'), style: 'default', enabled: installed,
          tooltip: t('tooltips.copyAndUpdate'),
          showProgress: true, progressTitle: t('standalone.copyUpdatingTitle', { version: latestDisplay }),
          cancellable: true,
          data: isSwitching ? { channel: card.value } : undefined,
          prompt: {
            title: t('standalone.copyAndUpdateTitle'),
            message: (isSwitching ? switchPrefix : '') + t('standalone.copyAndUpdateMessage', { installed: installedDisplay, latest: latestDisplay }),
            defaultValue: `${installation.name} (${latestDisplay})`,
            confirmLabel: t('standalone.copyAndUpdateConfirm'),
            required: true,
            field: 'name',
          },
        })
      } else if (card.value !== channel && hasGit) {
        actions.push({
          id: 'switch-channel', label: t('channelCards.switchChannelOnly'), style: 'default', enabled: installed,
          data: { channel: card.value },
        })
      }
      return { ...card, data: card.data ? { ...card.data, actions: actions.length ? actions : undefined } : undefined }
    })

    const updateFields: Record<string, unknown>[] = [
      { id: 'updateChannel', label: t('standalone.updateChannel'), value: channel, editable: true,
        refreshSection: true, onChangeAction: 'check-update', editType: 'channel-cards', options: channelOptions, tooltip: t('tooltips.updateChannel') },
    ]
    const updateActions: Record<string, unknown>[] = [
      { id: 'check-update', label: t('actions.checkForUpdate'), style: 'default', enabled: installed },
    ]
    sections.push({
      tab: 'update',
      title: t('standalone.updates'),
      fields: updateFields,
      actions: updateActions,
    })

    sections.push(
      {
        tab: 'settings',
        title: t('common.launchSettings'),
        fields: [
          { id: 'useSharedPaths', label: t('common.useSharedPaths'), value: (installation.useSharedPaths as boolean | undefined) !== false, editable: true, editType: 'boolean', tooltip: t('tooltips.useSharedPaths') },
          { id: 'launchArgs', label: t('common.startupArgs'), value: (installation.launchArgs as string | undefined) ?? DEFAULT_LAUNCH_ARGS, editable: true, editType: 'args-builder', tooltip: t('tooltips.startupArgs') },
          { id: 'launchMode', label: t('common.launchMode'), value: (installation.launchMode as string | undefined) || 'window', editable: true,
            editType: 'select', options: [
              { value: 'window', label: t('common.launchModeWindow') },
              { value: 'console', label: t('common.launchModeConsole') },
            ] },
          { id: 'browserPartition', label: t('common.browserPartition'), value: (installation.browserPartition as string | undefined) || 'shared', editable: true,
            editType: 'select', options: [
              { value: 'shared', label: t('common.partitionShared') },
              { value: 'unique', label: t('common.partitionUnique') },
            ], tooltip: t('tooltips.browserPartition') },
          { id: 'portConflict', label: t('common.portConflict'), value: (installation.portConflict as string | undefined) || 'ask', editable: true,
            editType: 'select', options: [
              { value: 'ask', label: t('common.portConflictAsk') },
              { value: 'auto', label: t('common.portConflictAuto') },
            ] },
          { id: 'envVars', label: t('common.envVars'), value: (installation.envVars as Record<string, string> | undefined) ?? {}, editable: true, editType: 'env-vars', tooltip: t('tooltips.envVars') },
        ],
      },
      {
        title: 'Actions',
        pinBottom: true,
        actions: [
          { id: 'launch', label: t('actions.launch'), style: 'primary', enabled: installed,
            ...(!installed && { disabledMessage: t('errors.installNotReady') }),
            showProgress: true, progressTitle: t('common.startingComfyUI'), cancellable: true },
          { id: 'copy', label: t('actions.copyInstallation'), style: 'default', enabled: installed,
            showProgress: true, progressTitle: t('actions.copyingInstallation'), cancellable: true,
            prompt: {
              title: t('actions.copyInstallationTitle'),
              message: t('actions.copyInstallationMessage'),
              defaultValue: `${installation.name} (Copy)`,
              confirmLabel: t('actions.copyInstallationConfirm'),
              required: true,
              field: 'name',
            } },
          { id: 'open-folder', label: t('actions.openDirectory'), style: 'default', enabled: !!installation.installPath },
          deleteAction(installation),
          untrackAction(),
        ],
      },
    )

    return sections
  },

  async install(installation: InstallationRecord, tools: InstallTools): Promise<void> {
    const files = installation.downloadFiles as Array<{ url: string; filename: string; size: number }> | undefined
    if (files && files.length > 0) {
      const cacheDir = `${installation.releaseTag as string}_${installation.variant as string}`
      await downloadAndExtractMulti(files, installation.installPath, cacheDir, tools)
    } else if (installation.downloadUrl as string | undefined) {
      const downloadUrl = installation.downloadUrl as string
      const filename = downloadUrl.split('/').pop()!
      const cacheKey = `${installation.releaseTag as string}_${filename}`
      await downloadAndExtract(downloadUrl, installation.installPath, cacheKey, tools)
    }
  },

  async postInstall(installation: InstallationRecord, { sendProgress, update, signal }: PostInstallTools): Promise<void> {
    const standaloneEnvDir = path.join(installation.installPath, 'standalone-env')
    if (process.platform !== 'win32') {
      const binDir = path.join(standaloneEnvDir, 'bin')
      try {
        const entries = fs.readdirSync(binDir)
        for (const entry of entries) {
          const fullPath = path.join(binDir, entry)
          try { fs.chmodSync(fullPath, 0o755) } catch {}
        }
      } catch {}
    }
    await repairMacBinaries(installation.installPath, sendProgress)
    if (signal?.aborted) throw new Error('Cancelled')
    sendProgress('setup', { percent: 0, status: 'Creating default Python environment…' })
    await createEnv(installation.installPath, DEFAULT_ENV, (copied, total, elapsedSecs, etaSecs) => {
      const percent = Math.round((copied / total) * 100)
      const elapsed = formatTime(elapsedSecs)
      const eta = etaSecs >= 0 ? formatTime(etaSecs) : '—'
      sendProgress('setup', { percent, status: `Copying packages… ${copied} / ${total} files  ·  ${elapsed} elapsed  ·  ${eta} remaining` })
    }, signal)
    if (signal?.aborted) throw new Error('Cancelled')
    const envMethods = { ...(installation.envMethods as Record<string, string> | undefined), [DEFAULT_ENV]: ENV_METHOD }
    await update({ envMethods })
    sendProgress('cleanup', { percent: -1, status: t('standalone.cleanupEnvStatus') })
    await stripMasterPackages(installation.installPath)

    // Populate comfyVersion from the extracted git repo so version displays
    // are correct immediately, without waiting for the first update.
    // On machines without a global git binary, configure pygit2 using the
    // just-installed standalone Python so tag resolution works correctly.
    if (!isPygit2Configured() && !await isGitAvailable()) {
      tryConfigurePygit2Fallback(installation.installPath)
    }
    const comfyuiDir = path.join(installation.installPath, 'ComfyUI')
    sendProgress('cleanup', { percent: -1, status: 'Fetching version tags…' })
    await fetchTags(comfyuiDir)
    const headCommit = readGitHead(comfyuiDir)
    if (headCommit) {
      const ref = installation.version as string | undefined
      const comfyVersion = await resolveLocalVersion(comfyuiDir, headCommit, ref)
      await update({ comfyVersion })
      // Use updated installation for snapshot so it captures the version
      installation = { ...installation, comfyVersion } as InstallationRecord
    }

    // Capture initial snapshot so the detail view shows "Current" immediately
    try {
      const filename = await snapshots.saveSnapshot(installation.installPath, installation, 'boot')
      const snapshotCount = await snapshots.getSnapshotCount(installation.installPath)
      await update({ lastSnapshot: filename, snapshotCount })
    } catch (err) {
      console.warn('Initial snapshot failed:', err)
    }
  },

  async probeInstallation(dirPath: string): Promise<Record<string, unknown> | null> {
    const envExists = fs.existsSync(path.join(dirPath, 'standalone-env'))
    const mainExists = fs.existsSync(path.join(dirPath, 'ComfyUI', 'main.py'))
    if (!envExists || !mainExists) return null
    const hasGit = fs.existsSync(path.join(dirPath, 'ComfyUI', '.git'))

    let version = 'unknown'
    let releaseTag = ''
    let variant = ''
    let pythonVersion = ''
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dirPath, MANIFEST_FILE), 'utf8')) as Record<string, string>
      version = data.comfyui_ref || version
      releaseTag = data.version || releaseTag
      variant = data.id || variant
      pythonVersion = data.python_version || pythonVersion
    } catch {}

    let comfyVersion: ComfyVersion | undefined
    if (hasGit) {
      const comfyuiDir = path.join(dirPath, 'ComfyUI')
      const commit = readGitHead(comfyuiDir)
      if (commit) {
        const manifestTag = version !== 'unknown' ? version : undefined
        comfyVersion = await resolveLocalVersion(comfyuiDir, commit, manifestTag)
      }
    }

    return {
      version,
      ...(comfyVersion ? { comfyVersion } : {}),
      releaseTag,
      variant,
      pythonVersion,
      hasGit,
      launchArgs: DEFAULT_LAUNCH_ARGS,
      launchMode: 'window',
    }
  },

  async handleAction(
    actionId: string,
    installation: InstallationRecord,
    actionData: Record<string, unknown> | undefined,
    { update, sendProgress, sendOutput, signal }: ActionTools
  ): Promise<ActionResult> {
    if (actionId === 'snapshot-save') {
      const label = (actionData?.label as string | undefined) || undefined
      const filename = await snapshots.saveSnapshot(installation.installPath, installation, 'manual', label)
      const snapshotCount = await snapshots.getSnapshotCount(installation.installPath)
      await update({ lastSnapshot: filename, snapshotCount })
      return { ok: true, navigate: 'detail' }
    }

    if (actionId === 'snapshot-restore') {
      const file = actionData?.file as string | undefined
      if (!file) return { ok: false, message: t('standalone.snapshotNoFile') }

      sendProgress('steps', { steps: [
        { phase: 'restore-comfyui', label: t('standalone.snapshotRestoreComfyUIPhase') },
        { phase: 'restore-nodes', label: t('standalone.snapshotRestoreNodesPhase') },
        { phase: 'restore-pip', label: t('standalone.snapshotRestorePipPhase') },
      ] })
      sendProgress('restore-comfyui', { percent: 0, status: 'Loading snapshot…' })
      sendOutput('Loading snapshot…\n')

      const targetSnapshot = await snapshots.loadSnapshot(installation.installPath, file)

      // Phase 1: Restore ComfyUI version (checkout target commit)
      sendOutput('\n── Restore ComfyUI Version ──\n')
      const comfyResult = await snapshots.restoreComfyUIVersion(
        installation.installPath, targetSnapshot, sendOutput
      )
      sendProgress('restore-comfyui', { percent: 100, status: comfyResult.changed ? 'Restored' : 'Up to date' })

      if (signal?.aborted) return { ok: false, message: 'Cancelled' }

      // Phase 2: Restore custom nodes first (node installs may add pip dependencies)
      sendOutput('\n── Restore Nodes ──\n')
      const nodeResult = await snapshots.restoreCustomNodes(
        installation.installPath, installation, targetSnapshot, sendProgress, sendOutput, signal,
        settings.getMirrorConfig()
      )

      if (signal?.aborted) return { ok: false, message: 'Cancelled' }

      // Phase 3: Restore pip packages (syncs to exact target state)
      sendOutput('\n── Restore Packages ──\n')
      const pipResult = await snapshots.restorePipPackages(
        installation.installPath, installation, targetSnapshot,
        (phase, data) => sendProgress(phase === 'restore' ? 'restore-pip' : phase, data),
        sendOutput, signal, settings.getMirrorConfig()
      )

      // Build combined summary
      const summary: string[] = []

      if (comfyResult.changed) {
        summary.push(`ComfyUI: checked out ${(comfyResult.commit || targetSnapshot.comfyui.commit || '').slice(0, 7)}`)
      }
      if (comfyResult.error) summary.push(`ComfyUI restore failed: ${comfyResult.error}`)

      const nodeActions = nodeResult.installed.length + nodeResult.switched.length +
        nodeResult.enabled.length + nodeResult.disabled.length + nodeResult.removed.length
      if (nodeActions > 0) {
        const parts: string[] = []
        if (nodeResult.installed.length > 0) parts.push(`${nodeResult.installed.length} installed`)
        if (nodeResult.switched.length > 0) parts.push(`${nodeResult.switched.length} switched`)
        if (nodeResult.enabled.length > 0) parts.push(`${nodeResult.enabled.length} enabled`)
        if (nodeResult.removed.length > 0) parts.push(`${nodeResult.removed.length} removed`)
        if (nodeResult.disabled.length > 0) parts.push(`${nodeResult.disabled.length} disabled`)
        summary.push(`Nodes: ${parts.join(', ')}`)
      }
      if (nodeResult.failed.length > 0) summary.push(`${nodeResult.failed.length} node(s) failed`)
      if (nodeResult.unreportable.length > 0) summary.push(`${nodeResult.unreportable.length} standalone .py file(s) not restorable`)

      if (pipResult.installed.length > 0 || pipResult.changed.length > 0 || pipResult.removed.length > 0) {
        const parts: string[] = []
        if (pipResult.installed.length > 0) parts.push(`${pipResult.installed.length} installed`)
        if (pipResult.changed.length > 0) parts.push(`${pipResult.changed.length} changed`)
        if (pipResult.removed.length > 0) parts.push(`${pipResult.removed.length} removed`)
        summary.push(`Packages: ${parts.join(', ')}`)
      }
      if (pipResult.protectedSkipped.length > 0) summary.push(`${pipResult.protectedSkipped.length} protected (skipped)`)
      if (pipResult.failed.length > 0) summary.push(`${pipResult.failed.length} package(s) failed`)

      const totalFailures = nodeResult.failed.length + pipResult.failed.length + (comfyResult.error ? 1 : 0)

      if (summary.length === 0) {
        sendOutput(`\n✓ ${t('standalone.snapshotRestoreNothingToDo')}\n`)
        sendProgress('done', { percent: 100, status: t('standalone.snapshotRestoreNothingToDo') })
        return { ok: true, navigate: 'detail' }
      }

      sendOutput(`\n${totalFailures > 0 ? '⚠' : '✓'} ${t('standalone.snapshotRestoreComplete')}: ${summary.join('; ')}\n`)

      if (pipResult.failed.length > 0) {
        return { ok: false, message: t('standalone.snapshotRestoreReverted') }
      }

      // Restore update channel and version/lastRollback state so the
      // release cache sees accurate state for the restored channel.
      // Recompute comfyVersion from git state so that old snapshots captured
      // before the baseTag fix don't propagate stale version metadata.
      const comfyuiDir = path.join(installation.installPath, 'ComfyUI')
      const restoredHead = comfyResult.commit || readGitHead(comfyuiDir)
      let freshComfyVersion: ComfyVersion | undefined
      if (!comfyResult.error && restoredHead) {
        freshComfyVersion = await resolveLocalVersion(comfyuiDir, restoredHead)
      }
      const restoreState = snapshots.buildPostRestoreState(
        targetSnapshot, comfyResult,
        installation.updateInfoByChannel as Record<string, Record<string, unknown>> | undefined,
        installation.comfyVersion as ComfyVersion | undefined
      )
      // Override the snapshot-based comfyVersion with the freshly resolved one
      if (freshComfyVersion) {
        restoreState.comfyVersion = freshComfyVersion
        const tag = formatComfyVersion(freshComfyVersion, 'short')
        const channelInfo = restoreState.updateInfoByChannel as Record<string, Record<string, unknown>>
        const ch = targetSnapshot.updateChannel || 'stable'
        channelInfo[ch] = { ...channelInfo[ch], installedTag: tag }
      }
      await update(restoreState)

      // Capture a new snapshot reflecting the restored state
      try {
        const updatedInstallation = {
          ...installation,
          ...restoreState,
        }
        const filename = await snapshots.saveSnapshot(installation.installPath, updatedInstallation, 'post-restore')
        const snapshotCount = await snapshots.getSnapshotCount(installation.installPath)
        await update({ lastSnapshot: filename, snapshotCount })
      } catch {}

      sendProgress('done', { percent: 100, status: t('standalone.snapshotRestoreComplete') })
      return { ok: totalFailures === 0, navigate: 'detail',
        ...(totalFailures > 0 ? { message: `${totalFailures} operation(s) failed` } : {}) }
    }

    // Handler kept for potential future use (e.g., context menu). Button removed from UI since
    // snapshots are tiny (~5 KB) and auto-pruned, so manual deletion adds more risk than value.
    if (actionId === 'snapshot-delete') {
      const file = actionData?.file as string | undefined
      if (!file) return { ok: false, message: t('standalone.snapshotNoFile') }
      await snapshots.deleteSnapshot(installation.installPath, file)
      const remaining = await snapshots.listSnapshots(installation.installPath)
      const snapshotCount = remaining.length
      const lastSnapshot = remaining.length > 0 ? remaining[0]!.filename : null
      await update({ snapshotCount, ...(file === installation.lastSnapshot ? { lastSnapshot } : {}) })
      return { ok: true, navigate: 'detail' }
    }

    if (actionId === 'snapshot-view') {
      const file = actionData?.file as string | undefined
      if (!file) return { ok: false, message: t('standalone.snapshotNoFile') }
      const target = await snapshots.loadSnapshot(installation.installPath, file)
      const diff = await snapshots.diffAgainstCurrent(installation.installPath, installation, target)

      const lines: string[] = []

      // ComfyUI version
      if (diff.comfyuiChanged && diff.comfyui) {
        lines.push(`${t('standalone.snapshotDiffComfyUI')}`)
        lines.push(`  ${diff.comfyui.from.formattedVersion} → ${diff.comfyui.to.formattedVersion}`)
        lines.push('')
      }

      // Custom nodes
      if (diff.nodesAdded.length > 0 || diff.nodesRemoved.length > 0 || diff.nodesChanged.length > 0) {
        lines.push(`${t('standalone.snapshotDiffNodes')}`)
        for (const n of diff.nodesAdded) {
          const ver = n.version || (n.commit ? n.commit.slice(0, 7) : '')
          lines.push(`  + ${n.id}${ver ? ` ${ver}` : ''}`)
        }
        for (const n of diff.nodesRemoved) {
          const ver = n.version || (n.commit ? n.commit.slice(0, 7) : '')
          lines.push(`  − ${n.id}${ver ? ` ${ver}` : ''}`)
        }
        for (const n of diff.nodesChanged) {
          const fromVer = n.from.version || (n.from.commit ? n.from.commit.slice(0, 7) : '?')
          const toVer = n.to.version || (n.to.commit ? n.to.commit.slice(0, 7) : '?')
          const enabledChanged = n.from.enabled !== n.to.enabled
          const versionChanged = fromVer !== toVer
          if (enabledChanged && versionChanged) {
            lines.push(`  ~ ${n.id}: ${fromVer} → ${toVer}, ${n.from.enabled ? 'enabled' : 'disabled'} → ${n.to.enabled ? 'enabled' : 'disabled'}`)
          } else if (enabledChanged) {
            lines.push(`  ~ ${n.id}: ${n.from.enabled ? 'enabled' : 'disabled'} → ${n.to.enabled ? 'enabled' : 'disabled'}`)
          } else {
            lines.push(`  ~ ${n.id}: ${fromVer} → ${toVer}`)
          }
        }
        lines.push('')
      }

      // Pip packages
      const pipTotal = diff.pipsAdded.length + diff.pipsRemoved.length + diff.pipsChanged.length
      if (pipTotal > 0) {
        lines.push(`${t('standalone.snapshotDiffPackages')} (${pipTotal})`)
        for (const p of diff.pipsAdded) lines.push(`  + ${p.name} ${p.version}`)
        for (const p of diff.pipsRemoved) lines.push(`  − ${p.name} ${p.version}`)
        for (const p of diff.pipsChanged) lines.push(`  ~ ${p.name}: ${p.from} → ${p.to}`)
        lines.push('')
      }

      if (lines.length === 0) {
        lines.push(t('standalone.snapshotDiffNoChanges'))
      }

      return { ok: true, message: lines.join('\n') }
    }

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
            return releaseCache.buildCacheEntry(release)
          }, true)
        )
      )
      return releaseCache.checkForUpdate(COMFYUI_REPO, channel, installation, update)
    }

    if (actionId === 'update-comfyui') {
      const installPath = installation.installPath
      const comfyuiDir = path.join(installPath, 'ComfyUI')
      const gitDir = path.join(comfyuiDir, '.git')

      if (!fs.existsSync(gitDir)) {
        return { ok: false, message: t('standalone.updateNoGit') }
      }

      const masterPython = getMasterPythonPath(installPath)
      if (!fs.existsSync(masterPython)) {
        return { ok: false, message: 'Master Python not found.' }
      }

      const targetChannel = (actionData?.channel as string | undefined) ?? (installation.updateChannel as string | undefined) ?? 'stable'
      if (targetChannel !== (installation.updateChannel as string | undefined)) {
        await update({ updateChannel: targetChannel })
      }
      const channel = targetChannel
      const stableArgs = channel === 'stable' ? ['--stable'] : []

      const reqPath = path.join(comfyuiDir, 'requirements.txt')
      let preReqs = ''
      try { preReqs = await fs.promises.readFile(reqPath, 'utf-8') } catch {}

      const mgrReqPath = path.join(comfyuiDir, 'manager_requirements.txt')
      let preMgrReqs = ''
      try { preMgrReqs = await fs.promises.readFile(mgrReqPath, 'utf-8') } catch {}

      sendProgress('steps', { steps: [
        { phase: 'prepare', label: t('standalone.updatePrepare') },
        { phase: 'run', label: t('standalone.updateRun') },
        { phase: 'deps', label: t('standalone.updateDeps') },
      ] })

      sendProgress('prepare', { percent: -1, status: t('standalone.updatePrepareSnapshot') })

      // Auto-snapshot before update
      let preUpdateFilename: string | undefined
      try {
        preUpdateFilename = await snapshots.saveSnapshot(installPath, installation, 'pre-update')
        const snapshotCount = await snapshots.getSnapshotCount(installPath)
        await update({ lastSnapshot: preUpdateFilename, snapshotCount })
      } catch (err) {
        console.warn('Pre-update snapshot failed:', err)
      }

      sendProgress('run', { percent: -1, status: t('standalone.updateFetching') })

      const updateScript = app.isPackaged
        ? path.join(process.resourcesPath, 'lib', 'update_comfyui.py')
        : path.join(__dirname, '..', '..', 'lib', 'update_comfyui.py')
      const markers: Record<string, string> = {}
      let markerBuf = ''
      let stdoutBuf = ''
      let stderrBuf = ''
      let exitSignal: string | null = null
      const exitCode = await new Promise<number>((resolve) => {
        const proc = spawn(masterPython, ['-s', updateScript, comfyuiDir, ...stableArgs], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        if (signal) {
          const onAbort = (): void => { proc.kill() }
          signal.addEventListener('abort', onAbort, { once: true })
          proc.on('close', () => signal.removeEventListener('abort', onAbort))
        }
        proc.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8')
          stdoutBuf += text
          markerBuf += text
          const lines = markerBuf.split(/\r?\n/)
          markerBuf = lines.pop()!
          for (const line of lines) {
            const match = line.match(/^\[(\w+)\]\s*(.+)$/)
            if (match) markers[match[1]!] = match[2]!.trim()
          }
          sendOutput(text)
        })
        proc.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8')
          stderrBuf += text
          sendOutput(text)
        })
        proc.on('error', (err) => {
          sendOutput(`Error: ${err.message}\n`)
          resolve(1)
        })
        proc.on('close', (code, sig) => {
          exitSignal = sig
          resolve(code ?? 1)
        })
      })
      if (markerBuf) {
        const match = markerBuf.match(/^\[(\w+)\]\s*(.+)$/)
        if (match) markers[match[1]!] = match[2]!.trim()
      }

      if (exitCode !== 0) {
        // On macOS, SIGKILL typically means Gatekeeper blocked an unsigned binary.
        // Auto-repair (quarantine removal + codesigning) and retry once.
        if (exitSignal === 'SIGKILL' && process.platform === 'darwin' && !actionData?._repairAttempted) {
          sendOutput('\nProcess was killed by macOS — attempting binary repair…\n')
          await repairMacBinaries(installPath, sendProgress, sendOutput)
          sendOutput('Repair complete — retrying update…\n\n')
          return this.handleAction(actionId, installation, { ...actionData, _repairAttempted: true }, { update, sendProgress, sendOutput, signal })
        }

        const detail = (stderrBuf || stdoutBuf).trim().split('\n').slice(-20).join('\n')
        let message: string
        if (detail) {
          message = `${t('standalone.updateFailed', { code: exitCode })}\n\n${detail}`
        } else if (exitSignal) {
          message = `${t('standalone.updateFailed', { code: exitCode })}\n\nProcess was killed by signal ${exitSignal}.\npython: ${masterPython}\nscript: ${updateScript}`
        } else {
          message = `${t('standalone.updateFailed', { code: exitCode })}\n\nProcess produced no output.\npython: ${masterPython}\nscript: ${updateScript}`
        }
        return { ok: false, message }
      }

      if (signal?.aborted) return { ok: false, message: 'Cancelled' }
      sendProgress('deps', { percent: -1, status: t('standalone.updateDepsChecking') })

      let postReqs = ''
      try { postReqs = await fs.promises.readFile(reqPath, 'utf-8') } catch {}

      if (preReqs !== postReqs && postReqs.length > 0) {
        const uvPath = getUvPath(installPath)
        const activeEnvPython = getActivePythonPath(installation)

        if (fs.existsSync(uvPath) && activeEnvPython) {
          const filteredReqs = postReqs.split('\n').filter((l) => !PYTORCH_RE.test(l.trim())).join('\n')
          const filteredReqPath = path.join(installPath, '.comfyui-reqs-filtered.txt')
          await fs.promises.writeFile(filteredReqPath, filteredReqs, 'utf-8')

          try {
            const indexArgs = getPipIndexArgs(settings.get('pypiMirror'), settings.get('useChineseMirrors') === true)
            sendProgress('deps', { percent: -1, status: t('standalone.updateDepsDryRun') })
            if (signal?.aborted) return { ok: false, message: 'Cancelled' }
            const dryRunResult = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
              const proc = spawn(uvPath, ['pip', 'install', '--dry-run', '-r', filteredReqPath, '--python', activeEnvPython, ...indexArgs], {
                cwd: installPath,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
              })
              if (signal) {
                const onAbort = (): void => { proc.kill() }
                signal.addEventListener('abort', onAbort, { once: true })
                proc.on('close', () => signal.removeEventListener('abort', onAbort))
              }
              let stdout = ''
              let stderr = ''
              proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
              proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })
              proc.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }))
              proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
            })

            if (dryRunResult.code !== 0) {
              sendOutput(`\n⚠ Requirements dry-run detected potential conflicts:\n${dryRunResult.stderr || dryRunResult.stdout}\n`)
              sendOutput('Proceeding with install attempt — some conflicts may be benign.\nTip: Use "Copy & Update" for a risk-free update that leaves this installation untouched.\n')
            } else if (dryRunResult.stderr) {
              sendOutput(dryRunResult.stderr)
            }

            if (signal?.aborted) return { ok: false, message: 'Cancelled' }
            sendProgress('deps', { percent: -1, status: t('standalone.updateDepsInstalling') })
            const installResult = await new Promise<number>((resolve) => {
              const proc = spawn(uvPath, ['pip', 'install', '-r', filteredReqPath, '--python', activeEnvPython, ...indexArgs], {
                cwd: installPath,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
              })
              if (signal) {
                const onAbort = (): void => { proc.kill() }
                signal.addEventListener('abort', onAbort, { once: true })
                proc.on('close', () => signal.removeEventListener('abort', onAbort))
              }
              proc.stdout.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
              proc.stderr.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
              proc.on('error', (err) => {
                sendOutput(`Error: ${err.message}\n`)
                resolve(1)
              })
              proc.on('close', (code) => resolve(code ?? 1))
            })

            if (installResult !== 0) {
              sendOutput(`\nWarning: requirements install exited with code ${installResult}\n`)
            }
          } finally {
            try { await fs.promises.unlink(filteredReqPath) } catch {}
          }
        }
      } else {
        sendProgress('deps', { percent: -1, status: t('standalone.updateDepsUpToDate') })
      }

      // Check for manager_requirements.txt changes (comfyui-manager pip package)
      let postMgrReqs = ''
      try { postMgrReqs = await fs.promises.readFile(mgrReqPath, 'utf-8') } catch {}

      if (preMgrReqs !== postMgrReqs && postMgrReqs.length > 0) {
        const uvPath = getUvPath(installPath)
        const activeEnvPython = getActivePythonPath(installation)

        if (fs.existsSync(uvPath) && activeEnvPython) {
          sendProgress('deps', { percent: -1, status: t('standalone.updateDepsInstalling') })
          sendOutput('\nInstalling manager requirements…\n')
          const mgrResult = await installFilteredRequirements(mgrReqPath, uvPath, activeEnvPython, installPath, '.manager-reqs-filtered.txt', sendOutput, signal, settings.getMirrorConfig())
          if (mgrResult !== 0) {
            sendOutput(`\nWarning: manager requirements install exited with code ${mgrResult}\n`)
          }
        }
      }

      const cachedRelease = releaseCache.get(COMFYUI_REPO, channel) || {}
      const fullPostHead = markers.POST_UPDATE_HEAD || null

      // Tags may have changed after the update; clear the cache so
      // subsequent resolveLocalVersion calls see the new tags.
      clearVersionCache()

      // Build structured comfyVersion from raw data.
      // For stable updates, CHECKED_OUT_TAG is the most reliable baseTag source
      // (comes directly from the git checkout). The cache may lack baseTag if
      // the release was fetched before the structured-version fields were added.
      const checkedOutTag = markers.CHECKED_OUT_TAG || undefined
      const comfyVersion: ComfyVersion | undefined = fullPostHead
        ? {
          commit: fullPostHead,
          baseTag: (cachedRelease.baseTag as string | undefined) ?? checkedOutTag,
          commitsAhead: checkedOutTag
            ? (cachedRelease.commitsAhead as number | undefined) ?? 0
            : (cachedRelease.commitsAhead as number | undefined),
        }
        : undefined
      const installedTag = comfyVersion
        ? formatComfyVersion(comfyVersion, 'short')
        : (markers.CHECKED_OUT_TAG || cachedRelease.latestTag || 'unknown')

      const rollback = {
        preUpdateHead: markers.PRE_UPDATE_HEAD || null,
        postUpdateHead: fullPostHead,
        backupBranch: markers.BACKUP_BRANCH || null,
        channel,
        updatedAt: Date.now(),
      }
      const existing = (installation.updateInfoByChannel as Record<string, Record<string, unknown>> | undefined) || {}
      await update({
        ...(comfyVersion ? { comfyVersion } : {}),
        lastRollback: rollback,
        updateInfoByChannel: {
          ...existing,
          [channel]: { installedTag },
        },
      })

      // Capture post-update snapshot so the history reflects the new state immediately
      try {
        const updatedInstallation = { ...installation, ...(comfyVersion ? { comfyVersion } : {}), updateChannel: targetChannel }
        const filename = await snapshots.saveSnapshot(installPath, updatedInstallation, 'post-update')
        const snapshotCount = await snapshots.getSnapshotCount(installPath)
        await update({ lastSnapshot: filename, snapshotCount })

        // Remove pre-update snapshot if it was identical to the one before it
        if (preUpdateFilename) {
          const pruned = await snapshots.deduplicatePreUpdateSnapshot(installPath, preUpdateFilename)
          if (pruned) {
            const updatedCount = await snapshots.getSnapshotCount(installPath)
            await update({ snapshotCount: updatedCount })
          }
        }
      } catch (err) {
        console.warn('Post-update snapshot failed:', err)
      }

      sendProgress('done', { percent: 100, status: 'Complete' })
      return { ok: true, navigate: 'detail' }
    }

    if (actionId === 'migrate-from') {
      const sourceId = actionData?.sourceInstallationId as string | undefined
      if (!sourceId) return { ok: false, message: 'No source installation specified.' }

      const wantNodes = actionData?.customNodes === true
      const wantAllUserData = actionData?.allUserData === true
      const wantWorkflows = !wantAllUserData && actionData?.workflows === true
      const wantSettings = !wantAllUserData && actionData?.userSettings === true
      const wantModels = actionData?.models === true
      const wantInput = actionData?.input === true
      const wantOutput = actionData?.output === true

      const srcInst = await installations.get(sourceId)
      if (!srcInst) return { ok: false, message: 'Source installation not found.' }

      const srcComfyUI = findComfyUIDir(srcInst.installPath)
      const dstComfyUI = path.join(installation.installPath, 'ComfyUI')

      if (!srcComfyUI) {
        return { ok: false, message: t('migrate.noComfyUIDir') }
      }

      const useShared = (installation.useSharedPaths as boolean | undefined) !== false

      const srcModels = path.join(srcComfyUI, 'models')
      const dstModels = useShared
        ? ((settings.get('modelsDirs') as string[] | undefined) || settings.defaults.modelsDirs)[0]!
        : path.join(dstComfyUI, 'models')
      const srcInput = path.join(srcComfyUI, 'input')
      const dstInput = useShared
        ? ((settings.get('inputDir') as string | undefined) || settings.defaults.inputDir)
        : path.join(dstComfyUI, 'input')
      const srcOutput = path.join(srcComfyUI, 'output')
      const dstOutput = useShared
        ? ((settings.get('outputDir') as string | undefined) || settings.defaults.outputDir)
        : path.join(dstComfyUI, 'output')

      const srcCustomNodes = path.join(srcComfyUI, 'custom_nodes')
      const dstCustomNodes = path.join(dstComfyUI, 'custom_nodes')
      const srcWorkflows = path.join(srcComfyUI, 'user', 'default', 'workflows')
      const dstWorkflows = path.join(dstComfyUI, 'user', 'default', 'workflows')
      const srcUserDir = path.join(srcComfyUI, 'user')

      const steps: Array<{ phase: string; label: string }> = [{ phase: 'migrate', label: t('migrate.filePhase') }]
      if (wantNodes) steps.push({ phase: 'deps', label: t('migrate.depsPhase') })
      sendProgress('steps', { steps })

      sendProgress('migrate', { percent: 0, status: t('migrate.scanning') })

      const srcNodes = wantNodes ? listCustomNodes(srcCustomNodes) : []
      const hasAllUserData = wantAllUserData && fs.existsSync(srcUserDir)
      const hasWorkflows = wantWorkflows && fs.existsSync(srcWorkflows)
      const hasModels = wantModels && fs.existsSync(srcModels)
      const hasInput = wantInput && fs.existsSync(srcInput)
      const hasOutput = wantOutput && fs.existsSync(srcOutput)

      const settingsFiles: Array<{ profile: string; src: string; dst: string }> = []
      if (wantSettings && fs.existsSync(srcUserDir)) {
        try {
          for (const d of fs.readdirSync(srcUserDir, { withFileTypes: true })) {
            if (d.isDirectory() && !d.name.startsWith('_')) {
              const src = path.join(srcUserDir, d.name, 'comfy.settings.json')
              if (fs.existsSync(src)) {
                settingsFiles.push({ profile: d.name, src, dst: path.join(dstComfyUI, 'user', d.name, 'comfy.settings.json') })
              }
            }
          }
        } catch {}
      }

      const total = srcNodes.length + (hasAllUserData ? 1 : 0) + (hasWorkflows ? 1 : 0) + (settingsFiles.length > 0 ? 1 : 0) + (hasModels ? 1 : 0) + (hasInput ? 1 : 0) + (hasOutput ? 1 : 0)

      if (total === 0) {
        sendProgress('migrate', { percent: 100, status: t('migrate.nothingToMigrate') })
        if (wantNodes) sendProgress('deps', { percent: 100, status: t('migrate.noDeps') })
        sendProgress('done', { percent: 100, status: 'Complete' })
        return { ok: true, navigate: 'detail' }
      }

      let migrated = 0
      const migratedNodes: Array<{ name: string; dir: string; hasRequirements: boolean }> = []
      const backedUp: string[] = []
      const summary: string[] = []

      if (srcNodes.length > 0) {
        fs.mkdirSync(dstCustomNodes, { recursive: true })
        for (const node of srcNodes) {
          const dstNodeDir = path.join(dstCustomNodes, node.name)
          if (fs.existsSync(dstNodeDir)) {
            const bak = backupDir(dstNodeDir)
            if (bak) backedUp.push(node.name)
          }
          await copyDirWithProgress(node.dir, dstNodeDir, (copied, fileTotal) => {
            const sub = fileTotal > 0 ? copied / fileTotal : 1
            const percent = Math.round(((migrated + sub) / total) * 100)
            sendProgress('migrate', { percent, status: t('migrate.copyingNode', { name: node.name, current: migrated + 1, total }) })
          })
          migratedNodes.push(node)
          migrated++
        }
        summary.push(t('migrate.summaryNodes', { count: migratedNodes.length }))
        if (backedUp.length > 0) summary.push(t('migrate.summaryBackedUp', { count: backedUp.length }))
      }

      if (hasAllUserData) {
        sendProgress('migrate', { percent: Math.round((migrated / total) * 100), status: t('migrate.mergingUserData') })
        const dstUserDir = path.join(dstComfyUI, 'user')
        const result = await mergeDirFlat(srcUserDir, dstUserDir, (copied, skipped, fileTotal) => {
          const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1
          const percent = Math.round(((migrated + sub) / total) * 100)
          sendProgress('migrate', { percent, status: t('migrate.mergingUserData') })
        })
        migrated++
        summary.push(t('migrate.summaryUserData', { copied: result.copied, skipped: result.skipped }))
      }

      if (hasWorkflows) {
        sendProgress('migrate', { percent: Math.round((migrated / total) * 100), status: t('migrate.mergingWorkflows') })
        const result = await mergeDirFlat(srcWorkflows, dstWorkflows, (copied, skipped, fileTotal) => {
          const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1
          const percent = Math.round(((migrated + sub) / total) * 100)
          sendProgress('migrate', { percent, status: t('migrate.mergingWorkflows') })
        })
        migrated++
        summary.push(t('migrate.summaryWorkflows', { copied: result.copied, skipped: result.skipped }))
      }

      if (settingsFiles.length > 0) {
        sendProgress('migrate', { percent: Math.round((migrated / total) * 100), status: t('migrate.copyingSettings') })
        let copied = 0
        for (const sf of settingsFiles) {
          await fs.promises.mkdir(path.dirname(sf.dst), { recursive: true })
          await fs.promises.copyFile(sf.src, sf.dst)
          copied++
        }
        migrated++
        summary.push(t('migrate.summarySettings', { count: copied }))
      }

      if (hasModels) {
        sendProgress('migrate', { percent: Math.round((migrated / total) * 100), status: t('migrate.mergingModels') })
        const result = await mergeDirFlat(srcModels, dstModels, (copied, skipped, fileTotal) => {
          const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1
          const percent = Math.round(((migrated + sub) / total) * 100)
          sendProgress('migrate', { percent, status: t('migrate.mergingModels') })
        })
        migrated++
        summary.push(t('migrate.summaryModels', { copied: result.copied, skipped: result.skipped }))
      }

      if (hasInput) {
        sendProgress('migrate', { percent: Math.round((migrated / total) * 100), status: t('migrate.mergingInput') })
        const result = await mergeDirFlat(srcInput, dstInput, (copied, skipped, fileTotal) => {
          const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1
          const percent = Math.round(((migrated + sub) / total) * 100)
          sendProgress('migrate', { percent, status: t('migrate.mergingInput') })
        })
        migrated++
        summary.push(t('migrate.summaryInput', { copied: result.copied, skipped: result.skipped }))
      }

      if (hasOutput) {
        sendProgress('migrate', { percent: Math.round((migrated / total) * 100), status: t('migrate.mergingOutput') })
        const result = await mergeDirFlat(srcOutput, dstOutput, (copied, skipped, fileTotal) => {
          const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1
          const percent = Math.round(((migrated + sub) / total) * 100)
          sendProgress('migrate', { percent, status: t('migrate.mergingOutput') })
        })
        migrated++
        summary.push(t('migrate.summaryOutput', { copied: result.copied, skipped: result.skipped }))
      }

      sendProgress('migrate', { percent: 100, status: t('common.done') })

      if (wantNodes) {
        sendProgress('deps', { percent: 0, status: t('migrate.checkingDeps') })

        const nodesWithReqs = migratedNodes.filter((n) => n.hasRequirements)
        if (nodesWithReqs.length === 0) {
          sendProgress('deps', { percent: 100, status: t('migrate.noDeps') })
        } else {
          const uvPath = getUvPath(installation.installPath)
          const activePython = getActivePythonPath(installation)

          if (!fs.existsSync(uvPath) || !activePython) {
            sendOutput(t('migrate.noUvOrPython') + '\n')
            sendProgress('deps', { percent: 100, status: t('migrate.depsSkipped') })
          } else {
            const migrateMirror = settings.get('pypiMirror')
            let depsInstalled = 0

            for (const node of nodesWithReqs) {
              const nodReqPath = path.join(dstCustomNodes, node.name, 'requirements.txt')
              sendProgress('deps', {
                percent: Math.round((depsInstalled / nodesWithReqs.length) * 100),
                status: t('migrate.installingNodeDeps', { name: node.name }),
              })

              try {
                const procResult = await installFilteredRequirements(nodReqPath, uvPath, activePython, installation.installPath, `.migrate-reqs-${node.name}.txt`, sendOutput, undefined, { pypiMirror: migrateMirror, useChineseMirrors: settings.get('useChineseMirrors') === true })
                if (procResult !== 0) {
                  sendOutput(`\n⚠ ${node.name}: dependency install exited with code ${procResult}\n`)
                }
              } catch (err) {
                sendOutput(`⚠ ${node.name}: ${(err as Error).message}\n`)
              }

              depsInstalled++
            }

            sendProgress('deps', { percent: 100, status: t('migrate.depsComplete') })
            summary.push(t('migrate.summaryDeps', { count: nodesWithReqs.length }))
          }
        }
      }

      // Install manager_requirements.txt from destination ComfyUI if present
      {
        const dstComfyUIDir = path.join(installation.installPath, 'ComfyUI')
        const mgrReqPath = path.join(dstComfyUIDir, 'manager_requirements.txt')
        if (fs.existsSync(mgrReqPath)) {
          const uvPath = getUvPath(installation.installPath)
          const activePython = getActivePythonPath(installation)

          if (fs.existsSync(uvPath) && activePython) {
            sendOutput('\nInstalling manager requirements…\n')
            const procResult = await installFilteredRequirements(mgrReqPath, uvPath, activePython, installation.installPath, '.migrate-mgr-reqs.txt', sendOutput, undefined, settings.getMirrorConfig())
            if (procResult !== 0) {
              sendOutput(`\n⚠ manager requirements install exited with code ${procResult}\n`)
            }
          }
        }
      }

      sendProgress('done', { percent: 100, status: 'Complete' })
      sendOutput(`\n✓ ${t('migrate.complete')}: ${summary.join(', ')}\n`)

      return { ok: true, navigate: 'detail' }
    }

    return { ok: false, message: `Action "${actionId}" not yet implemented.` }
  },

  async fixupCopy(srcPath: string, destPath: string): Promise<void> {
    const envsDir = path.join(destPath, ENVS_DIR)
    if (!fs.existsSync(envsDir)) return

    for (const envName of listEnvs(destPath)) {
      const envPath = path.join(envsDir, envName)

      const cfgPath = path.join(envPath, 'pyvenv.cfg')
      if (fs.existsSync(cfgPath)) {
        let content = await fs.promises.readFile(cfgPath, 'utf-8')
        content = content.replaceAll(srcPath, destPath)
        await fs.promises.writeFile(cfgPath, content, 'utf-8')
      }

      if (process.platform !== 'win32') {
        const binDir = path.join(envPath, 'bin')
        if (fs.existsSync(binDir)) {
          const entries = await fs.promises.readdir(binDir, { withFileTypes: true })
          for (const entry of entries) {
            if (!entry.isFile()) continue
            const filePath = path.join(binDir, entry.name)
            try {
              let content = await fs.promises.readFile(filePath, 'utf-8')
              if (content.startsWith('#!') && content.includes(srcPath)) {
                content = content.replaceAll(srcPath, destPath)
                await fs.promises.writeFile(filePath, content, 'utf-8')
              }
            } catch {}
          }
        }
      }
    }
  },

  async getFieldOptions(fieldId: string, selections: Record<string, FieldOption | undefined>, context: Record<string, unknown>): Promise<FieldOption[]> {
    if (fieldId === 'release') {
      const [releases, latest] = await Promise.all([
        fetchJSON(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`) as Promise<GitHubRelease[]>,
        (fetchJSON(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`) as Promise<GitHubRelease>).catch(() => null),
      ])
      if (latest && !releases.some((r) => r.id === latest.id)) {
        releases.unshift(latest)
      }
      const filtered = releases.filter((r) => r.assets.some((a) => a.name === 'manifests.json'))
      return filtered.map((r, i) => {
          const name = r.name && r.name !== r.tag_name ? `${r.tag_name}  —  ${r.name}` : r.tag_name
          return { value: r.tag_name, label: name, recommended: i === 0, data: r as unknown as Record<string, unknown> }
        })
    }

    if (fieldId === 'variant') {
      const release = selections.release?.data as unknown as GitHubRelease | undefined
      if (!release) return []
      const prefix = PLATFORM_PREFIX[process.platform]
      if (!prefix) return []

      const manifestAsset = release.assets.find((a) => a.name === 'manifests.json')
      if (!manifestAsset) return []
      const manifests = await fetchJSON(manifestAsset.browser_download_url) as ManifestEntry[]

      const gpu = context?.gpu as string | undefined
      return manifests
        .filter((m) => m.id.startsWith(prefix))
        .map((m): FieldOption | null => {
          const files = m.files || []
          const assets = files
            .map((f) => release.assets.find((a) => a.name === f))
            .filter((a): a is GitHubAsset => a != null)
          if (assets.length === 0) return null
          const totalBytes = assets.reduce((sum, a) => sum + a.size, 0)
          const sizeMB = (totalBytes / 1048576).toFixed(0)
          const downloadFiles = assets.map((a) => ({ url: a.browser_download_url, filename: a.name, size: a.size }))
          const downloadUrl = downloadFiles.length === 1 ? downloadFiles[0]!.url : ''
          return {
            value: downloadFiles.length > 0 ? m.id : '',
            label: getVariantLabel(m.id),
            description: `ComfyUI ${m.comfyui_ref}  ·  Python ${m.python_version}  ·  ${sizeMB} MB`,
            data: { variantId: m.id, manifest: m, downloadFiles, downloadUrl } as unknown as Record<string, unknown>,
            recommended: recommendVariant(m.id, gpu),
          }
        })
        .filter((item): item is FieldOption => item != null)
    }

    return []
  },
}
