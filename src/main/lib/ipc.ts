import path from 'path'
import fs from 'fs'
import os from 'os'
import { app, ipcMain, dialog, shell, BrowserWindow, nativeTheme } from 'electron'
import { execFile, spawn, execFileSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import sources from '../sources/index'
import * as installations from '../installations'
import type { InstallationRecord } from '../installations'
import * as settings from '../settings'
import { defaultInstallDir } from './paths'
import { download } from './download'
import { createCache } from './cache'
import { extractNested as extract } from './extract'
import { deleteDir } from './delete'
import {
  spawnProcess, waitForPort, waitForUrl, killProcessTree, killByPort,
  findPidsByPort, getProcessInfo, looksLikeComfyUI, setPortArg,
  findAvailablePort, writePortLock, readPortLock, removePortLock,
} from './process'
import { detectGPU, validateHardware, checkNvidiaDriver } from './gpu'
import { getDiskSpace, validateInstallPath } from './disk'
import type { GpuInfo } from './gpu'
import { formatTime } from './util'
import * as releaseCache from './release-cache'
import * as i18n from './i18n'
import { ensureModelPathsConfig } from './models'
import { copyDirWithProgress } from './copy'
import { fetchJSON } from './fetch'
import { fetchLatestRelease, truncateNotes } from './comfyui-releases'
import { captureSnapshotIfChanged, getSnapshotCount } from './snapshots'
import type { FieldOption, SourcePlugin } from '../types/sources'
import type { Theme, ResolvedTheme } from '../../types/ipc'
import type { LaunchCmd } from './process'

const MARKER_FILE = '.comfyui-launcher'
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

const sourceMap: Record<string, SourcePlugin> = Object.fromEntries(sources.map((s) => [s.id, s]))

function resolveSource(sourceId: string): SourcePlugin {
  const source = sourceMap[sourceId]
  if (!source) throw new Error(`Unknown source: ${sourceId}`)
  return source
}

async function resolveInstallation(id: string): Promise<InstallationRecord> {
  const inst = await installations.get(id)
  if (!inst) throw new Error(`Unknown installation: ${id}`)
  return inst
}

async function findDuplicatePath(installPath: string): Promise<InstallationRecord | null> {
  const normalized = path.resolve(installPath)
  return (await installations.list()).find((i) => i.installPath && path.resolve(i.installPath) === normalized) ?? null
}

async function uniqueName(baseName: string): Promise<string> {
  const all = await installations.list()
  return installations.uniqueName(baseName, all)
}

/** Re-assign primary to the first remaining local install, or clear it. */
async function autoAssignPrimary(removedId: string): Promise<void> {
  const currentPrimary = settings.get('primaryInstallId') as string | undefined
  if (currentPrimary !== removedId) return
  const all = (await installations.list()).filter((i) => i.id !== removedId)
  const firstLocal = all.find((i) => {
    const source = sourceMap[i.sourceId]
    return source && source.category === 'local'
  })
  settings.set('primaryInstallId', firstLocal?.id ?? null)
}

/** Set as primary if this is the first local install and no primary is set. */
function ensureDefaultPrimary(entry: InstallationRecord): void {
  const source = sourceMap[entry.sourceId]
  if (source && source.category === 'local' && !settings.get('primaryInstallId')) {
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

async function performCopy(
  inst: InstallationRecord,
  name: string,
  sendProgress: (phase: string, detail: Record<string, unknown>) => void,
  signal?: AbortSignal
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

    const source = resolveSource(inst.sourceId)
    if (source.fixupCopy) {
      await source.fixupCopy(inst.installPath, destPath)
    }

    const { id: _id, name: _name, installPath: _path, createdAt: _created, seen: _seen, status: _status, ...inherited } = inst
    const finalName = await uniqueName(name)
    const entry = await installations.add({
      ...inherited,
      name: finalName,
      installPath: destPath,
      status: 'installed',
      seen: false,
      browserPartition: 'unique',
    })

    try { fs.writeFileSync(path.join(destPath, MARKER_FILE), entry.id) } catch {}

    return { entry, destPath }
  } catch (err) {
    try { await fs.promises.rm(destPath, { recursive: true, force: true }) } catch {}
    throw err
  }
}

function createSessionPath(): string {
  return path.join(os.tmpdir(), `comfyui-launcher-${Date.now()}`)
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

function _broadcastToRenderer(channel: string, data: Record<string, unknown>): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  })
}

