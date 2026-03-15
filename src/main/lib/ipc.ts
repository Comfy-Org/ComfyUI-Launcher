import path from 'path'
import fs from 'fs'
import os from 'os'
import { app, ipcMain, dialog, shell, BrowserWindow, nativeTheme } from 'electron'
import { execFile, spawn, execFileSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import sources from '../sources/index'
import * as installations from '../installations'
import type { InstallationRecord } from '../installations'
import { formatComfyVersion } from './version'
import type { ComfyVersion } from './version'
import { resolveLocalVersion, clearVersionCache } from './version-resolve'
import type { LatestTagOverride } from './version-resolve'
import { readGitRemoteUrl, fetchTags, findLatestVersionTag, revParseRef, hasGitDir } from './git'
import * as settings from '../settings'
import { defaultInstallDir } from './paths'
import { download } from './download'
import { createCache } from './cache'
import { extractNested as extract } from './extract'
import { deleteDir } from './delete'
import { deleteAction, untrackAction } from './actions'
import {
  spawnProcess, waitForPort, waitForUrl, killProcessTree, killByPort,
  findPidsByPort, getProcessInfo, looksLikeComfyUI, setPortArg,
  findAvailablePort, writePortLock, readPortLock, removePortLock,
} from './process'
import { detectGPU, validateHardware, checkNvidiaDriver } from './gpu'
import { detectDesktopInstall, stageDesktopSnapshot } from './desktopDetect'
import { performDesktopMigration } from './desktopMigration'
import { performLocalMigration, stageLocalSnapshot } from './localMigration'
import { getDiskSpace, getDirectorySize, validateInstallPath } from './disk'
import type { GpuInfo } from './gpu'
import { formatTime } from './util'
import { getActiveDownloads } from './comfyDownloadManager'
import * as releaseCache from './release-cache'
import * as i18n from './i18n'
import { ensureModelPathsConfig } from './models'
import { copyDirWithProgress } from './copy'
import { fetchJSON } from './fetch'
import { fetchLatestRelease } from './comfyui-releases'
import { captureSnapshotIfChanged, getSnapshotCount, getSnapshotListData, getSnapshotDetailData, getSnapshotDiffVsPrevious, diffAgainstCurrent, loadSnapshot, listSnapshots, buildExportEnvelope, validateExportEnvelope, importSnapshots, saveSnapshot, restoreCustomNodes, restorePipPackages, restoreComfyUIVersion, buildPostRestoreState, formatSnapshotVersion } from './snapshots'
import type { SnapshotExportEnvelope } from './snapshots'
import { getVariantLabel } from '../sources/standalone'
import type { FieldOption, SourcePlugin } from '../types/sources'
import { REQUIRES_STOPPED } from '../../types/ipc'
import type { Theme, ResolvedTheme, QuitActiveItem } from '../../types/ipc'
import { findLockingProcesses } from './file-lock-info'
import type { LaunchCmd } from './process'

const MARKER_FILE = '.comfyui-desktop-2'
const COMFYUI_REPO = 'Comfy-Org/ComfyUI'
const UPDATE_CHECK_INTERVAL = 10 * 60 * 1000
const IGNORE_FILES = new Set([MARKER_FILE, '.DS_Store', 'Thumbs.db', 'desktop.ini'])


function isEffectivelyEmptyInstallDir(dirPath: string): boolean {
  if (!dirPath) return true
  try {
    const entries = fs.readdirSync(dirPath)
    return entries.every((name) => IGNORE_FILES.has(name))
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  }
}

function openPath(targetPath: string): Promise<string> {
  if (process.platform === 'linux') {
    return new Promise((resolve) => {
      execFile('dbus-send', [
        '--session', '--print-reply', '--type=method_call',
        '--dest=org.freedesktop.FileManager1',
        '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1.ShowFolders',
        `array:string:file://${targetPath}`, 'string:',
      ], (err) => {
        if (!err) return resolve('')
        const child = spawn('xdg-open', [targetPath], { stdio: 'ignore', detached: true })
        child.unref()
        resolve('')
      })
    })
  }
  return shell.openPath(targetPath)
}

export function getAppVersion(): string {
  let version = app.getVersion()
  if (!app.isPackaged) {
    try {
      version = execFileSync('git', ['describe', '--tags', '--always'], { cwd: __dirname, encoding: 'utf8' }).trim() || version
    } catch {}
  }
  return version.replace(/^v/, '')
}

const sourceMap: Record<string, SourcePlugin> = Object.fromEntries(sources.map((s) => [s.id, s]))


async function findDuplicatePath(installPath: string): Promise<InstallationRecord | null> {
  const normalized = path.resolve(installPath)
  return (await installations.list()).find((i) => i.installPath && path.resolve(i.installPath) === normalized) ?? null
}

async function uniqueName(baseName: string): Promise<string> {
  const all = await installations.list()
  return installations.uniqueName(baseName, all)
}

/** Re-assign primary to the first remaining local install, or clear it. */
function isPromotableLocal(sourceId: string): boolean {
  const source = sourceMap[sourceId]
  return !!source && source.category === 'local' && sourceId !== 'desktop'
}

async function autoAssignPrimary(removedId: string): Promise<void> {
  const currentPrimary = settings.get('primaryInstallId')
  if (currentPrimary !== removedId) return
  const all = (await installations.list()).filter((i) => i.id !== removedId)
  const firstLocal = all.find((i) => isPromotableLocal(i.sourceId))
  settings.set('primaryInstallId', firstLocal?.id)
}

/** Set as primary if this is the first local install and no primary is set. */
function ensureDefaultPrimary(entry: InstallationRecord): void {
  if (isPromotableLocal(entry.sourceId) && !settings.get('primaryInstallId')) {
    settings.set('primaryInstallId', entry.id)
  }
}

interface SessionInfo {
  proc: ChildProcess | null
  port: number
  url?: string
  mode: string
  installationName: string
  startedAt: number
}

interface LaunchCallbackInfo {
  port: number
  url?: string
  process: ChildProcess | null
  installation: InstallationRecord
  mode: string
}

interface StopCallbackInfo {
  installationId?: string
}

interface ExitCallbackInfo {
  installationId?: string
}

interface RestartCallbackInfo {
  installationId?: string
  process?: ChildProcess
}

type LaunchCallback = (info: LaunchCallbackInfo) => void
type StopCallback = (info: StopCallbackInfo) => void
type ExitCallback = (info: ExitCallbackInfo) => void
type RestartCallback = (info: RestartCallbackInfo) => void
type LocaleCallback = () => void

interface RegisterCallbacks {
  onLaunch?: LaunchCallback
  onStop?: StopCallback
  onComfyExited?: ExitCallback
  onComfyRestarted?: RestartCallback
  onLocaleChanged?: LocaleCallback
}

type CopyReason = 'copy' | 'copy-update'

async function copyBrowserPartition(sourceId: string, destId: string, sourceBrowserPartition?: string): Promise<void> {
  if (sourceBrowserPartition !== 'unique') return
  const partitionsDir = path.join(app.getPath('userData'), 'Partitions')
  const srcPartition = path.join(partitionsDir, sourceId)
  const destPartition = path.join(partitionsDir, destId)
  try {
    if (fs.existsSync(srcPartition)) {
      await fs.promises.cp(srcPartition, destPartition, { recursive: true })
    }
  } catch (err) {
    console.warn('Failed to copy browser partition:', (err as Error).message)
  }
}

async function performCopy(
  inst: InstallationRecord,
  name: string,
  sendProgress: (phase: string, detail: Record<string, unknown>) => void,
  signal?: AbortSignal,
  copyReason: CopyReason = 'copy'
): Promise<{ entry: InstallationRecord; destPath: string }> {
  const parentDir = path.dirname(inst.installPath)
  const dirName = name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'ComfyUI'
  let destPath = path.join(parentDir, dirName)
  let suffix = 1
  while (fs.existsSync(destPath)) {
    destPath = path.join(parentDir, `${dirName} (${suffix})`)
    suffix++
  }

  const duplicate = await findDuplicatePath(destPath)
  if (duplicate) {
    throw new Error(`That directory is already used by "${duplicate.name}".`)
  }

  try {
    sendProgress('copy', { percent: 0, status: i18n.t('actions.copyingFiles') })
    await copyDirWithProgress(inst.installPath, destPath, (copied, total, elapsedSecs, etaSecs) => {
      const percent = Math.round((copied / total) * 100)
      const elapsed = formatTime(elapsedSecs)
      const eta = etaSecs >= 0 ? formatTime(etaSecs) : '—'
      sendProgress('copy', {
        percent,
        status: `${i18n.t('actions.copyingFiles')}  ${copied} / ${total}  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
      })
    }, { signal })

    const source = sourceMap[inst.sourceId]
    if (source?.fixupCopy) {
      await source.fixupCopy(inst.installPath, destPath)
    }

    const {
      id: _id, name: _name, installPath: _path, createdAt: _created, seen: _seen, status: _status,
      copiedFrom: _copiedFrom, copiedAt: _copiedAt, copiedFromName: _copiedFromName, copyReason: _copyReason,
      ...inherited
    } = inst
    const finalName = await uniqueName(name)
    const entry = await installations.add({
      ...inherited,
      name: finalName,
      installPath: destPath,
      status: 'installed',
      seen: false,
      browserPartition: 'unique',
      copiedFrom: inst.id,
      copiedFromName: inst.name,
      copiedAt: new Date().toISOString(),
      copyReason,
    })

    try { fs.writeFileSync(path.join(destPath, MARKER_FILE), entry.id) } catch {}

    await copyBrowserPartition(inst.id, entry.id, inst.browserPartition as string | undefined)

    return { entry, destPath }
  } catch (err) {
    try { await fs.promises.rm(destPath, { recursive: true, force: true }) } catch {}
    throw err
  }
}

function createSessionPath(): string {
  return path.join(os.tmpdir(), `comfyui-desktop-2-${Date.now()}`)
}

function checkRebootMarker(sessionPath: string): boolean {
  const marker = sessionPath + '.reboot'
  if (fs.existsSync(marker)) {
    try { fs.unlinkSync(marker) } catch {}
    return true
  }
  return false
}

let _onLaunch: LaunchCallback | null = null
let _onStop: StopCallback | null = null
let _onComfyExited: ExitCallback | null = null
let _onComfyRestarted: RestartCallback | null = null
let _onLocaleChanged: LocaleCallback | null = null
let _gpuPromise: Promise<GpuInfo | null> | null = null

const _operationAborts = new Map<string, AbortController>()
const _runningSessions = new Map<string, SessionInfo>()
const _pendingPorts = new Map<number, string>() // port → installationName

function _reservePort(port: number, installationName: string): void {
  _pendingPorts.set(port, installationName)
}

function _releasePort(port: number): void {
  _pendingPorts.delete(port)
}

function _broadcastToRenderer(channel: string, data: Record<string, unknown>): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  })
}

/**
 * Fetch tags once per unique remote origin, resolve the latest tag name +
 * SHA, then return a map from origin URL to the override info.
 */
async function _fetchAndResolveLatestTags(
  installs: Array<{ comfyuiDir: string }>
): Promise<Map<string, LatestTagOverride>> {
  // Group by remote origin URL
  const originGroups = new Map<string, string[]>()
  for (const { comfyuiDir } of installs) {
    const origin = readGitRemoteUrl(comfyuiDir)
    if (!origin) continue
    const group = originGroups.get(origin) ?? []
    group.push(comfyuiDir)
    originGroups.set(origin, group)
  }

  const result = new Map<string, LatestTagOverride>()
  await Promise.all([...originGroups.entries()].map(async ([origin, dirs]) => {
    // Fetch tags into ALL repos in the group so every repo has the
    // commit objects needed for SHA-based merge-base / ancestry checks.
    await Promise.all(dirs.map((d) => fetchTags(d)))
    const representative = dirs[0]!
    const tagName = await findLatestVersionTag(representative)
    if (!tagName) return
    const sha = await revParseRef(representative, tagName)
    if (!sha) return
    result.set(origin, { name: tagName, sha })
  }))
  return result
}

/**
 * Resolve versions from git state for all installations, fetch tags once
 * per unique remote origin, persist updates to the installation records,
 * and broadcast changes to the renderer.  Called in the background after
 * get-installations returns.
 */
async function _resolveAndBroadcastVersions(list: InstallationRecord[]): Promise<void> {
  // Collect installations with ComfyUI git repos
  const candidates = list.flatMap((inst) => {
    const cv = inst.comfyVersion as ComfyVersion | undefined
    if (!cv?.commit || !inst.installPath) return []
    const comfyuiDir = path.join(inst.installPath, 'ComfyUI')
    if (!hasGitDir(comfyuiDir)) return []
    return [{ inst, cv, comfyuiDir }]
  })
  if (candidates.length === 0) return

  // Fetch tags once per unique origin and resolve latest tag info
  const tagOverrides = await _fetchAndResolveLatestTags(candidates)

  // Clear cache AFTER fetching so concurrent resolveLocalVersion calls
  // during the fetch don't repopulate the cache with stale data.
  clearVersionCache()

  // Resolve each installation's version
  const updates: { id: string; version: string }[] = []
  await Promise.all(candidates.map(async ({ inst, cv, comfyuiDir }) => {
    const origin = readGitRemoteUrl(comfyuiDir)
    const override = origin ? tagOverrides.get(origin) : undefined
    try {
      const resolved = await resolveLocalVersion(comfyuiDir, cv.commit, undefined, override)
      const resolvedStr = formatComfyVersion(resolved, 'short')
      const storedStr = formatComfyVersion(cv, 'short')
      if (resolvedStr !== storedStr) {
        // Persist to the installation record so all surfaces (Status tab,
        // Update tab, etc.) read the same resolved version.
        await installations.update(inst.id, { comfyVersion: resolved })
        updates.push({ id: inst.id, version: resolvedStr })
      }
    } catch {
      // ignore — keep stored version
    }
  }))
  if (updates.length > 0) {
    _broadcastToRenderer('installations-versions-updated', { updates })
  }
}

function _addSession(installationId: string, { proc, port, url, mode, installationName }: Omit<SessionInfo, 'startedAt'>): void {
  _runningSessions.set(installationId, { proc, port, url, mode, installationName, startedAt: Date.now() })
  _broadcastToRenderer('instance-started', { installationId, port, url, mode, installationName })
  installations.update(installationId, { lastLaunchedAt: Date.now() })
    .then(() => _broadcastToRenderer('installations-changed', {}))
    .catch((err) => {
      console.error('Failed to update lastLaunchedAt:', err)
    })
}

function _removeSession(installationId: string): void {
  const session = _runningSessions.get(installationId)
  if (!session) return
  if (session.port) removePortLock(session.port)
  _runningSessions.delete(installationId)
  _broadcastToRenderer('instance-stopped', { installationId })
}

function _getPublicSessions(): Record<string, unknown>[] {
  return Array.from(_runningSessions.entries()).map(([id, s]) => ({
    installationId: id,
    port: s.port,
    url: s.url,
    mode: s.mode,
    installationName: s.installationName,
    startedAt: s.startedAt,
  }))
}

async function migrateDefaults(): Promise<void> {
  const all = await installations.list()
  let changed = false
  for (const inst of all) {
    const source = sourceMap[inst.sourceId]
    if (!source || !source.getDefaults) continue
    const defaults = source.getDefaults()
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in inst)) {
        inst[key] = value
        changed = true
      }
    }
    if (inst.updateInfoByChannel) {
      const repo = 'Comfy-Org/ComfyUI'
      const channelMap = inst.updateInfoByChannel as Record<string, Record<string, unknown>>
      for (const [channel, info] of Object.entries(channelMap)) {
        if (info.latestTag && !releaseCache.get(repo, channel)) {
          const { installedTag: _it, available: _av, ...releaseFields } = info
          releaseCache.set(repo, channel, releaseFields)
        }
        if (info.latestTag || info.releaseName || info.releaseNotes) {
          channelMap[channel] = { installedTag: info.installedTag }
          changed = true
        }
      }
    }
  }
  if (changed) {
    for (const inst of all) await installations.update(inst.id, inst)
  }
}

function resolveTheme(): ResolvedTheme {
  const theme = (settings.get('theme') as Theme | undefined) || 'system'
  return theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : theme
}

const ALL_UPDATE_CHANNELS = ['stable', 'latest']

async function checkInstallationUpdates(): Promise<void> {
  try {
    await Promise.allSettled(
      ALL_UPDATE_CHANNELS.map((channel) =>
        releaseCache.getOrFetch(COMFYUI_REPO, channel, async () => {
          const release = await fetchLatestRelease(channel)
          if (!release) return null
          return releaseCache.buildCacheEntry(release)
        }, true)
      )
    )
    _broadcastToRenderer('installations-changed', {})
  } catch {}
}

export function register(callbacks: RegisterCallbacks = {}): void {
  _onLaunch = callbacks.onLaunch ?? null
  _onStop = callbacks.onStop ?? null
  _onComfyExited = callbacks.onComfyExited ?? null
  _onComfyRestarted = callbacks.onComfyRestarted ?? null
  _onLocaleChanged = callbacks.onLocaleChanged ?? null

  installations.seedDefaults([
    {
      name: 'Comfy Cloud',
      sourceId: 'cloud',
      remoteUrl: 'https://cloud.comfy.org/',
      launchMode: 'window',
      browserPartition: 'shared',
    },
  ])
  installations.ensureExists('cloud', {
    name: 'Comfy Cloud',
    sourceId: 'cloud',
    remoteUrl: 'https://cloud.comfy.org/',
    launchMode: 'window',
    browserPartition: 'shared',
    status: 'installed',
  })

  // Auto-track Desktop install if detected
  {
    const desktopInfo = detectDesktopInstall()
    if (desktopInfo) {
      installations.ensureExists('desktop', {
        name: 'ComfyUI Legacy Desktop',
        sourceId: 'desktop',
        installPath: desktopInfo.basePath,
        launchMode: 'external',
        desktopExePath: desktopInfo.executablePath || undefined,
        status: 'installed',
      })
    }
  }

  migrateDefaults()

  // Sweep empty/broken local installations on startup, then clean stale settings references
  void (async () => {
    try {
      const all = await installations.list()
      let swept = false
      for (const inst of all) {
        const source = sourceMap[inst.sourceId]
        if (!source || source.skipInstall) continue
        if (!inst.installPath) continue
        if (!isEffectivelyEmptyInstallDir(inst.installPath)) continue
        try { fs.rmSync(inst.installPath, { recursive: true, force: true }) } catch {}
        await installations.remove(inst.id)
        swept = true
      }

      // Clean stale references from settings against the current installation list
      const remaining = swept ? await installations.list() : all
      const validIds = new Set(remaining.map((i) => i.id))
      let settingsChanged = false

      const currentPrimary = settings.get('primaryInstallId')
      if (currentPrimary && !validIds.has(currentPrimary)) {
        await autoAssignPrimary(currentPrimary)
        settingsChanged = true
      }

      const rawPinned = settings.get('pinnedInstallIds')
      const pinned = Array.isArray(rawPinned) ? rawPinned as string[] : []
      const filtered = pinned.filter((id) => validIds.has(id))
      if (filtered.length !== pinned.length) {
        settings.set('pinnedInstallIds', filtered)
        settingsChanged = true
      }

      if (swept || settingsChanged) _broadcastToRenderer('installations-changed', {})
    } catch {}
  })()

  // Clean up partial downloads left over from previous interrupted sessions
  void (async () => {
    try {
      const cache = createCache(settings.get('cacheDir') as string, settings.get('maxCachedFiles') as number)
      await cache.cleanPartials()
    } catch {}
  })()

  // Pre-warm the ETag cache for GitHub API URLs
  void (async () => {
    try {
      await Promise.allSettled([
        fetchJSON('https://api.github.com/repos/Comfy-Org/ComfyUI-Standalone-Environments/releases?per_page=30'),
        fetchJSON('https://api.github.com/repos/Comfy-Org/ComfyUI-Standalone-Environments/releases/latest'),
        fetchJSON('https://api.github.com/repos/Comfy-Org/ComfyUI/releases?per_page=30'),
      ])
    } catch {}
  })()

  // Check installation updates on startup and periodically
  setTimeout(() => checkInstallationUpdates(), 3_000)
  setInterval(() => checkInstallationUpdates(), UPDATE_CHECK_INTERVAL)

  // App version
  ipcMain.handle('get-app-version', () => getAppVersion())

  // Sources
  ipcMain.handle('get-sources', () =>
    sources
      .filter((s) => s.category !== 'cloud' && !s.hidden)
      .filter((s) => !s.platforms || s.platforms.includes(process.platform))
      .map((s) => ({ id: s.id, label: s.label, category: s.category, description: s.description, fields: s.fields, skipInstall: !!s.skipInstall, hideInstallPath: !!s.skipInstall }))
  )

  ipcMain.handle('get-field-options', async (_event, sourceId: string, fieldId: string, selections: Record<string, unknown>) => {
    const source = sourceMap[sourceId]
    if (!source) return []
    if (!_gpuPromise) {
      _gpuPromise = detectGPU().catch(() => null)
    }
    const gpu = await _gpuPromise
    const options = await source.getFieldOptions(
      fieldId,
      selections as Record<string, FieldOption | undefined>,
      { gpu: gpu && gpu.id }
    )
    return options
  })

  ipcMain.handle('detect-gpu', async () => {
    if (!_gpuPromise) {
      _gpuPromise = detectGPU().catch(() => null)
    }
    return _gpuPromise
  })

  ipcMain.handle('validate-hardware', () => validateHardware())
  ipcMain.handle('check-nvidia-driver', () => checkNvidiaDriver())

  ipcMain.handle('build-installation', (_event, sourceId: string, selections: Record<string, unknown>) => {
    const source = sourceMap[sourceId]
    if (!source) return null
    return {
      sourceId: source.id,
      sourceLabel: source.label,
      ...source.buildInstallation(selections as Record<string, FieldOption | undefined>),
    }
  })

  // Paths
  ipcMain.handle('get-default-install-dir', () => defaultInstallDir())

  ipcMain.handle('browse-folder', async (_event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      defaultPath: defaultPath || defaultInstallDir(),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (canceled || filePaths.length === 0) return null
    return filePaths[0]
  })

  ipcMain.handle('open-path', (_event, targetPath: string) => {
    if (typeof targetPath !== 'string' || !targetPath) return ''
    // Allow http/https URLs (used to open ComfyUI in the default browser)
    if (/^https?:\/\//i.test(targetPath)) return shell.openExternal(targetPath)
    // Filesystem paths: resolve to absolute and verify they exist
    const resolved = path.resolve(targetPath)
    if (!fs.existsSync(resolved)) return ''
    return openPath(resolved)
  })
  ipcMain.handle('open-external', (_event, url: string) => {
    if (typeof url !== 'string' || !url) return Promise.resolve()
    // Only allow http and https URLs
    if (!/^https?:\/\//i.test(url)) return Promise.resolve()
    return shell.openExternal(url)
  })
  ipcMain.handle('get-disk-space', (_event, targetPath: string) => getDiskSpace(targetPath))
  ipcMain.handle('validate-install-path', (_event, targetPath: string) => validateInstallPath(targetPath))
  ipcMain.handle('get-installation-size', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst?.installPath) return { sizeBytes: 0 }
    const sizeBytes = await getDirectorySize(inst.installPath)
    return { sizeBytes }
  })

  // Installations
  ipcMain.handle('get-installations', async () => {
    const list = (await installations.list()).filter((i) => i.status !== 'installing')

    // Ensure a primary is always set when promotable local installs exist
    const currentPrimary = settings.get('primaryInstallId')
    if (!currentPrimary || !list.some((i) => i.id === currentPrimary)) {
      const firstLocal = list.find((i) => isPromotableLocal(i.sourceId))
      const newPrimary = firstLocal?.id
      if (currentPrimary !== newPrimary) {
        settings.set('primaryInstallId', newPrimary)
      }
    }

    const result = list.map((inst) => {
      const source = sourceMap[inst.sourceId]
      if (!source) return inst
      const listPreview = source.getListPreview ? source.getListPreview(inst) : undefined
      const statusTag = inst.status === 'partial-delete'
        ? { label: i18n.t('errors.deleteInterrupted'), style: 'danger' }
        : inst.status === 'failed'
        ? { label: i18n.t('errors.installFailed'), style: 'danger' }
        : (source.getStatusTag ? source.getStatusTag(inst) : undefined)
      // Derive version display string from stored comfyVersion, falling back to legacy string.
      // Omit version when it just duplicates the source type (e.g. 'cloud', 'desktop').
      // Resolved versions are sent asynchronously via 'installations-versions-updated'.
      const cv = inst.comfyVersion as ComfyVersion | undefined
      const rawVersion = cv ? formatComfyVersion(cv, 'short') : (inst.version as string | undefined)
      const version = rawVersion === inst.sourceId ? undefined : rawVersion
      return {
        ...inst,
        version,
        sourceLabel: source.label,
        sourceCategory: source.category,
        hasConsole: source.hasConsole !== false,
        ...(listPreview != null ? { listPreview } : {}),
        ...(statusTag ? { statusTag } : {}),
      }
    })

    // Resolve versions from git state in the background; push updates to
    // the renderer if any differ from the stored values.
    _resolveAndBroadcastVersions(list).catch(() => {})

    return result
  })

  ipcMain.handle('get-unique-name', async (_event, baseName: string) => {
    return uniqueName(baseName)
  })

  ipcMain.handle('add-installation', async (_event, data: Record<string, unknown>) => {
    data.name = await uniqueName((data.name as string) || 'ComfyUI')
    if (data.installPath) {
      const dirName = (data.name as string).replace(/[<>:"/\\|?*]+/g, '_').trim() || 'ComfyUI'
      let installPath = path.join(data.installPath as string, dirName)
      let suffix = 1
      while (fs.existsSync(installPath)) {
        installPath = path.join(data.installPath as string, `${dirName} (${suffix})`)
        suffix++
      }
      data.installPath = installPath
      const duplicate = await findDuplicatePath(data.installPath as string)
      if (duplicate) {
        return { ok: false, message: `That directory is already used by "${duplicate.name}".` }
      }
    }
    const entry = await installations.add({ ...data, seen: false })
    ensureDefaultPrimary(entry)
    return { ok: true, entry }
  })

  ipcMain.handle('reorder-installations', async (_event, orderedIds: string[]) => {
    await installations.reorder(orderedIds)
  })

  ipcMain.handle('probe-installation', async (_event, dirPath: string) => {
    const results: Record<string, unknown>[] = []
    for (const source of sources) {
      if (source.probeInstallation) {
        const data = await source.probeInstallation(dirPath)
        if (data) {
          results.push({ sourceId: source.id, sourceLabel: source.label, ...data })
        }
      }
    }
    return results
  })

  ipcMain.handle('track-installation', async (_event, data: Record<string, unknown>) => {
    const duplicate = await findDuplicatePath(data.installPath as string)
    if (duplicate) {
      return { ok: false, message: `That directory is already used by "${duplicate.name}".` }
    }
    if (!fs.existsSync(data.installPath as string)) {
      return { ok: false, message: 'That directory does not exist.' }
    }
    try {
      fs.writeFileSync(path.join(data.installPath as string, MARKER_FILE), 'tracked')
    } catch (err) {
      return { ok: false, message: `Cannot write to directory: ${(err as Error).message}` }
    }
    const entry = await installations.add({ ...data, status: 'installed', seen: false })
    ensureDefaultPrimary(entry)
    return { ok: true, entry }
  })

  ipcMain.handle('install-instance', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst) return { ok: false, message: 'Installation not found.' }
    const source = sourceMap[inst.sourceId]
    if (!source) return { ok: false, message: i18n.t('errors.unknownSource') }
    if (_operationAborts.has(installationId)) {
      return { ok: false, message: 'Another operation is already running for this installation.' }
    }
    const sender = _event.sender

    const sendProgress = (phase: string, detail: Record<string, unknown>): void => {
      if (!sender.isDestroyed()) {
        sender.send('install-progress', { installationId, phase, ...detail })
      }
    }

    if (source.install) {
      fs.mkdirSync(inst.installPath, { recursive: true })
      fs.writeFileSync(path.join(inst.installPath, MARKER_FILE), installationId)
      if (source.installSteps) {
        const steps = [...source.installSteps]
        if (inst.pendingSnapshotRestore) {
          steps.push(
            { phase: 'restore-nodes', label: i18n.t('standalone.snapshotRestoreNodesPhase') },
            { phase: 'restore-pip', label: i18n.t('standalone.snapshotRestorePipPhase') },
          )
        }
        sendProgress('steps', { steps })
      }
      const abort = new AbortController()
      _operationAborts.set(installationId, abort)
      const cache = createCache(settings.get('cacheDir') as string, settings.get('maxCachedFiles') as number)
      try {
        await source.install(inst, { sendProgress, download, cache, extract, signal: abort.signal })
        if (source.postInstall) {
          const update = (data: Record<string, unknown>): Promise<void> =>
            installations.update(installationId, data).then(() => {})
          await source.postInstall(inst, { sendProgress, update, signal: abort.signal })
        }

        // After postInstall, check for pending snapshot restore
        const freshInst = await installations.get(installationId)
        const pendingFile = freshInst?.pendingSnapshotRestore as string | undefined
        if (freshInst && pendingFile && fs.existsSync(pendingFile)) {
          const sendOutput = (text: string): void => {
            try { if (!sender.isDestroyed()) sender.send('comfy-output', { installationId, text }) } catch {}
          }
          const update = (data: Record<string, unknown>): Promise<void> =>
            installations.update(installationId, data).then(() => {})

          try {
            const fileContent = await fs.promises.readFile(pendingFile, 'utf-8')
            const envelope = validateExportEnvelope(JSON.parse(fileContent))
            await importSnapshots(freshInst.installPath, envelope)
            const targetSnapshot = envelope.snapshots[0]!

            // Restore ComfyUI version
            sendOutput('\n── Restore ComfyUI Version ──\n')
            const comfyResult = await restoreComfyUIVersion(freshInst.installPath, targetSnapshot, sendOutput)

            sendOutput('\n── Restore Nodes ──\n')
            await restoreCustomNodes(freshInst.installPath, freshInst, targetSnapshot, sendProgress, sendOutput, abort.signal, settings.get('pypiMirror'))

            if (!abort.signal.aborted && !targetSnapshot.skipPipSync) {
              sendOutput('\n── Restore Packages ──\n')
              await restorePipPackages(freshInst.installPath, freshInst, targetSnapshot,
                (phase, data) => sendProgress(phase === 'restore' ? 'restore-pip' : phase, data),
                sendOutput, abort.signal, settings.get('pypiMirror'))
            }

            // Restore update channel and version/lastRollback state so the
            // release cache sees accurate state for the restored channel.
            const restoreState = buildPostRestoreState(
              targetSnapshot, comfyResult,
              freshInst.updateInfoByChannel as Record<string, Record<string, unknown>> | undefined,
              freshInst.comfyVersion as ComfyVersion | undefined
            )
            await update(restoreState)

            // Save post-restore snapshot
            try {
              const updatedInst = { ...freshInst, ...restoreState }
              const filename = await saveSnapshot(freshInst.installPath, updatedInst, 'post-restore')
              const snapshotCount = await getSnapshotCount(freshInst.installPath)
              await update({ pendingSnapshotRestore: undefined, lastSnapshot: filename, snapshotCount })
            } catch {
              await update({ pendingSnapshotRestore: undefined })
            }
          } catch (restoreErr) {
            console.warn('Post-install snapshot restore failed:', restoreErr)
            sendOutput(`\n⚠ Snapshot restore failed: ${(restoreErr as Error).message}\nThe installation completed successfully. You can restore the snapshot manually from the Snapshots tab.\n`)
            await update({ pendingSnapshotRestore: undefined })
          } finally {
            // Clean up the staged temp file
            fs.promises.unlink(pendingFile).catch(() => {})
          }
        }

        sendProgress('done', { percent: 100, status: 'Complete' })
      } catch (err) {
        _operationAborts.delete(installationId)
        if (abort.signal.aborted) {
          let cleaned = !fs.existsSync(inst.installPath)
          if (!cleaned) {
            try {
              fs.rmSync(inst.installPath, { recursive: true, force: true })
              cleaned = true
            } catch {}
          }
          if (cleaned) {
            await installations.remove(installationId)
            return { ok: true, navigate: 'list' }
          }
          const markerPath = path.join(inst.installPath, MARKER_FILE)
          try { fs.writeFileSync(markerPath, installationId) } catch {}
          await installations.update(installationId, { status: 'partial-delete' })
          const deleteAbort = new AbortController()
          _operationAborts.set(installationId, deleteAbort)
          sendProgress('delete', { percent: 0, status: 'Counting files…' })
          try {
            await deleteDir(inst.installPath, (p) => {
              const elapsed = formatTime(p.elapsedSecs)
              const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : '—'
              sendProgress('delete', {
                percent: p.percent,
                status: `Deleting… ${p.deleted} / ${p.total} items  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
              })
            }, { signal: deleteAbort.signal })
            _operationAborts.delete(installationId)
            await installations.remove(installationId)
          } catch (_delErr) {
            _operationAborts.delete(installationId)
            if (deleteAbort.signal.aborted) {
              if (isEffectivelyEmptyInstallDir(inst.installPath)) {
                try { fs.rmSync(inst.installPath, { recursive: true, force: true }) } catch {}
                await installations.remove(installationId)
              } else {
                try { fs.writeFileSync(markerPath, installationId) } catch {}
                await installations.update(installationId, { status: 'partial-delete' })
              }
            }
          }
          return { ok: true, navigate: 'list' }
        }
        await installations.update(installationId, { status: 'failed' })
        return { ok: false, message: (err as Error).message }
      }
      _operationAborts.delete(installationId)
      await installations.update(installationId, { status: 'installed' })
      return { ok: true }
    }

    await installations.update(installationId, { status: 'failed' })
    return { ok: false, message: 'This source does not support installation.' }
  })

  // List actions
  ipcMain.handle('get-list-actions', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst) return []
    const source = sourceMap[inst.sourceId]
    if (!source) return []
    return source.getListActions ? source.getListActions(inst) : []
  })

  // Detail — validate editable fields dynamically from source schema
  ipcMain.handle('update-installation', async (_event, installationId: string, data: Record<string, unknown>) => {
    const inst = await installations.get(installationId)
    if (!inst) return { ok: false, message: 'Installation not found.' }
    const source = sourceMap[inst.sourceId]
    if (!source) return { ok: false, message: i18n.t('errors.unknownSource') }
    const sections = source.getDetailSections(inst)
    const allowedIds = new Set(['name', 'seen'])
    for (const section of sections) {
      const fields = (section as Record<string, unknown>).fields as Record<string, unknown>[] | undefined
      if (!fields) continue
      for (const f of fields) {
        if ((f as Record<string, unknown>).editable && (f as Record<string, unknown>).id) {
          allowedIds.add((f as Record<string, unknown>).id as string)
        }
      }
    }
    const filtered: Record<string, unknown> = {}
    for (const key of Object.keys(data)) {
      if (allowedIds.has(key)) filtered[key] = data[key]
    }
    if (filtered.name && filtered.name !== inst.name) {
      const all = await installations.list()
      if (all.some((i) => i.id !== installationId && i.name === filtered.name)) {
        return { ok: false, message: i18n.t('errors.duplicateName', { name: filtered.name as string }) }
      }
    }
    await installations.update(installationId, filtered)
    return { ok: true }
  })

  ipcMain.handle('get-detail-sections', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst) return []
    const source = sourceMap[inst.sourceId]
    if (!source) {
      const actions = [untrackAction()]
      if (inst.installPath && fs.existsSync(inst.installPath)) {
        actions.unshift(deleteAction(inst))
      }
      return [
        {
          title: '',
          description: i18n.t('errors.unknownSource'),
        },
        {
          pinBottom: true,
          actions,
        },
      ]
    }
    return source.getDetailSections(inst)
  })

  // Snapshots
  ipcMain.handle('get-snapshots', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) return { snapshots: [], copyEvents: [], totalCount: 0, context: { updateChannel: '', pythonVersion: '', variant: '', variantLabel: '' } }
    const data = await getSnapshotListData(inst.installPath)

    // Find installations that were copied from this one
    const allInstalls = await installations.list()
    const copyEvents = allInstalls
      .filter((i) => (i.copiedFrom as string | undefined) === installationId && (i.copiedAt as string | undefined))
      .map((i) => ({
        installationId: i.id,
        installationName: i.name,
        copiedAt: i.copiedAt as string,
        copyReason: (i.copyReason as 'copy' | 'copy-update' | 'release-update') || 'copy',
        exists: true,
      }))

    return {
      ...data,
      copyEvents,
      context: {
        updateChannel: (inst.updateChannel as string | undefined) || 'stable',
        pythonVersion: (inst.pythonVersion as string | undefined) || '',
        variant: (inst.variant as string | undefined) || '',
        variantLabel: (inst.variant as string | undefined) ? getVariantLabel(inst.variant as string) : '',
      },
    }
  })

  ipcMain.handle('get-snapshot-detail', async (_event, installationId: string, filename: string) => {
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) throw new Error('Installation not found or has no install path')
    const detail = await getSnapshotDetailData(inst.installPath, filename)
    // Fill in context from installation record if snapshot doesn't have it
    if (!detail.pythonVersion) detail.pythonVersion = (inst.pythonVersion as string | undefined) || undefined
    if (!detail.updateChannel) detail.updateChannel = (inst.updateChannel as string | undefined) || undefined
    return detail
  })

  ipcMain.handle('get-snapshot-diff', async (_event, installationId: string, filename: string, mode: 'previous' | 'current') => {
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) throw new Error('Installation not found or has no install path')
    if (mode === 'previous') {
      return getSnapshotDiffVsPrevious(inst.installPath, filename)
    }
    // mode === 'current'
    const target = await loadSnapshot(inst.installPath, filename)
    const diff = await diffAgainstCurrent(inst.installPath, inst, target)
    const empty = !diff.comfyuiChanged && !diff.updateChannelChanged && diff.nodesAdded.length === 0 && diff.nodesRemoved.length === 0 &&
                  diff.nodesChanged.length === 0 && diff.pipsAdded.length === 0 && diff.pipsRemoved.length === 0 &&
                  diff.pipsChanged.length === 0
    return { mode: 'current' as const, baseLabel: 'Current state', diff, empty }
  })

  ipcMain.handle('export-snapshot', async (_event, installationId: string, filename: string) => {
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) return { ok: false, message: 'Installation not found.' }
    const snapshot = await loadSnapshot(inst.installPath, filename)
    const envelope = buildExportEnvelope(inst.name, [{ filename, snapshot }])
    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return { ok: false, message: 'No window.' }
    const safeName = inst.name.replace(/[<>:"/\\|?*]+/g, '_')
    const dateStr = snapshot.createdAt.slice(0, 10).replace(/-/g, '')
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `snapshot-${safeName}-${snapshot.trigger}-${dateStr}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { ok: false }
    await fs.promises.writeFile(filePath, JSON.stringify(envelope, null, 2))
    return { ok: true }
  })

  ipcMain.handle('export-all-snapshots', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) return { ok: false, message: 'Installation not found.' }
    const entries = await listSnapshots(inst.installPath)
    if (entries.length === 0) return { ok: false, message: 'No snapshots to export.' }
    const envelope = buildExportEnvelope(inst.name, entries)
    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return { ok: false, message: 'No window.' }
    const safeName = inst.name.replace(/[<>:"/\\|?*]+/g, '_')
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `snapshots-${safeName}-${dateStr}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { ok: false }
    await fs.promises.writeFile(filePath, JSON.stringify(envelope, null, 2))
    return { ok: true }
  })

  ipcMain.handle('import-snapshots', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) return { ok: false, message: 'Installation not found.' }
    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return { ok: false, message: 'No window.' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (canceled || filePaths.length === 0) return { ok: false }
    const content = await fs.promises.readFile(filePaths[0]!, 'utf-8')
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch { return { ok: false, message: 'Invalid JSON file.' } }
    let envelope
    try { envelope = validateExportEnvelope(parsed) } catch (err) { return { ok: false, message: (err as Error).message } }
    const result = await importSnapshots(inst.installPath, envelope)
    const snapshotCount = await getSnapshotCount(inst.installPath)
    const allSnapshots = await listSnapshots(inst.installPath)
    const lastSnapshot = allSnapshots.length > 0 ? allSnapshots[0]!.filename : null
    await installations.update(installationId, { snapshotCount, ...(lastSnapshot ? { lastSnapshot } : {}) })
    return { ok: true, imported: result.imported, skipped: result.skipped }
  })

  /**
   * Find a reference ComfyUI git repo from existing installations that
   * can be used to resolve versions for imported snapshots.  Returns the
   * repo dir and a latestTagOverride if available.
   */
  async function _findReferenceRepo(): Promise<{ comfyuiDir: string; override?: LatestTagOverride } | null> {
    const all = await installations.list()
    for (const inst of all) {
      if (!inst.installPath) continue
      const comfyuiDir = path.join(inst.installPath, 'ComfyUI')
      if (!hasGitDir(comfyuiDir)) continue
      // Try to get the latest tag info from this repo
      const tagName = await findLatestVersionTag(comfyuiDir)
      if (tagName) {
        const sha = await revParseRef(comfyuiDir, tagName)
        if (sha) return { comfyuiDir, override: { name: tagName, sha } }
      }
      return { comfyuiDir }
    }
    return null
  }

  async function buildSnapshotPreview(filePath: string, envelope: SnapshotExportEnvelope): Promise<Record<string, unknown>> {
    // Find a reference repo to resolve versions from git state
    const ref = await _findReferenceRepo()

    const resolveVersion = async (comfyui: { ref: string; commit: string | null; baseTag?: string; commitsAhead?: number }, style: 'short' | 'detail'): Promise<string> => {
      if (!comfyui.commit || !ref) return formatSnapshotVersion(comfyui, style)
      try {
        const cv = await resolveLocalVersion(ref.comfyuiDir, comfyui.commit, undefined, ref.override)
        return formatComfyVersion(cv, style)
      } catch {
        return formatSnapshotVersion(comfyui, style)
      }
    }

    const newest = envelope.snapshots[0]!
    const resolvedVersions = await Promise.all(
      envelope.snapshots.map((s) => resolveVersion(s.comfyui, 'short'))
    )
    const snapshots = envelope.snapshots.map((s, i) => ({
      filename: `imported-${i}`,
      createdAt: s.createdAt,
      trigger: s.trigger,
      label: s.label,
      comfyuiVersion: resolvedVersions[i]!,
      nodeCount: s.customNodes.length,
      pipPackageCount: Object.keys(s.pipPackages).length,
    }))
    return {
      filePath,
      installationName: envelope.installationName,
      snapshotCount: envelope.snapshots.length,
      snapshots,
      newestSnapshot: {
        filename: 'imported-0',
        createdAt: newest.createdAt,
        trigger: newest.trigger,
        label: newest.label,
        comfyuiVersion: await resolveVersion(newest.comfyui, 'detail'),
        comfyui: newest.comfyui,
        pythonVersion: newest.pythonVersion,
        updateChannel: newest.updateChannel,
        customNodes: newest.customNodes.map((n) => ({
          id: n.id,
          type: n.type,
          dirName: n.dirName,
          enabled: n.enabled,
          version: n.version,
          commit: n.commit,
          url: n.url,
        })),
        pipPackageCount: Object.keys(newest.pipPackages).length,
        pipPackages: newest.pipPackages,
      },
    }
  }

  let _lastDesktopPreviewFile: string | null = null

  ipcMain.handle('preview-desktop-migration', async () => {
    try {
      // Clean up previous preview file if user is re-previewing
      if (_lastDesktopPreviewFile) {
        fs.promises.unlink(_lastDesktopPreviewFile).catch(() => {})
        _lastDesktopPreviewFile = null
      }

      const desktopInfo = detectDesktopInstall()
      if (!desktopInfo) return { ok: false, message: i18n.t('desktop.notFound') }

      const { envelope, stagedFile } = await stageDesktopSnapshot(desktopInfo)

      _lastDesktopPreviewFile = stagedFile
      return { ok: true, preview: await buildSnapshotPreview(stagedFile, envelope), snapshotPath: stagedFile }
    } catch (err) {
      console.warn('preview-desktop-migration failed:', err)
      return { ok: false, message: (err as Error)?.message ?? String(err) }
    }
  })

  const _lastLocalPreviewFiles = new Map<string, string>()
  ipcMain.handle('preview-local-migration', async (_event, installationId: string) => {
    try {
      const prev = _lastLocalPreviewFiles.get(installationId)
      if (prev) {
        fs.promises.unlink(prev).catch(() => {})
        _lastLocalPreviewFiles.delete(installationId)
      }

      const inst = await installations.get(installationId)
      if (!inst) return { ok: false, message: 'Installation not found.' }

      const { envelope, stagedFile } = await stageLocalSnapshot(
        inst.installPath,
        inst.sourceId as string,
        inst.name,
      )

      _lastLocalPreviewFiles.set(installationId, stagedFile)
      return { ok: true, preview: await buildSnapshotPreview(stagedFile, envelope), snapshotPath: stagedFile }
    } catch (err) {
      console.warn('preview-local-migration failed:', err)
      return { ok: false, message: (err as Error)?.message ?? String(err) }
    }
  })

  ipcMain.handle('preview-snapshot-file', async (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return { ok: false, message: 'No window.' }

    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Snapshot', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (canceled || filePaths.length === 0) return { ok: false }

    const content = await fs.promises.readFile(filePaths[0]!, 'utf-8')
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch { return { ok: false, message: 'Invalid JSON file.' } }
    let envelope: SnapshotExportEnvelope
    try { envelope = validateExportEnvelope(parsed) } catch (err) { return { ok: false, message: (err as Error).message } }

    return { ok: true, preview: await buildSnapshotPreview(filePaths[0]!, envelope) }
  })

  ipcMain.handle('preview-snapshot-path', async (_event, filePath: string) => {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, message: 'Snapshot file not found.' }

    const content = await fs.promises.readFile(filePath, 'utf-8')
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch { return { ok: false, message: 'Invalid JSON file.' } }
    let envelope: SnapshotExportEnvelope
    try { envelope = validateExportEnvelope(parsed) } catch (err) { return { ok: false, message: (err as Error).message } }

    return { ok: true, preview: await buildSnapshotPreview(filePath, envelope) }
  })

  ipcMain.handle('create-from-snapshot', async (_event, filePath: string, customName?: string, releaseTag?: string, variantId?: string) => {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, message: 'Snapshot file not found.' }

    const content = await fs.promises.readFile(filePath, 'utf-8')
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch { return { ok: false, message: 'Invalid JSON file.' } }
    let envelope: SnapshotExportEnvelope
    try { envelope = validateExportEnvelope(parsed) } catch (err) { return { ok: false, message: (err as Error).message } }

    // 3. Extract variant from newest snapshot (used as fallback for matching)
    const targetSnapshot = envelope.snapshots[0]!
    const snapshotVariant = targetSnapshot.comfyui.variant || ''

    // 4. Map to current platform variant
    const platformPrefix: Record<string, string> = { win32: 'win-', darwin: 'mac-', linux: 'linux-' }
    const prefix = platformPrefix[process.platform]
    if (!prefix) return { ok: false, message: `Unsupported platform: ${process.platform}` }
    const strippedVariant = snapshotVariant.replace(/^(win|mac|linux)-/, '')
    const baseGpu = strippedVariant.replace(/-.*$/, '') // e.g. "nvidia" from "nvidia-cu128"

    // 5. Fetch releases and find matching release
    const source = sourceMap['standalone']!
    const releaseOptions = await source.getFieldOptions('release', {}, {})
    if (releaseOptions.length === 0) return { ok: false, message: 'No releases available.' }

    let selectedRelease: FieldOption
    if (releaseTag) {
      const match = releaseOptions.find((r) => r.value === releaseTag)
      if (!match) return { ok: false, message: `Release "${releaseTag}" is no longer available.` }
      selectedRelease = match
    } else {
      console.warn('No releaseTag specified for create-from-snapshot, falling back to latest release.')
      selectedRelease = releaseOptions[0]!
    }

    const gpu = await detectGPU()
    const variantOptions = await source.getFieldOptions('variant', { release: selectedRelease }, { gpu: gpu?.id })
    if (variantOptions.length === 0) return { ok: false, message: 'No compatible variants found for this platform.' }

    let matched: FieldOption | undefined
    if (variantId) {
      matched = variantOptions.find((v) => (v.data?.variantId as string) === variantId)
      if (!matched) return { ok: false, message: `Variant "${variantId}" is not available for the selected release.` }
    } else {
      // Match: exact re-prefixed variant, then base GPU type, then recommended, then first
      const localVariant = prefix + strippedVariant
      matched = variantOptions.find((v) => (v.data?.variantId as string) === localVariant)
      if (!matched) {
        matched = variantOptions.find((v) => {
          const vid = ((v.data?.variantId as string) || '').replace(/^(win|mac|linux)-/, '')
          return vid === baseGpu || vid.startsWith(baseGpu + '-')
        })
      }
      if (!matched) matched = variantOptions.find((v) => v.recommended)
      if (!matched) matched = variantOptions[0]!
    }

    // 6. Build installation
    const instData = {
      sourceId: source.id,
      sourceLabel: source.label,
      ...source.buildInstallation({ release: selectedRelease, variant: matched }),
    }
    const baseName = customName || envelope.installationName || 'ComfyUI'
    const name = await uniqueName(baseName)
    const dirName = name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'ComfyUI'
    const installDir = defaultInstallDir()
    let installPath = path.join(installDir, dirName)
    let suffix = 1
    while (fs.existsSync(installPath)) {
      installPath = path.join(installDir, `${dirName} (${suffix})`)
      suffix++
    }

    const duplicate = await findDuplicatePath(installPath)
    if (duplicate) return { ok: false, message: `Directory already used by "${duplicate.name}".` }

    // Copy snapshot file to a temp location so it survives if the user
    // moves/deletes the original during the (potentially long) installation.
    const stagingDir = path.join(os.tmpdir(), 'comfyui-desktop-2-snapshots')
    await fs.promises.mkdir(stagingDir, { recursive: true })
    const stagedFile = path.join(stagingDir, `pending-${Date.now()}.json`)
    await fs.promises.copyFile(filePath, stagedFile)

    const entry = await installations.add({
      name,
      installPath,
      pendingSnapshotRestore: stagedFile,
      ...instData,
      seen: false,
    })
    ensureDefaultPrimary(entry)

    return { ok: true, entry: { id: entry.id, name: entry.name } }
  })

  // Settings
  ipcMain.handle('get-settings-sections', () => {
    const s = settings.getAll()
    const appSections = [
      {
        title: i18n.t('settings.general'),
        fields: [
          { id: 'language', label: i18n.t('settings.language'), type: 'select', value: s.language || i18n.getLocale(),
            options: i18n.getAvailableLocales() },
          { id: 'theme', label: i18n.t('settings.theme'), type: 'select', value: s.theme || 'system',
            options: [
              { value: 'system', label: i18n.t('settings.themeSystem') },
              { value: 'dark', label: i18n.t('settings.themeDark') },
              { value: 'light', label: i18n.t('settings.themeLight') },
              { value: 'solarized', label: i18n.t('settings.themeSolarized') },
              { value: 'nord', label: i18n.t('settings.themeNord') },
              { value: 'arc', label: i18n.t('settings.themeArc') },
              { value: 'github', label: i18n.t('settings.themeGithub') },
            ] },
          { id: 'autoUpdate', label: i18n.t('settings.autoUpdate'), type: 'boolean', value: s.autoUpdate !== false },
          { id: 'onAppClose', label: i18n.t('settings.onAppClose'), type: 'select', value: s.onAppClose || settings.defaults.onAppClose,
            options: [
              { value: 'quit', label: i18n.t('settings.closeQuit') },
              { value: 'tray', label: i18n.t('settings.closeTray') },
            ] },
        ],
        actions: [
          { label: i18n.t('settings.checkForUpdates'), action: 'check-for-update' },
        ],
      },
      {
        title: i18n.t('settings.telemetry'),
        fields: [
          { id: 'telemetryEnabled', label: i18n.t('settings.telemetryEnabled'), type: 'boolean', value: s.telemetryEnabled !== false },
        ],
      },
      {
        title: i18n.t('settings.downloads'),
        fields: [
          { id: 'cacheDir', label: i18n.t('settings.cacheDir'), type: 'path', value: s.cacheDir, openable: true },
          { id: 'maxCachedFiles', label: i18n.t('settings.maxCachedFiles'), type: 'number', value: s.maxCachedFiles, min: 1, max: 50 },
        ],
      },
      {
        title: i18n.t('settings.advanced'),
        fields: [
          { id: 'pypiMirror', label: i18n.t('settings.pypiMirror'), type: 'text', value: s.pypiMirror || '',
            placeholder: i18n.t('settings.pypiMirrorPlaceholder') },
        ],
      },
    ]
    const sourceSections = sources.flatMap((src) => {
      const plugin = src as unknown as Record<string, unknown>
      if (typeof plugin.getSettingsSections === 'function') {
        return (plugin.getSettingsSections as (s: Record<string, unknown>) => Record<string, unknown>[])(s as Record<string, unknown>)
      }
      return []
    })
    const version = getAppVersion()
    const aboutSection = {
      title: i18n.t('settings.about'),
      fields: [
        { label: i18n.t('settings.version'), value: version, readonly: true },
        { label: i18n.t('settings.platform'), value: `${process.platform} (${process.arch})`, readonly: true },
      ],
      actions: [
        { id: 'github', label: 'GitHub', url: 'https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta' },
      ],
    }
    return [...appSections, ...sourceSections, aboutSection]
  })

  ipcMain.handle('get-models-sections', () => {
    const s = settings.getAll()
    return {
      systemDefault: settings.defaults.modelsDirs[0],
      sections: [
        {
          title: i18n.t('models.directories'),
          fields: [
            { id: 'modelsDirs', label: i18n.t('models.directoriesDesc'), type: 'pathList', value: s.modelsDirs || [] },
          ],
        },
      ],

    }
  })

  ipcMain.handle('get-media-sections', () => {
    const s = settings.getAll()
    return [
      {
        title: i18n.t('media.sharedDirs'),
        fields: [
          { id: 'inputDir', label: i18n.t('media.inputDir'), type: 'path' as const, value: s.inputDir || settings.defaults.inputDir, openable: true },
          { id: 'outputDir', label: i18n.t('media.outputDir'), type: 'path' as const, value: s.outputDir || settings.defaults.outputDir, openable: true },
        ],
      },
    ]
  })

  ipcMain.handle('set-setting', (_event, key: string, value: unknown) => {
    settings.set(key, value)
    if (key === 'theme') {
      const resolved = resolveTheme()
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send('theme-changed', resolved)
      })
    }
    if (key === 'language') {
      i18n.init(value as string)
      const msgs = i18n.getMessages()
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send('locale-changed', msgs)
      })
      if (_onLocaleChanged) _onLocaleChanged()
    }
    if (key === 'telemetryEnabled') {
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send('telemetry-setting-changed', value)
      })
    }
  })

  ipcMain.handle('get-setting', (_event, key: string) => {
    return settings.get(key)
  })

  ipcMain.handle('get-locale-messages', () => i18n.getMessages())
  ipcMain.handle('get-available-locales', () => i18n.getAvailableLocales())

  ipcMain.handle('get-resolved-theme', () => resolveTheme())

  nativeTheme.on('updated', () => {
    if (((settings.get('theme') as string | undefined) || 'system') !== 'system') return
    const resolved = resolveTheme()
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send('theme-changed', resolved)
    })
  })

  ipcMain.handle('stop-comfyui', async (_event, installationId?: string) => {
    if (installationId) {
      await stopRunning(installationId)
    } else {
      await stopRunning()
    }
    if (_onStop) _onStop({ installationId })
  })

  ipcMain.handle('get-running-instances', () => _getPublicSessions())

  ipcMain.handle('cancel-launch', () => {
    for (const [_id, abort] of _operationAborts) {
      abort.abort()
    }
    _operationAborts.clear()
  })

  ipcMain.handle('cancel-operation', (_event, installationId: string) => {
    const abort = _operationAborts.get(installationId)
    if (abort) {
      abort.abort()
      _operationAborts.delete(installationId)
    }
  })

  ipcMain.handle('kill-port-process', async (_event, port: number) => {
    removePortLock(port)
    await killByPort(port)
    await new Promise((r) => setTimeout(r, 500))
    const remaining = await findPidsByPort(port)
    return { ok: remaining.length === 0 }
  })

  ipcMain.handle('run-action', async (_event, installationId: string, actionId: string, actionData?: Record<string, unknown>) => {
    const maybeInst = await installations.get(installationId)
    if (!maybeInst) return { ok: false, message: 'Installation not found.' }
    const inst = maybeInst
    if (REQUIRES_STOPPED.has(actionId) && _runningSessions.has(installationId)) {
      return { ok: false, message: i18n.t('errors.stopRequired'), running: true }
    }
    if (REQUIRES_STOPPED.has(actionId) && _operationAborts.has(installationId)) {
      return { ok: false, message: i18n.t('errors.operationInProgress') }
    }
    if (actionId === 'remove') {
      await installations.remove(installationId)
      await autoAssignPrimary(installationId)
      const pinned = (settings.get('pinnedInstallIds') as string[] | undefined) ?? []
      if (pinned.includes(installationId)) {
        settings.set('pinnedInstallIds', pinned.filter((id) => id !== installationId))
      }
      return { ok: true, navigate: 'list' }
    }
    if (actionId === 'set-primary-install') {
      if (inst.sourceId === 'desktop') {
        return { ok: false, message: 'Desktop installations cannot be set as primary.' }
      }
      settings.set('primaryInstallId', installationId)
      return { ok: true }
    }
    if (actionId === 'pin-install') {
      const pinned = (settings.get('pinnedInstallIds') as string[] | undefined) ?? []
      if (!pinned.includes(installationId)) {
        settings.set('pinnedInstallIds', [...pinned, installationId])
      }
      return { ok: true }
    }
    if (actionId === 'unpin-install') {
      const pinned = (settings.get('pinnedInstallIds') as string[] | undefined) ?? []
      settings.set('pinnedInstallIds', pinned.filter((id) => id !== installationId))
      return { ok: true }
    }
    if (actionId === 'delete') {
      if (!fs.existsSync(inst.installPath)) {
        await installations.remove(installationId)
        await autoAssignPrimary(installationId)
        return { ok: true, navigate: 'list' }
      }
      if (_operationAborts.has(installationId)) {
        return { ok: false, message: 'Another operation is already running for this installation.' }
      }
      const markerPath = path.join(inst.installPath, MARKER_FILE)
      let markerContent: string | null
      try { markerContent = fs.readFileSync(markerPath, 'utf-8').trim() } catch { markerContent = null }
      if (!markerContent) {
        return { ok: false, message: 'Safety check failed: this directory was not created by ComfyUI Desktop 2.0. Use Untrack to remove it from the list, then delete the files manually.' }
      }
      if (markerContent !== inst.id && markerContent !== 'tracked') {
        return { ok: false, message: 'Safety check failed: the marker file does not match this installation. Use Untrack instead.' }
      }
      const sender = _event.sender
      const sendProgress = (phase: string, detail: Record<string, unknown>): void => {
        if (!sender.isDestroyed()) {
          sender.send('install-progress', { installationId, phase, ...detail })
        }
      }
      const abort = new AbortController()
      _operationAborts.set(installationId, abort)
      sendProgress('delete', { percent: 0, status: 'Counting files…' })
      try {
        await deleteDir(inst.installPath, (p) => {
          const elapsed = formatTime(p.elapsedSecs)
          const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : '—'
          sendProgress('delete', {
            percent: p.percent,
            status: `Deleting… ${p.deleted} / ${p.total} items  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
          })
        }, { signal: abort.signal })
      } catch (err) {
        _operationAborts.delete(installationId)
        // Always restore marker so future delete attempts don't hit the safety check
        try {
          fs.mkdirSync(inst.installPath, { recursive: true })
          fs.writeFileSync(markerPath, markerContent)
        } catch {}
        await installations.update(installationId, { status: 'partial-delete' })
        const raw = (err as NodeJS.ErrnoException)
        let message = raw.message
        if (raw.code === 'EBUSY' || raw.code === 'EPERM') {
          message = i18n.t('errors.deleteLocked', { path: raw.path ?? '' })
          // Fire-and-forget: resolve which process holds the lock, then push an updated message
          const lockedPath = raw.path
          if (lockedPath) {
            findLockingProcesses(lockedPath).then((procs) => {
              if (procs.length > 0 && !sender.isDestroyed()) {
                const names = [...new Set(procs.map((p) => p.name))].join(', ')
                const detail = i18n.t('errors.deleteLockedBy', { processes: names, path: lockedPath })
                sender.send('error-detail', { installationId, message: detail })
              }
            }).catch((err) => { console.error('Failed to identify locking processes:', err) })
          }
        }
        return { ok: false, message }
      }
      _operationAborts.delete(installationId)
      await installations.remove(installationId)
      await autoAssignPrimary(installationId)
      return { ok: true, navigate: 'list' }
    }
    if (actionId === 'open-folder') {
      if (inst.installPath) {
        if (fs.existsSync(inst.installPath)) {
          const err = await openPath(inst.installPath)
          if (err) return { ok: false, message: i18n.t('errors.cannotOpenDir', { error: err }) }
        } else {
          return { ok: false, message: i18n.t('errors.dirNotExist', { path: inst.installPath }) }
        }
      }
      return { ok: true }
    }
    if (actionId === 'copy') {
      const name = actionData?.name as string | undefined
      if (!name) return { ok: false, message: 'No name provided.' }
      if (!inst.installPath || !fs.existsSync(inst.installPath)) {
        return { ok: false, message: i18n.t('errors.dirNotExist', { path: inst.installPath || '' }) }
      }
      if (_operationAborts.has(installationId)) {
        return { ok: false, message: 'Another operation is already running for this installation.' }
      }

      const sender = _event.sender
      const sendProgress = (phase: string, detail: Record<string, unknown>): void => {
        if (!sender.isDestroyed()) {
          sender.send('install-progress', { installationId, phase, ...detail })
        }
      }

      const abort = new AbortController()
      _operationAborts.set(installationId, abort)

      try {
        await performCopy(inst, name, sendProgress, abort.signal)
        _operationAborts.delete(installationId)
        sendProgress('done', { percent: 100, status: 'Complete' })
        return { ok: true, navigate: 'list' }
      } catch (err) {
        _operationAborts.delete(installationId)
        if (abort.signal.aborted) return { ok: true, navigate: 'detail' }
        return { ok: false, message: (err as Error).message }
      }
    }
    if (actionId === 'copy-update') {
      const name = actionData?.name as string | undefined
      if (!name) return { ok: false, message: 'No name provided.' }
      if (!inst.installPath || !fs.existsSync(inst.installPath)) {
        return { ok: false, message: i18n.t('errors.dirNotExist', { path: inst.installPath || '' }) }
      }
      if (_operationAborts.has(installationId)) {
        return { ok: false, message: 'Another operation is already running for this installation.' }
      }

      const sender = _event.sender
      const sendProgress = (phase: string, detail: Record<string, unknown>): void => {
        if (!sender.isDestroyed()) {
          sender.send('install-progress', { installationId, phase, ...detail })
        }
      }
      const sendOutput = (text: string): void => {
        if (!sender.isDestroyed()) {
          sender.send('comfy-output', { installationId, text })
        }
      }

      const abort = new AbortController()
      _operationAborts.set(installationId, abort)

      try {
        sendProgress('steps', { steps: [
          { phase: 'copy', label: i18n.t('actions.copyingFiles') },
          { phase: 'prepare', label: i18n.t('standalone.updatePrepare') },
          { phase: 'run', label: i18n.t('standalone.updateRun') },
          { phase: 'deps', label: i18n.t('standalone.updateDeps') },
        ] })

        const { entry } = await performCopy(inst, name, sendProgress, abort.signal, 'copy-update')

        // If a target channel was specified, persist it on the copy before updating
        const targetChannel = actionData?.channel as string | undefined
        if (targetChannel) {
          await installations.update(entry.id, { updateChannel: targetChannel })
        }

        const updateSendProgress = (phase: string, detail: Record<string, unknown>): void => {
          if (phase !== 'steps') sendProgress(phase, detail)
        }
        try {
          const source = sourceMap[inst.sourceId]
          if (!source) throw new Error(i18n.t('errors.unknownSource'))
          const newInst = await installations.get(entry.id)
          const newUpdate = (data: Record<string, unknown>): Promise<void> =>
            installations.update(entry.id, data).then(() => {})
          const updateResult = await source.handleAction('update-comfyui', newInst!, {}, {
            update: newUpdate,
            sendProgress: updateSendProgress,
            sendOutput,
            signal: abort.signal,
          })
          if (updateResult && !updateResult.ok) {
            sendOutput(`\n⚠ Update: ${updateResult.message}\n`)
            sendOutput('The copy was created successfully. You can retry the update from the new installation.\n')
          }
        } catch (updateErr) {
          sendOutput(`\n⚠ Update failed: ${(updateErr as Error).message}\n`)
          sendOutput('The copy was created successfully. You can retry the update from the new installation.\n')
        }

        _operationAborts.delete(installationId)
        return { ok: true, navigate: 'list' }
      } catch (err) {
        _operationAborts.delete(installationId)
        if (abort.signal.aborted) return { ok: true, navigate: 'detail' }
        return { ok: false, message: (err as Error).message }
      }
    }
    if (actionId === 'migrate-to-standalone') {
      if (_operationAborts.has(installationId)) {
        return { ok: false, message: 'Another operation is already running for this installation.' }
      }

      const sender = _event.sender
      const sendProgress = (phase: string, detail: Record<string, unknown>): void => {
        if (!sender.isDestroyed()) {
          sender.send('install-progress', { installationId, phase, ...detail })
        }
      }
      const sendOutput = (text: string): void => {
        if (!sender.isDestroyed()) {
          sender.send('comfy-output', { installationId, text })
        }
      }

      const abort = new AbortController()
      _operationAborts.set(installationId, abort)

      let entry: InstallationRecord | null = null
      let destPath = ''
      try {
        const migrationTools = {
          sendProgress,
          sendOutput,
          signal: abort.signal,
          sourceMap,
          uniqueName,
          ensureDefaultPrimary,
        }
        const result = inst.sourceId === 'desktop'
          ? await performDesktopMigration(actionData, migrationTools)
          : await performLocalMigration(inst, actionData, migrationTools)
        entry = result.entry
        destPath = result.destPath

        _operationAborts.delete(installationId)
        sendProgress('done', { percent: 100, status: 'Complete' })
        return { ok: true, navigate: 'list' }
      } catch (err) {
        _operationAborts.delete(installationId)
        if (entry) {
          try { await installations.remove(entry.id) } catch {}
        }
        if (destPath && fs.existsSync(destPath)) {
          try { await fs.promises.rm(destPath, { recursive: true, force: true }) } catch {}
        }
        if (abort.signal.aborted) return { ok: true, navigate: 'detail' }
        return { ok: false, message: (err as Error).message }
      }
    }
    if (actionId === 'release-update') {
      const name = actionData?.name as string | undefined
      const releaseSelection = actionData?.releaseSelection as Record<string, unknown> | undefined
      const variantSelection = actionData?.variantSelection as Record<string, unknown> | undefined
      if (!name || !releaseSelection || !variantSelection) {
        return { ok: false, message: 'Missing required selections.' }
      }
      if (!inst.installPath || !fs.existsSync(inst.installPath)) {
        return { ok: false, message: i18n.t('errors.dirNotExist', { path: inst.installPath || '' }) }
      }
      if (_operationAborts.has(installationId)) {
        return { ok: false, message: 'Another operation is already running for this installation.' }
      }

      const source = sourceMap[inst.sourceId]
      if (!source) return { ok: false, message: i18n.t('errors.unknownSource') }
      const installData = source.buildInstallation({
        release: releaseSelection as unknown as FieldOption,
        variant: variantSelection as unknown as FieldOption,
      })

      const parentDir = path.dirname(inst.installPath)
      const dirName = name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'ComfyUI'
      let destPath = path.join(parentDir, dirName)
      let suffix = 1
      while (fs.existsSync(destPath)) {
        destPath = path.join(parentDir, `${dirName} (${suffix})`)
        suffix++
      }

      const duplicate = await findDuplicatePath(destPath)
      if (duplicate) {
        return { ok: false, message: `That directory is already used by "${duplicate.name}".` }
      }

      const sender = _event.sender
      const sendProgress = (phase: string, detail: Record<string, unknown>): void => {
        if (!sender.isDestroyed()) {
          sender.send('install-progress', { installationId, phase, ...detail })
        }
      }
      const sendOutput = (text: string): void => {
        if (!sender.isDestroyed()) {
          sender.send('comfy-output', { installationId, text })
        }
      }

      const abort = new AbortController()
      _operationAborts.set(installationId, abort)

      sendProgress('steps', { steps: [
        { phase: 'download', label: i18n.t('common.download') },
        { phase: 'extract', label: i18n.t('common.extract') },
        { phase: 'setup', label: i18n.t('standalone.setupEnv') },
        { phase: 'migrate', label: i18n.t('migrate.filePhase') },
        { phase: 'deps', label: i18n.t('migrate.depsPhase') },
      ] })

      let entry: InstallationRecord | null = null
      let installComplete = false
      try {
        fs.mkdirSync(destPath, { recursive: true })
        const installRecord = { ...installData, installPath: destPath } as InstallationRecord
        const cache = createCache(settings.get('cacheDir') as string, settings.get('maxCachedFiles') as number)
        await source.install!(installRecord, { sendProgress, download, cache, extract, signal: abort.signal })

        const finalName = await uniqueName(name)
        entry = await installations.add({
          sourceId: inst.sourceId,
          sourceLabel: source.label,
          ...installData,
          name: finalName,
          installPath: destPath,
          status: 'installed',
          seen: false,
          browserPartition: 'unique',
          copiedFrom: inst.id,
          copiedFromName: inst.name,
          copiedAt: new Date().toISOString(),
          copyReason: 'release-update' as const,
        })
        try { fs.writeFileSync(path.join(destPath, MARKER_FILE), entry.id) } catch {}
        await copyBrowserPartition(inst.id, entry.id, inst.browserPartition as string | undefined)

        const newUpdate = (data: Record<string, unknown>): Promise<void> =>
          installations.update(entry!.id, data).then(() => {})
        await source.postInstall!(installRecord, { sendProgress, update: newUpdate, signal: abort.signal })
        installComplete = true

        const newInst = await installations.get(entry.id)
        const migrateSendProgress = (phase: string, detail: Record<string, unknown>): void => {
          if (phase !== 'steps' && phase !== 'done') sendProgress(phase, detail)
        }
        const migrateData = {
          sourceInstallationId: inst.id,
          customNodes: true,
          allUserData: true,
          models: true,
          input: true,
          output: true,
        }
        let migrateError: string | null = null
        try {
          const migrateResult = await source.handleAction('migrate-from', newInst!, migrateData, {
            update: newUpdate,
            sendProgress: migrateSendProgress,
            sendOutput,
            signal: abort.signal,
          })
          if (migrateResult && !migrateResult.ok) {
            migrateError = migrateResult.message || 'Unknown migration error'
          }
        } catch (migrateErr) {
          migrateError = (migrateErr as Error).message
        }

        _operationAborts.delete(installationId)
        if (migrateError) {
          sendOutput(`\n⚠ ${migrateError}\n`)
          sendProgress('migrate', { percent: -1, status: i18n.t('standalone.releaseUpdateCleaningUp') })
          try { await installations.remove(entry.id) } catch {}
          try {
            await deleteDir(destPath, (p) => {
              const elapsed = formatTime(p.elapsedSecs)
              const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : '—'
              sendProgress('migrate', {
                percent: p.percent,
                status: `${i18n.t('standalone.releaseUpdateCleaningUp')}  ${p.deleted} / ${p.total}  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
              })
            })
          } catch {}
          return { ok: false, message: migrateError }
        }
        sendProgress('done', { percent: 100, status: 'Complete' })
        return { ok: true, navigate: 'list' }
      } catch (err) {
        _operationAborts.delete(installationId)
        if (!installComplete) {
          if (entry) try { await installations.remove(entry.id) } catch {}
          try { await fs.promises.rm(destPath, { recursive: true, force: true }) } catch {}
        }
        if (abort.signal.aborted) return { ok: true, navigate: installComplete ? 'list' : 'detail' }
        return { ok: false, message: (err as Error).message }
      }
    }
    if (actionId === 'launch') {
      if (_runningSessions.has(installationId)) {
        return { ok: false, message: i18n.t('errors.alreadyRunning') }
      }
      if (_operationAborts.has(installationId)) {
        return { ok: false, message: 'Another operation is already running for this installation.' }
      }
      const source = sourceMap[inst.sourceId]
      if (!source) return { ok: false, message: i18n.t('errors.unknownSource') }
      if (!source.skipInstall && isEffectivelyEmptyInstallDir(inst.installPath)) {
        return { ok: false, message: i18n.t('errors.installDirEmpty') }
      }
      const launchCmdRaw = source.getLaunchCommand(inst)
      if (!launchCmdRaw) {
        return { ok: false, message: i18n.t('errors.noEnvFound') }
      }
      const launchCmd = launchCmdRaw
      // Inject shared paths if this installation uses them
      if (!launchCmd.skipSharedPaths && (inst.useSharedPaths as boolean | undefined) !== false && launchCmd.args) {
        const modelsDirs = settings.get('modelsDirs') as string[] | undefined
        const modelPathsConfig = ensureModelPathsConfig(modelsDirs)
        if (modelPathsConfig) {
          launchCmd.args.push('--extra-model-paths-config', modelPathsConfig)
        }
        const inputDir = (settings.get('inputDir') as string | undefined) || settings.defaults.inputDir
        const outputDir = (settings.get('outputDir') as string | undefined) || settings.defaults.outputDir
        fs.mkdirSync(inputDir, { recursive: true })
        fs.mkdirSync(outputDir, { recursive: true })
        launchCmd.args.push('--input-directory', inputDir)
        launchCmd.args.push('--output-directory', outputDir)
      }

      const sender = _event.sender
      const sendProgress = (phase: string, detail: Record<string, unknown>): void => {
        if (!sender.isDestroyed()) {
          sender.send('install-progress', { installationId, phase, ...detail })
        }
      }

      const abort = new AbortController()
      _operationAborts.set(installationId, abort)

      // Remote connection
      if (launchCmd.remote) {
        sendProgress('launch', { percent: -1, status: i18n.t('launch.connecting', { url: launchCmd.url || '' }) })
        try {
          await waitForUrl(launchCmd.url!, {
            timeoutMs: 15000,
            signal: abort.signal,
            onPoll: ({ elapsedMs }) => {
              const secs = Math.round(elapsedMs / 1000)
              sendProgress('launch', { percent: -1, status: i18n.t('launch.connectingTime', { url: launchCmd.url || '', secs }) })
            },
          })
        } catch (_err) {
          _operationAborts.delete(installationId)
          if (abort.signal.aborted) return { ok: false, cancelled: true }
          return { ok: false, message: i18n.t('errors.cannotConnect', { url: launchCmd.url || '' }) }
        }

        _operationAborts.delete(installationId)
        const mode = (inst.launchMode as string | undefined) || 'window'
        _addSession(installationId, { proc: null, port: launchCmd.port!, url: launchCmd.url, mode, installationName: inst.name })
        if (_onLaunch) {
          _onLaunch({ port: launchCmd.port!, url: launchCmd.url, process: null, installation: inst, mode })
        }
        return { ok: true, mode, port: launchCmd.port, url: launchCmd.url }
      }

      // Local process launch
      if (!fs.existsSync(launchCmd.cmd!)) {
        _operationAborts.delete(installationId)
        return { ok: false, message: `Executable not found: ${launchCmd.cmd}` }
      }

      // Skip port logic entirely — spawn and immediately register session
      if (launchCmd.skipPortWait) {
        _broadcastToRenderer('instance-launching', { installationId, installationName: inst.name })
        const sendOutput = (text: string): void => {
          if (!sender.isDestroyed()) sender.send('comfy-output', { installationId, text })
        }
        const launchEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' }
        const proc = spawnProcess(launchCmd.cmd!, launchCmd.args!, launchCmd.cwd!, launchEnv, { showWindow: launchCmd.showWindow })
        let stderrBuf = ''
        proc.stdout?.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
        proc.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8')
          stderrBuf += text
          if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096)
          sendOutput(text)
        })

        _operationAborts.delete(installationId)
        const mode = (inst.launchMode as string | undefined) || 'window'
        _addSession(installationId, { proc, port: 0, mode, installationName: inst.name })

        proc.on('exit', (code) => {
          // A clean exit (code 0) is normal for externally-managed processes
          // (e.g. the user closed the Desktop app directly).
          const crashed = _runningSessions.has(installationId) && code !== 0
          _removeSession(installationId)
          if (!sender.isDestroyed()) {
            sender.send('comfy-exited', { installationId, crashed, exitCode: code, installationName: inst.name })
          }
          if (_onComfyExited) _onComfyExited({ installationId })
        })

        if (_onLaunch) {
          _onLaunch({ port: 0, process: proc, installation: inst, mode })
        }
        return { ok: true, mode }
      }

      if (actionData && actionData.portOverride) {
        setPortArg(launchCmd as LaunchCmd, actionData.portOverride as number)
      }

      // Check for port conflicts: in-memory pending reservations, OS-level listeners, and disk locks
      const pendingPortOwner = _pendingPorts.get(launchCmd.port!)
      const existingPids = pendingPortOwner ? [] : await findPidsByPort(launchCmd.port!)
      const portOccupied = !!pendingPortOwner || existingPids.length > 0

      if (portOccupied) {
        const defaults = source.getDefaults ? source.getDefaults() : {}
        const portConflictMode = (inst.portConflict as string | undefined) || (defaults.portConflict as string | undefined) || 'auto'
        const userArgs = ((inst.launchArgs as string | undefined) || '').trim()
        const portIsExplicit = /(?:^|\s)--port\b/.test(userArgs)

        const reservedPorts = new Set(_pendingPorts.keys())
        let nextPort: number | null = null
        try {
          nextPort = await findAvailablePort('127.0.0.1', launchCmd.port! + 1, launchCmd.port! + 1000, reservedPorts)
        } catch {}

        if (portConflictMode === 'auto' && nextPort && !portIsExplicit) {
          sendProgress('launch', { percent: -1, status: i18n.t('launch.portBusyUsing', { old: launchCmd.port!, new: nextPort }) })
          setPortArg(launchCmd as LaunchCmd, nextPort)
        } else {
          let message: string
          let isComfy: boolean
          if (pendingPortOwner) {
            message = i18n.t('errors.portConflictLauncher', { port: launchCmd.port!, name: pendingPortOwner })
            isComfy = true
          } else {
            const lock = readPortLock(launchCmd.port!)
            if (lock) {
              message = i18n.t('errors.portConflictLauncher', { port: launchCmd.port!, name: lock.installationName })
              isComfy = true
            } else {
              const info = await getProcessInfo(existingPids[0]!)
              isComfy = looksLikeComfyUI(info)
              const processDesc = info ? info.name : `PID ${existingPids[0]}`
              message = isComfy
                ? i18n.t('errors.portConflictComfy', { port: launchCmd.port!, process: processDesc })
                : i18n.t('errors.portConflictOther', { port: launchCmd.port!, process: processDesc })
            }
          }
          _operationAborts.delete(installationId)
          return { ok: false, message, portConflict: { port: launchCmd.port, pids: existingPids, isComfy, nextPort } }
        }
      }

      // Synchronous re-check: another launch may have reserved this port while we
      // were awaiting findPidsByPort / findAvailablePort above (TOCTOU gap).
      const lateConflictOwner = _pendingPorts.get(launchCmd.port!)
      if (lateConflictOwner) {
        const defaults = source.getDefaults ? source.getDefaults() : {}
        const portConflictMode = (inst.portConflict as string | undefined) || (defaults.portConflict as string | undefined) || 'auto'
        const userArgs = ((inst.launchArgs as string | undefined) || '').trim()
        const portIsExplicit = /(?:^|\s)--port\b/.test(userArgs)

        const reservedPorts = new Set(_pendingPorts.keys())
        let nextPort: number | null = null
        try {
          nextPort = await findAvailablePort('127.0.0.1', launchCmd.port! + 1, launchCmd.port! + 1000, reservedPorts)
        } catch {}

        if (portConflictMode === 'auto' && nextPort && !portIsExplicit) {
          sendProgress('launch', { percent: -1, status: i18n.t('launch.portBusyUsing', { old: launchCmd.port!, new: nextPort }) })
          setPortArg(launchCmd as LaunchCmd, nextPort)
        } else {
          _operationAborts.delete(installationId)
          return {
            ok: false,
            message: i18n.t('errors.portConflictLauncher', { port: launchCmd.port!, name: lateConflictOwner }),
            portConflict: { port: launchCmd.port, pids: [], isComfy: true, nextPort },
          }
        }
      }

      // Reserve port eagerly before spawning to prevent concurrent launches from claiming it
      _reservePort(launchCmd.port!, inst.name)
      _broadcastToRenderer('instance-launching', { installationId, installationName: inst.name })

      const sessionPath = createSessionPath()
      const launchEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', __COMFY_CLI_SESSION__: sessionPath }
      const sendOutput = (text: string): void => {
        if (!sender.isDestroyed()) {
          sender.send('comfy-output', { installationId, text })
        }
      }

      function spawnComfy(): { proc: ChildProcess; getStderr: () => string } {
        const p = spawnProcess(launchCmd.cmd!, launchCmd.args!, launchCmd.cwd!, launchEnv, { showWindow: launchCmd.showWindow })
        let stderrBuf = ''
        p.stdout!.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
        p.stderr!.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8')
          stderrBuf += text
          if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096)
          sendOutput(text)
        })
        return { proc: p, getStderr: () => stderrBuf }
      }

      const SENSITIVE_ARG_RE = /^--(api[-_]?key|token|secret|password|auth)$/i
      const PORT_RETRY_MAX = 3
      const REBOOT_RETRY_MAX = 5
      let portRetries = 0
      let rebootRetries = 0

      const tryLaunch = async (): Promise<{ ok: true; proc: ChildProcess; getStderr: () => string } | { ok: false; message: string; cancelled?: boolean }> => {
        const cmdLine = [launchCmd.cmd!, ...launchCmd.args!].map((a, ci, ca) => {
          if (ci > 0 && SENSITIVE_ARG_RE.test(ca[ci - 1]!)) return '"***"'
          return /\s/.test(a) ? `"${a}"` : a
        }).join(' ')
        sendProgress('launch', { percent: -1, status: i18n.t('launch.starting') })
        if (!sender.isDestroyed()) {
          sender.send('comfy-output', { installationId, text: `> ${cmdLine}\n\n` })
        }
        const spawned = spawnComfy()

        let earlyExit: string | null = null
        const earlyExitPromise = new Promise<void>((_resolve, reject) => {
          spawned.proc.on('error', (err: Error) => {
            const code = (err as NodeJS.ErrnoException).code ? ` (${(err as NodeJS.ErrnoException).code})` : ''
            earlyExit = err.message
            reject(new Error(`Failed to start${code}: ${launchCmd.cmd}`))
          })
          spawned.proc.on('exit', (code) => {
            if (!earlyExit) {
              const detail = spawned.getStderr().trim() ? `\n\n${spawned.getStderr().trim()}` : ''
              earlyExit = `Process exited with code ${code}${detail}`
              reject(new Error(earlyExit))
            }
          })
        })

        sendProgress('launch', { percent: -1, status: i18n.t('launch.waiting') })
        try {
          await Promise.race([
            waitForPort(launchCmd.port!, '127.0.0.1', {
              timeoutMs: 120000,
              signal: abort.signal,
              onPoll: ({ elapsedMs }) => {
                const secs = Math.round(elapsedMs / 1000)
                sendProgress('launch', { percent: -1, status: i18n.t('launch.waitingTime', { secs }) })
              },
            }),
            earlyExitPromise,
          ])
          return { ok: true, proc: spawned.proc, getStderr: spawned.getStderr }
        } catch (err) {
          killProcessTree(spawned.proc)
          // Manager's prestartup_script may finish a queued install and request
          // a reboot before ComfyUI's port opens. Detect the marker and respawn.
          if (checkRebootMarker(sessionPath) && rebootRetries < REBOOT_RETRY_MAX) {
            rebootRetries++
            sendOutput('\n--- Manager requested restart during startup, respawning… ---\n\n')
            return tryLaunch()
          }
          const stderr = spawned.getStderr().toLowerCase()
          const isPortConflict = stderr.includes('address already in use') || (stderr.includes('port') && stderr.includes('in use'))
          if (isPortConflict && portRetries < PORT_RETRY_MAX) {
            portRetries++
            try {
              const reservedPorts = new Set(_pendingPorts.keys())
              const retryPort = await findAvailablePort('127.0.0.1', launchCmd.port! + 1, launchCmd.port! + 1000, reservedPorts)
              sendOutput(`\nPort ${launchCmd.port} in use, retrying on port ${retryPort}…\n`)
              _releasePort(launchCmd.port!)
              setPortArg(launchCmd as LaunchCmd, retryPort)
              _reservePort(launchCmd.port!, inst.name)
              return tryLaunch()
            } catch {}
          }
          if (abort.signal.aborted) return { ok: false, message: (err as Error).message, cancelled: true }
          return { ok: false, message: (err as Error).message }
        }
      }

      const launchResult = await tryLaunch()
      if (!launchResult.ok) {
        _releasePort(launchCmd.port!)
        _operationAborts.delete(installationId)
        _broadcastToRenderer('instance-launch-failed', { installationId })
        if (launchResult.cancelled) return { ok: false, cancelled: true }
        return { ok: false, message: launchResult.message }
      }
      let { proc } = launchResult

      // Transition from pending reservation to confirmed session + port lock
      _pendingPorts.delete(launchCmd.port!)
      _operationAborts.delete(installationId)
      const mode = (inst.launchMode as string | undefined) || 'window'
      _addSession(installationId, { proc, port: launchCmd.port!, mode, installationName: inst.name })
      writePortLock(launchCmd.port!, { pid: proc.pid!, installationName: inst.name })

      // Capture snapshot in background after successful launch
      if (inst.sourceId === 'standalone') {
        captureSnapshotIfChanged(inst.installPath, inst, 'boot')
          .then(async ({ saved, filename }) => {
            if (saved) {
              const snapshotCount = await getSnapshotCount(inst.installPath)
              installations.update(installationId, { lastSnapshot: filename, snapshotCount })
            }
          })
          .catch((err) => console.warn('Snapshot capture failed:', err))
      }

      function attachExitHandler(p: ChildProcess): void {
        p.on('exit', (code) => {
          if (checkRebootMarker(sessionPath)) {
            sendOutput('\n--- ComfyUI restarting ---\n\n')
            const spawned = spawnComfy()
            proc = spawned.proc
            const session = _runningSessions.get(installationId)
            if (session) session.proc = proc
            writePortLock(launchCmd.port!, { pid: proc.pid!, installationName: inst.name })
            attachExitHandler(proc)
            if (_onComfyRestarted) _onComfyRestarted({ installationId, process: proc })
            // Capture snapshot after Manager-triggered restart
            if (inst.sourceId === 'standalone') {
              installations.get(installationId).then((currentInst) => {
                if (!currentInst) return
                captureSnapshotIfChanged(currentInst.installPath, currentInst, 'restart')
                  .then(async ({ saved, filename }) => {
                    if (saved) {
                      const snapshotCount = await getSnapshotCount(currentInst.installPath)
                      installations.update(installationId, { lastSnapshot: filename, snapshotCount })
                    }
                  })
                  .catch((err) => console.warn('Snapshot capture failed:', err))
              })
            }
            return
          }
          const crashed = _runningSessions.has(installationId)
          _removeSession(installationId)
          if (!sender.isDestroyed()) {
            sender.send('comfy-exited', { installationId, crashed, exitCode: code, installationName: inst.name })
          }
          if (_onComfyExited) _onComfyExited({ installationId })
        })
      }
      attachExitHandler(proc)

      if (_onLaunch) {
        _onLaunch({ port: launchCmd.port!, process: proc, installation: inst, mode })
      }
      return { ok: true, mode, port: launchCmd.port }
    }
    // Delegate to source plugin's handleAction
    const abort = new AbortController()
    _operationAborts.set(installationId, abort)
    const sender = _event.sender
    const sendProgress = (phase: string, detail: Record<string, unknown>): void => {
      try { if (!sender.isDestroyed()) sender.send('install-progress', { installationId, phase, ...detail }) } catch {}
    }
    const sendOutput = (text: string): void => {
      try { if (!sender.isDestroyed()) sender.send('comfy-output', { installationId, text }) } catch {}
    }
    const update = (data: Record<string, unknown>): Promise<void> =>
      installations.update(installationId, data).then(() => {})
    const source = sourceMap[inst.sourceId]
    if (!source) {
      _operationAborts.delete(installationId)
      return { ok: false, message: i18n.t('errors.unknownSource') }
    }
    try {
      return await source.handleAction(actionId, inst, actionData, { update, sendProgress, sendOutput, signal: abort.signal })
    } catch (err) {
      if (abort.signal.aborted) return { ok: false, message: 'Cancelled' }
      return { ok: false, message: (err as Error).message }
    } finally {
      _operationAborts.delete(installationId)
    }
  })
}

