import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { spawn, execFile } from 'child_process'
import { fetchJSON } from '../lib/fetch'
import { truncateNotes } from '../lib/comfyui-releases'
import * as releaseCache from '../lib/release-cache'
import { deleteAction, untrackAction } from '../lib/actions'
import { downloadAndExtract, downloadAndExtractMulti } from '../lib/installer'
import { copyDirWithProgress } from '../lib/copy'
import { parseArgs, formatTime } from '../lib/util'
import { t } from '../lib/i18n'
import * as installations from '../installations'
import { listCustomNodes, findComfyUIDir, backupDir, mergeDirFlat } from '../lib/migrate'
import * as settings from '../settings'
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
const RELEASE_REPO = 'Comfy-Org/ComfyUI-Launcher-Environments'
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

function getVariantLabel(variantId: string): string {
  const stripped = variantId.replace(/^(win|mac|linux)-/, '')
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

async function codesignBinaries(dir: string): Promise<void> {
  if (process.platform !== 'darwin') return
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let items: fs.Dirent[]
    try { items = fs.readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const item of items) {
      const full = path.join(current, item.name)
      if (item.isDirectory()) {
        stack.push(full)
      } else if (item.name.endsWith('.dylib') || item.name.endsWith('.so')) {
        await new Promise<void>((resolve) => {
          execFile('codesign', ['--force', '--sign', '-', full], () => resolve())
        })
      }
    }
  }
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
  onProgress: (copied: number, total: number, elapsedSecs: number, etaSecs: number) => void
): Promise<void> {
  const uvPath = getUvPath(installPath)
  const masterPython = getMasterPythonPath(installPath)
  const envPath = path.join(installPath, ENVS_DIR, envName)
  await new Promise<void>((resolve, reject) => {
    execFile(uvPath, ['venv', '--python', masterPython, envPath], { cwd: installPath }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`Failed to create environment "${envName}": ${stderr || err.message}`))
      resolve()
    })
  })

  try {
    const masterSitePackages = findSitePackages(path.join(installPath, 'standalone-env'))
    const envSitePackages = findSitePackages(envPath)
    if (!masterSitePackages || !envSitePackages || !fs.existsSync(masterSitePackages)) {
      throw new Error(`Could not locate site-packages for environment "${envName}".`)
    }
    await copyDirWithProgress(masterSitePackages, envSitePackages, onProgress)
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
  const stripped = variantId.replace(/^(win|mac|linux)-/, '')
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

  getStatusTag(installation: InstallationRecord): StatusTag | undefined {
    const track = (installation.updateTrack as string | undefined) || 'stable'
    const info = releaseCache.getEffectiveInfo(COMFYUI_REPO, track, installation)
    if (info && releaseCache.isUpdateAvailable(installation, track, info)) {
      return { label: t('standalone.updateAvailableTag', { version: info.releaseName || info.latestTag || '' }), style: 'update' }
    }
    return undefined
  },

  buildInstallation(selections: Record<string, FieldOption | undefined>): Record<string, unknown> {
    const vd = selections.variant?.data as VariantData | undefined
    const manifest = vd?.manifest
    return {
      version: manifest?.comfyui_ref || selections.release?.value || 'unknown',
      releaseTag: selections.release?.value || 'unknown',
      variant: vd?.variantId || '',
      downloadUrl: vd?.downloadUrl || '',
      downloadFiles: vd?.downloadFiles || [],
      pythonVersion: manifest?.python_version || '',
      launchArgs: DEFAULT_LAUNCH_ARGS,
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
    const portIdx = parsed.indexOf('--port')
    const port = portIdx >= 0 && parsed[portIdx + 1] ? parseInt(parsed[portIdx + 1]!, 10) || 8188 : 8188
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

    const sections: Record<string, unknown>[] = [
      {
        title: t('common.installInfo'),
        fields: [
          { label: t('common.installMethod'), value: installation.sourceLabel as string },
          { label: t('standalone.comfyui'), value: installation.version },
          { label: t('common.release'), value: (installation.releaseTag as string | undefined) || '—' },
          { label: t('standalone.variant'), value: (installation.variant as string | undefined) ? getVariantLabel(installation.variant as string) : '—' },
          { label: t('standalone.python'), value: (installation.pythonVersion as string | undefined) || '—' },
          { label: t('common.location'), value: installation.installPath || '—' },
          { label: t('common.installed'), value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
    ]

    // Updates section
    const hasGit = installed && installation.installPath && fs.existsSync(path.join(installation.installPath, 'ComfyUI', '.git'))
    const track = (installation.updateTrack as string | undefined) || 'stable'
    const info = releaseCache.getEffectiveInfo(COMFYUI_REPO, track, installation)

    // Build per-track preview info for cards
    const trackOptions = [
      { value: 'stable', label: t('standalone.trackStable'), description: t('standalone.trackStableDesc'), recommended: true },
      { value: 'latest', label: t('standalone.trackLatest'), description: t('standalone.trackLatestDesc') },
    ].map((opt) => {
      const trackInfo = releaseCache.getEffectiveInfo(COMFYUI_REPO, opt.value, installation)
      return {
        ...opt,
        data: trackInfo ? {
          installedVersion: (installation.version as string | undefined) || trackInfo.installedTag || 'unknown',
          latestVersion: trackInfo.releaseName || trackInfo.latestTag || '—',
          lastChecked: trackInfo.checkedAt ? new Date(trackInfo.checkedAt).toLocaleString() : '—',
          updateAvailable: releaseCache.isUpdateAvailable(installation, opt.value, trackInfo),
        } : undefined,
      }
    })

    const updateFields: Record<string, unknown>[] = [
      { id: 'updateTrack', label: t('standalone.updateTrack'), value: track, editable: true,
        refreshSection: true, onChangeAction: 'check-update', editType: 'track-cards', options: trackOptions },
    ]
    const updateActions: Record<string, unknown>[] = []
    if (info && releaseCache.isUpdateAvailable(installation, track, info) && hasGit) {
      const installedDisplay = (installation.version as string | undefined) || info.installedTag || 'unknown'
      const latestDisplay = info.releaseName || info.latestTag || '—'
      const isDowngrade = track === 'stable' && installedDisplay.includes(latestDisplay + ' +')
      const msgKey = isDowngrade ? 'standalone.updateConfirmMessageDowngrade'
        : track === 'latest' ? 'standalone.updateConfirmMessageLatest'
        : 'standalone.updateConfirmMessage'
      const notes = truncateNotes(info.releaseNotes || '', 2000)
      updateActions.push({
        id: 'update-comfyui', label: t('standalone.updateNow'), style: 'primary', enabled: installed,
        showProgress: true, progressTitle: t('standalone.updatingTitle', { version: latestDisplay }),
        confirm: {
          title: t('standalone.updateConfirmTitle'),
          message: t(msgKey, {
            installed: installedDisplay,
            latest: latestDisplay,
            commit: notes || '',
            notes: notes || '(none)',
          }),
        },
      })
      updateActions.push({
        id: 'copy-update', label: t('standalone.copyAndUpdate'), style: 'default', enabled: installed,
        showProgress: true, progressTitle: t('standalone.copyUpdatingTitle', { version: latestDisplay }),
        cancellable: true,
        prompt: {
          title: t('standalone.copyAndUpdateTitle'),
          message: t('standalone.copyAndUpdateMessage', { installed: installedDisplay, latest: latestDisplay }),
          defaultValue: `${installation.name} (${latestDisplay})`,
          confirmLabel: t('standalone.copyAndUpdateConfirm'),
          required: true,
          field: 'name',
        },
      })
    }
    updateActions.push({
      id: 'check-update', label: t('actions.checkForUpdate'), style: 'default', enabled: installed,
    })
    sections.push({
      title: t('standalone.updates'),
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
      {
        title: t('common.advanced'),
        collapsed: true,
        actions: [
          { id: 'release-update', label: t('standalone.releaseUpdate'), style: 'default', enabled: installed,
            showProgress: true, progressTitle: t('standalone.releaseUpdatingTitle'), cancellable: true,
            fieldSelects: [
              { sourceId: 'standalone', fieldId: 'release', field: 'releaseSelection',
                title: t('standalone.releaseUpdateSelectRelease'),
                message: t('standalone.releaseUpdateSelectReleaseMessage') },
              { sourceId: 'standalone', fieldId: 'variant', field: 'variantSelection',
                title: t('standalone.releaseUpdateSelectVariant'),
                message: t('standalone.releaseUpdateSelectVariantMessage') },
            ],
            prompt: {
              title: t('standalone.releaseUpdateTitle'),
              message: t('standalone.releaseUpdateNameMessage'),
              defaultValue: `${installation.name} (Release Update)`,
              confirmLabel: t('standalone.releaseUpdateConfirm'),
              required: true,
              field: 'name',
            } },
          { id: 'migrate-from', label: t('migrate.migrateFrom'), style: 'default', enabled: installed,
            showProgress: true, progressTitle: t('migrate.migrating'), cancellable: true,
            select: {
              title: t('migrate.selectSource'),
              message: t('migrate.selectSourceMessage'),
              emptyMessage: t('migrate.noInstallations'),
              source: 'installations',
              field: 'sourceInstallationId',
              excludeSelf: true,
              filters: { status: 'installed', sourceCategory: 'local' },
            },
            confirm: {
              title: t('migrate.confirmTitle'),
              message: t('migrate.confirmMessage'),
              confirmLabel: t('migrate.migrateConfirm'),
              options: [
                { id: 'customNodes', label: t('migrate.optCustomNodes'), checked: true },
                { id: 'workflows', label: t('migrate.optWorkflows'), checked: false },
                { id: 'userSettings', label: t('migrate.optUserSettings'), checked: false },
                { id: 'models', label: t('migrate.optModels'), checked: false },
                { id: 'input', label: t('migrate.optInput'), checked: false },
                { id: 'output', label: t('migrate.optOutput'), checked: false },
              ],
            } },
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

  async postInstall(installation: InstallationRecord, { sendProgress, update }: PostInstallTools): Promise<void> {
    if (process.platform !== 'win32') {
      const binDir = path.join(installation.installPath, 'standalone-env', 'bin')
      try {
        const entries = fs.readdirSync(binDir)
        for (const entry of entries) {
          const fullPath = path.join(binDir, entry)
          try { fs.chmodSync(fullPath, 0o755) } catch {}
        }
      } catch {}
    }
    sendProgress('setup', { percent: 0, status: 'Creating default Python environment…' })
    await createEnv(installation.installPath, DEFAULT_ENV, (copied, total, elapsedSecs, etaSecs) => {
      const percent = Math.round((copied / total) * 100)
      const elapsed = formatTime(elapsedSecs)
      const eta = etaSecs >= 0 ? formatTime(etaSecs) : '—'
      sendProgress('setup', { percent, status: `Copying packages… ${copied} / ${total} files  ·  ${elapsed} elapsed  ·  ${eta} remaining` })
    })
    const envMethods = { ...(installation.envMethods as Record<string, string> | undefined), [DEFAULT_ENV]: ENV_METHOD }
    await update({ envMethods })
    sendProgress('cleanup', { percent: -1, status: t('standalone.cleanupEnvStatus') })
    await stripMasterPackages(installation.installPath)
  },

  probeInstallation(dirPath: string): Record<string, unknown> | null {
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

    return {
      version,
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
    if (actionId === 'check-update') {
      const track = (installation.updateTrack as string | undefined) || 'stable'
      return releaseCache.checkForUpdate(COMFYUI_REPO, track, installation, update)
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

      const track = (installation.updateTrack as string | undefined) || 'stable'
      const stableArgs = track === 'stable' ? ['--stable'] : []

      const reqPath = path.join(comfyuiDir, 'requirements.txt')
      let preReqs = ''
      try { preReqs = await fs.promises.readFile(reqPath, 'utf-8') } catch {}

      sendProgress('steps', { steps: [
        { phase: 'prepare', label: t('standalone.updatePrepare') },
        { phase: 'run', label: t('standalone.updateRun') },
        { phase: 'deps', label: t('standalone.updateDeps') },
      ] })

      sendProgress('prepare', { percent: -1, status: t('standalone.updatePrepare') })

      sendProgress('run', { percent: -1, status: t('standalone.updateRun') })

      const updateScript = app.isPackaged
        ? path.join(process.resourcesPath, 'lib', 'update_comfyui.py')
        : path.join(__dirname, '..', '..', 'lib', 'update_comfyui.py')
      const markers: Record<string, string> = {}
      let stdoutBuf = ''
      const exitCode = await new Promise<number>((resolve) => {
        const proc = spawn(masterPython, ['-s', updateScript, comfyuiDir, ...stableArgs], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        if (signal) {
          const onAbort = (): void => { proc.kill() }
          signal.addEventListener('abort', onAbort, { once: true })
          proc.on('exit', () => signal.removeEventListener('abort', onAbort))
        }
        proc.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8')
          stdoutBuf += text
          const lines = stdoutBuf.split(/\r?\n/)
          stdoutBuf = lines.pop()!
          for (const line of lines) {
            const match = line.match(/^\[(\w+)\]\s*(.+)$/)
            if (match) markers[match[1]!] = match[2]!.trim()
          }
          sendOutput(text)
        })
        proc.stderr.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
        proc.on('error', (err) => {
          sendOutput(`Error: ${err.message}\n`)
          resolve(1)
        })
        proc.on('exit', (code) => resolve(code ?? 1))
      })
      if (stdoutBuf) {
        const match = stdoutBuf.match(/^\[(\w+)\]\s*(.+)$/)
        if (match) markers[match[1]!] = match[2]!.trim()
      }

      if (exitCode !== 0) {
        return { ok: false, message: t('standalone.updateFailed', { code: exitCode }) }
      }

      if (signal?.aborted) return { ok: false, message: 'Cancelled' }
      sendProgress('deps', { percent: -1, status: t('standalone.updateDepsChecking') })

      let postReqs = ''
      try { postReqs = await fs.promises.readFile(reqPath, 'utf-8') } catch {}

      if (preReqs !== postReqs && postReqs.length > 0) {
        const uvPath = getUvPath(installPath)
        const activeEnvPython = getActivePythonPath(installation)

        if (fs.existsSync(uvPath) && activeEnvPython) {
          const PYTORCH_RE = /^(torch|torchvision|torchaudio|torchsde)(\s*[<>=!~;[#]|$)/i
          const filteredReqs = postReqs.split('\n').filter((l) => !PYTORCH_RE.test(l.trim())).join('\n')
          const filteredReqPath = path.join(installPath, '.comfyui-reqs-filtered.txt')
          await fs.promises.writeFile(filteredReqPath, filteredReqs, 'utf-8')

          try {
            sendProgress('deps', { percent: -1, status: t('standalone.updateDepsDryRun') })
            if (signal?.aborted) return { ok: false, message: 'Cancelled' }
            const dryRunResult = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
              const proc = spawn(uvPath, ['pip', 'install', '--dry-run', '-r', filteredReqPath, '--python', activeEnvPython], {
                cwd: installPath,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
              })
              if (signal) {
                const onAbort = (): void => { proc.kill() }
                signal.addEventListener('abort', onAbort, { once: true })
                proc.on('exit', () => signal.removeEventListener('abort', onAbort))
              }
              let stdout = ''
              let stderr = ''
              proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
              proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })
              proc.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }))
              proc.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }))
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
              const proc = spawn(uvPath, ['pip', 'install', '-r', filteredReqPath, '--python', activeEnvPython], {
                cwd: installPath,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
              })
              if (signal) {
                const onAbort = (): void => { proc.kill() }
                signal.addEventListener('abort', onAbort, { once: true })
                proc.on('exit', () => signal.removeEventListener('abort', onAbort))
              }
              proc.stdout.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
              proc.stderr.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
              proc.on('error', (err) => {
                sendOutput(`Error: ${err.message}\n`)
                resolve(1)
              })
              proc.on('exit', (code) => resolve(code ?? 1))
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

      const cachedRelease = releaseCache.get(COMFYUI_REPO, track) || {}
      const postHead = markers.POST_UPDATE_HEAD ? markers.POST_UPDATE_HEAD.slice(0, 7) : null
      const installedTag = markers.CHECKED_OUT_TAG || postHead || cachedRelease.latestTag || (installation.version as string | undefined) || 'unknown'
      const displayVersion = markers.CHECKED_OUT_TAG || cachedRelease.releaseName || installedTag
      const rollback = {
        preUpdateHead: markers.PRE_UPDATE_HEAD || null,
        postUpdateHead: markers.POST_UPDATE_HEAD || null,
        backupBranch: markers.BACKUP_BRANCH || null,
        track,
        updatedAt: Date.now(),
      }
      const existing = (installation.updateInfoByTrack as Record<string, Record<string, unknown>> | undefined) || {}
      await update({
        version: displayVersion,
        lastRollback: rollback,
        updateInfoByTrack: {
          ...existing,
          [track]: { installedTag },
        },
      })

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
            const PYTORCH_RE = /^(torch|torchvision|torchaudio|torchsde)(\s*[<>=!~;[#]|$)/i
            let depsInstalled = 0

            for (const node of nodesWithReqs) {
              const nodReqPath = path.join(dstCustomNodes, node.name, 'requirements.txt')
              sendProgress('deps', {
                percent: Math.round((depsInstalled / nodesWithReqs.length) * 100),
                status: t('migrate.installingNodeDeps', { name: node.name }),
              })

              try {
                const reqContent = await fs.promises.readFile(nodReqPath, 'utf-8')
                const filtered = reqContent.split('\n').filter((l) => !PYTORCH_RE.test(l.trim())).join('\n')
                const filteredReqPath = path.join(installation.installPath, `.migrate-reqs-${node.name}.txt`)
                await fs.promises.writeFile(filteredReqPath, filtered, 'utf-8')

                try {
                  const procResult = await new Promise<number>((resolve) => {
                    const proc = spawn(uvPath, ['pip', 'install', '-r', filteredReqPath, '--python', activePython], {
                      cwd: installation.installPath,
                      stdio: ['ignore', 'pipe', 'pipe'],
                      windowsHide: true,
                    })
                    proc.stdout.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
                    proc.stderr.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
                    proc.on('error', (err) => {
                      sendOutput(`Error: ${err.message}\n`)
                      resolve(1)
                    })
                    proc.on('exit', (code) => resolve(code ?? 1))
                  })

                  if (procResult !== 0) {
                    sendOutput(`\n⚠ ${node.name}: dependency install exited with code ${procResult}\n`)
                  }
                } finally {
                  try { await fs.promises.unlink(filteredReqPath) } catch {}
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
      return releases
        .filter((r) => r.assets.some((a) => a.name === 'manifests.json'))
        .map((r) => {
          const name = r.name && r.name !== r.tag_name ? `${r.tag_name}  —  ${r.name}` : r.tag_name
          return { value: r.tag_name, label: name, data: r as unknown as Record<string, unknown> }
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