function _addSession(installationId: string, { proc, port, url, mode, installationName }: Omit<SessionInfo, 'startedAt'>): void {
  _runningSessions.set(installationId, { proc, port, url, mode, installationName, startedAt: Date.now() })
  _broadcastToRenderer('instance-started', { installationId, port, url, mode, installationName })
  installations.update(installationId, { lastLaunchedAt: Date.now() }).catch((err) => {
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
    if (inst.updateInfo && !inst.updateInfoByTrack) {
      const updateInfo = inst.updateInfo as Record<string, unknown>
      const track = (updateInfo.track as string | undefined) || (inst.updateTrack as string | undefined) || 'stable'
      const { track: _t, ...rest } = updateInfo
      inst.updateInfoByTrack = { [track]: rest }
      delete inst.updateInfo
      changed = true
    }
    if (inst.updateInfoByTrack) {
      const repo = 'Comfy-Org/ComfyUI'
      const trackMap = inst.updateInfoByTrack as Record<string, Record<string, unknown>>
      for (const [track, info] of Object.entries(trackMap)) {
        if (info.latestTag && !releaseCache.get(repo, track)) {
          const { installedTag: _it, available: _av, ...releaseFields } = info
          releaseCache.set(repo, track, releaseFields)
        }
        if (info.latestTag || info.releaseName || info.releaseNotes) {
          trackMap[track] = { installedTag: info.installedTag }
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

async function checkInstallationUpdates(): Promise<void> {
  try {
    const all = await installations.list()
    const tracks = new Set<string>()
    for (const inst of all) {
      const source = sourceMap[inst.sourceId]
      if (!source || source.skipInstall) continue
      if (inst.status !== 'installed') continue
      const track = (inst.updateTrack as string | undefined) || 'stable'
      tracks.add(track)
    }
    if (tracks.size === 0) return
    await Promise.allSettled(
      [...tracks].map((track) =>
        releaseCache.getOrFetch(COMFYUI_REPO, track, async () => {
          const release = await fetchLatestRelease(track)
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
      version: 'cloud',
      remoteUrl: 'https://cloud.comfy.org/',
      launchMode: 'window',
      browserPartition: 'shared',
    },
  ])
  installations.ensureExists('cloud', {
    name: 'Comfy Cloud',
    sourceId: 'cloud',
    version: 'cloud',
    remoteUrl: 'https://cloud.comfy.org/',
    launchMode: 'window',
    browserPartition: 'shared',
    status: 'installed',
  })
  migrateDefaults()

  // Sweep empty/broken local installations on startup
  void (async () => {
    try {
      const all = await installations.list()
      for (const inst of all) {
        const source = sourceMap[inst.sourceId]
        if (!source || source.skipInstall) continue
        if (!inst.installPath) continue
        if (!isEffectivelyEmptyInstallDir(inst.installPath)) continue
        try { fs.rmSync(inst.installPath, { recursive: true, force: true }) } catch {}
        await installations.remove(inst.id)
      }
    } catch {}
  })()

  // Pre-warm the ETag cache for GitHub API URLs
  void (async () => {
    try {
      await Promise.allSettled([
        fetchJSON('https://api.github.com/repos/Comfy-Org/ComfyUI-Launcher-Environments/releases?per_page=30'),
        fetchJSON('https://api.github.com/repos/Comfy-Org/ComfyUI-Launcher-Environments/releases/latest'),
        fetchJSON('https://api.github.com/repos/Comfy-Org/ComfyUI/releases?per_page=30'),
      ])
    } catch {}
  })()

  // Check installation updates on startup and periodically
  setTimeout(() => checkInstallationUpdates(), 3_000)
  setInterval(() => checkInstallationUpdates(), UPDATE_CHECK_INTERVAL)

  // Sources
  ipcMain.handle('get-sources', () =>
    sources
      .filter((s) => s.category !== 'cloud' && !s.hidden)
      .filter((s) => !s.platforms || s.platforms.includes(process.platform))
      .map((s) => ({ id: s.id, label: s.label, category: s.category, description: s.description, fields: s.fields, skipInstall: !!s.skipInstall, hideInstallPath: !!s.skipInstall }))
  )

  ipcMain.handle('get-field-options', async (_event, sourceId: string, fieldId: string, selections: Record<string, unknown>) => {
    const gpu = _gpuPromise ? await _gpuPromise : null
    const options = await resolveSource(sourceId).getFieldOptions(
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
    const source = resolveSource(sourceId)
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

  // Installations
  ipcMain.handle('get-installations', async () => {
    const list = await installations.list()

    // Ensure a primary is always set when local installs exist
    const currentPrimary = settings.get('primaryInstallId') as string | undefined
    if (!currentPrimary || !list.some((i) => i.id === currentPrimary)) {
      const firstLocal = list.find((i) => {
        const s = sourceMap[i.sourceId]
        return s && s.category === 'local'
      })
      const newPrimary = firstLocal?.id ?? null
      if (currentPrimary !== newPrimary) {
        settings.set('primaryInstallId', newPrimary)
      }
    }

    return list.map((inst) => {
      const source = sourceMap[inst.sourceId]
      if (!source) return inst
      const listPreview = source.getListPreview ? source.getListPreview(inst) : undefined
      const statusTag = inst.status === 'partial-delete'
        ? { label: i18n.t('errors.deleteInterrupted'), style: 'danger' }
        : inst.status === 'failed'
        ? { label: i18n.t('errors.installFailed'), style: 'danger' }
        : (source.getStatusTag ? source.getStatusTag(inst) : undefined)
      return {
        ...inst,
        sourceLabel: source.label,
        sourceCategory: source.category,
        hasConsole: source.hasConsole !== false,
        ...(listPreview != null ? { listPreview } : {}),
        ...(statusTag ? { statusTag } : {}),
      }
    })
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

  ipcMain.handle('probe-installation', (_event, dirPath: string) => {
    const results: Record<string, unknown>[] = []
    for (const source of sources) {
      if (source.probeInstallation) {
        const data = source.probeInstallation(dirPath)
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
    const inst = await resolveInstallation(installationId)
    if (_operationAborts.has(installationId)) {
      return { ok: false, message: 'Another operation is already running for this installation.' }
    }
    const source = resolveSource(inst.sourceId)
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
        sendProgress('steps', { steps: source.installSteps })
      }
      const abort = new AbortController()
      _operationAborts.set(installationId, abort)
      const cache = createCache(settings.get('cacheDir') as string, settings.get('maxCachedFiles') as number)
      try {
        await source.install(inst, { sendProgress, download, cache, extract, signal: abort.signal })
        if (source.postInstall) {
          const update = (data: Record<string, unknown>): Promise<void> =>
            installations.update(installationId, data).then(() => {})
          await source.postInstall(inst, { sendProgress, update })
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
    const inst = await resolveInstallation(installationId)
    const source = resolveSource(inst.sourceId)
    return source.getListActions ? source.getListActions(inst) : []
  })

  // Detail — validate editable fields dynamically from source schema
  ipcMain.handle('update-installation', async (_event, installationId: string, data: Record<string, unknown>) => {
    const inst = await resolveInstallation(installationId)
    const source = resolveSource(inst.sourceId)
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
    const inst = await resolveInstallation(installationId)
    return resolveSource(inst.sourceId).getDetailSections(inst)
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
          { id: 'onLauncherClose', label: i18n.t('settings.onLauncherClose'), type: 'select', value: s.onLauncherClose || 'quit',
            options: [
              { value: 'quit', label: i18n.t('settings.closeQuit') },
              { value: 'tray', label: i18n.t('settings.closeTray') },
            ] },
        ],
      },
      {
        title: i18n.t('settings.downloads'),
        fields: [
          { id: 'cacheDir', label: i18n.t('settings.cacheDir'), type: 'path', value: s.cacheDir, openable: true },
          { id: 'maxCachedFiles', label: i18n.t('settings.maxCachedFiles'), type: 'number', value: s.maxCachedFiles, min: 1, max: 50 },
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
    let version = app.getVersion()
    if (!app.isPackaged) {
      try {
        version = execFileSync('git', ['describe', '--tags', '--always'], { cwd: __dirname, encoding: 'utf8' }).trim() || version
      } catch {}
    }
    const aboutSection = {
      title: i18n.t('settings.about'),
      fields: [
        { label: i18n.t('settings.version'), value: version, readonly: true },
        { label: i18n.t('settings.platform'), value: `${process.platform} (${process.arch})`, readonly: true },
      ],
      actions: [
        { id: 'github', label: 'GitHub', url: 'https://github.com/Comfy-Org/ComfyUI-Launcher' },
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
    const inst = await resolveInstallation(installationId)
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
        return { ok: false, message: 'Safety check failed: this directory was not created by ComfyUI Launcher. Use Untrack to remove it from the list, then delete the files manually.' }
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
        if (abort.signal.aborted) {
          try {
            fs.mkdirSync(inst.installPath, { recursive: true })
            fs.writeFileSync(markerPath, markerContent)
          } catch {}
          await installations.update(installationId, { status: 'partial-delete' })
        }
        return { ok: false, message: (err as Error).message }
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

        const { entry } = await performCopy(inst, name, sendProgress, abort.signal)

        const updateSendProgress = (phase: string, detail: Record<string, unknown>): void => {
          if (phase !== 'steps') sendProgress(phase, detail)
        }
        try {
          const source = resolveSource(inst.sourceId)
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

      const source = resolveSource(inst.sourceId)
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
        })
        try { fs.writeFileSync(path.join(destPath, MARKER_FILE), entry.id) } catch {}

        const newUpdate = (data: Record<string, unknown>): Promise<void> =>
          installations.update(entry!.id, data).then(() => {})
        await source.postInstall!(installRecord, { sendProgress, update: newUpdate })
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
      const source = resolveSource(inst.sourceId)
      if (!source.skipInstall && isEffectivelyEmptyInstallDir(inst.installPath)) {
        return { ok: false, message: i18n.t('errors.installDirEmpty') }
      }
      const launchCmdRaw = source.getLaunchCommand(inst)
      if (!launchCmdRaw) {
        return { ok: false, message: i18n.t('errors.noEnvFound') }
      }
      const launchCmd = launchCmdRaw
      // Inject shared paths if this installation uses them
      if ((inst.useSharedPaths as boolean | undefined) !== false && launchCmd.args) {
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
          if (abort.signal.aborted) return { ok: false, message: i18n.t('errors.launchCancelled') }
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

      if (actionData && actionData.portOverride) {
        setPortArg(launchCmd as LaunchCmd, actionData.portOverride as number)
      }

      const existingPids = await findPidsByPort(launchCmd.port!)
      if (existingPids.length > 0) {
        const defaults = source.getDefaults ? source.getDefaults() : {}
        const portConflictMode = (inst.portConflict as string | undefined) || (defaults.portConflict as string | undefined) || 'auto'
        const userArgs = ((inst.launchArgs as string | undefined) || '').trim()
        const portIsExplicit = /(?:^|\s)--port\b/.test(userArgs)

        let nextPort: number | null = null
        try {
          nextPort = await findAvailablePort('127.0.0.1', launchCmd.port! + 1, launchCmd.port! + 1000)
        } catch {}

        if (portConflictMode === 'auto' && nextPort && !portIsExplicit) {
          sendProgress('launch', { percent: -1, status: i18n.t('launch.portBusyUsing', { old: launchCmd.port!, new: nextPort }) })
          setPortArg(launchCmd as LaunchCmd, nextPort)
        } else {
          const lock = readPortLock(launchCmd.port!)
          let message: string
          let isComfy: boolean
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
          _operationAborts.delete(installationId)
          return { ok: false, message, portConflict: { port: launchCmd.port, pids: existingPids, isComfy, nextPort } }
        }
      }

      const sessionPath = createSessionPath()
      const launchEnv = { ...process.env, __COMFY_CLI_SESSION__: sessionPath }
      const sendOutput = (text: string): void => {
        if (!sender.isDestroyed()) {
          sender.send('comfy-output', { installationId, text })
        }
      }

      function spawnComfy(): { proc: ChildProcess; getStderr: () => string } {
        const p = spawnProcess(launchCmd.cmd!, launchCmd.args!, launchCmd.cwd!, launchEnv)
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

      const tryLaunch = async (): Promise<{ ok: true; proc: ChildProcess; getStderr: () => string } | { ok: false; message: string }> => {
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
              const retryPort = await findAvailablePort('127.0.0.1', launchCmd.port! + 1, launchCmd.port! + 1000)
              sendOutput(`\nPort ${launchCmd.port} in use, retrying on port ${retryPort}…\n`)
              setPortArg(launchCmd as LaunchCmd, retryPort)
              return tryLaunch()
            } catch {}
          }
          return { ok: false, message: (err as Error).message }
        }
      }

      const launchResult = await tryLaunch()
      if (!launchResult.ok) {
        _operationAborts.delete(installationId)
        return { ok: false, message: launchResult.message }
      }
      let { proc } = launchResult

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
    // Actions that modify the pip environment require ComfyUI to be stopped
    if (actionId === 'snapshot-restore' && _runningSessions.has(installationId)) {
      return { ok: false, message: i18n.t('standalone.snapshotRestoreStopRequired') }
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
    try {
      return await resolveSource(inst.sourceId).handleAction(actionId, inst, actionData, { update, sendProgress, sendOutput, signal: abort.signal })
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
    _removeSession(installationId)
    if (session.proc && !session.proc.killed) {
      killProcessTree(session.proc)
    }
  } else {
    for (const [_id, session] of _runningSessions) {
      if (session.proc && !session.proc.killed) {
        killProcessTree(session.proc)
      }
      if (session.port) removePortLock(session.port)
    }
    _runningSessions.clear()
  }
}

export function hasRunningSessions(): boolean {
  return _runningSessions.size > 0
}

export function hasActiveOperations(): boolean {
  return _runningSessions.size > 0 || _operationAborts.size > 0
}

export function cancelAll(): void {
  for (const [_id, abort] of _operationAborts) {
    abort.abort()
  }
  _operationAborts.clear()
  stopRunning()
}