export async function stopRunning(installationId?: string): Promise<void> {
  if (installationId) {
    const session = _runningSessions.get(installationId)
    if (!session) return
    _broadcastToRenderer('instance-stopping', { installationId })
    // Remove from running map BEFORE killing so the exit handler in
    // attachExitHandler sees this as a clean (intentional) stop, not a crash.
    if (session.port) removePortLock(session.port)
    _runningSessions.delete(installationId)
    if (session.proc && !session.proc.killed) {
      await killProcessTree(session.proc)
    }
    _broadcastToRenderer('instance-stopped', { installationId })
  } else {
    const sessions = [..._runningSessions.entries()]
    for (const [id] of sessions) {
      _broadcastToRenderer('instance-stopping', { installationId: id })
    }
    // Remove all from running map before killing
    for (const [, session] of sessions) {
      if (session.port) removePortLock(session.port)
    }
    _runningSessions.clear()
    const kills: Promise<void>[] = []
    for (const [, session] of sessions) {
      if (session.proc && !session.proc.killed) {
        kills.push(killProcessTree(session.proc))
      }
    }
    await Promise.all(kills)
    for (const [id] of sessions) {
      _broadcastToRenderer('instance-stopped', { installationId: id })
    }
  }
}

export function hasRunningSessions(): boolean {
  return _runningSessions.size > 0
}

export function getSessionProcess(installationId: string): ChildProcess | null {
  return _runningSessions.get(installationId)?.proc ?? null
}

export function hasActiveOperations(): boolean {
  return _runningSessions.size > 0 || _operationAborts.size > 0 || getActiveDownloads().length > 0
}

export async function getActiveDetails(): Promise<QuitActiveItem[]> {
  const items: QuitActiveItem[] = []
  for (const [, session] of _runningSessions) {
    items.push({ name: session.installationName, type: 'session' })
  }
  const operationIds = [..._operationAborts.keys()].filter((id) => !_runningSessions.has(id))
  if (operationIds.length > 0) {
    const all = await installations.list()
    const byId = new Map(all.map((inst) => [inst.id, inst]))
    for (const id of operationIds) {
      items.push({ name: byId.get(id)?.name || id, type: 'operation' })
    }
  }
  for (const dl of getActiveDownloads()) {
    items.push({ name: dl.filename, type: 'download' })
  }
  return items
}

export function cancelAll(): void {
  for (const [_id, abort] of _operationAborts) {
    abort.abort()
  }
  _operationAborts.clear()
  stopRunning()
}
