import { app, ipcMain, BrowserWindow } from 'electron'
import todesktop from '@todesktop/runtime'
import * as settings from '../settings'
import { evaluateUpdaterCanaryGate } from './updateGate'
import { captureError, captureTelemetry } from './analytics'

interface UpdateInfo {
  version: string
}

interface CheckResult {
  available: boolean
  version?: string
  error?: string
  blocked?: boolean
  blockReason?: string
}

interface CheckOptions {
  source: string
  userInitiated?: boolean
}

let _updateInfo: UpdateInfo | null = null
let _listenersBound = false

const NO_UPDATE_AVAILABLE_MESSAGE = 'No update available. Try checking for updates first.'
const UPDATER_UNAVAILABLE_MESSAGE = 'ToDesktop auto-updater is unavailable.'

function broadcast(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    try {
      if (!win.isDestroyed()) win.webContents.send(channel, data)
    } catch {}
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function versionFromPayload(payload: unknown): string | null {
  const topLevel = asRecord(payload)
  if (!topLevel) return null
  const direct = topLevel.version
  if (typeof direct === 'string' && direct) return direct
  const nested = asRecord(topLevel.updateInfo)
  if (!nested) return null
  const nestedVersion = nested.version
  if (typeof nestedVersion === 'string' && nestedVersion) return nestedVersion
  return null
}

function numberFromPayload(payload: unknown, key: string): number | null {
  const data = asRecord(payload)
  if (!data) return null
  const value = data[key]
  if (typeof value !== 'number' || Number.isNaN(value)) return null
  return value
}

function updaterErrorMessage(args: unknown[]): string {
  for (const arg of args) {
    if (arg instanceof Error && arg.message) return arg.message
  }
  for (const arg of args) {
    if (typeof arg === 'string' && arg.trim()) return arg
  }
  return 'Update check failed.'
}

function getAutoUpdater() {
  return todesktop.autoUpdater
}

function bindUpdaterEvents(): void {
  if (_listenersBound) return
  const updater = getAutoUpdater()
  if (!updater) return
  _listenersBound = true

  updater.on('update-available', (info: unknown) => {
    const version = versionFromPayload(info)
    if (!version) return
    captureTelemetry('updater_update_available', { version })
    broadcast('update-available', { version })
  })

  updater.on('download-progress', (progress: unknown) => {
    const percent = numberFromPayload(progress, 'percent')
    const transferredBytes = numberFromPayload(progress, 'transferred')
    const totalBytes = numberFromPayload(progress, 'total')
    if (percent === null || transferredBytes === null || totalBytes === null) return
    broadcast('update-download-progress', {
      percent: Math.round(percent),
      transferred: (transferredBytes / 1048576).toFixed(1),
      total: (totalBytes / 1048576).toFixed(1),
    })
  })

  updater.on('update-downloaded', (event: unknown) => {
    const version = versionFromPayload(event)
    if (!version) return
    captureTelemetry('updater_update_downloaded', { version })
    _updateInfo = { version }
    broadcast('update-downloaded', _updateInfo)
  })

  updater.on('error', (...args: unknown[]) => {
    const message = updaterErrorMessage(args)
    captureError('updater_runtime_error', new Error(message), { phase: 'event' })
    broadcast('update-error', { message })
  })
}

async function runCheck({ source, userInitiated = false }: CheckOptions): Promise<CheckResult> {
  const startedAt = Date.now()
  const gate = await evaluateUpdaterCanaryGate(undefined, undefined, {
    currentVersion: app.getVersion(),
  })
  captureTelemetry('updater_gate_evaluated', {
    source,
    userInitiated,
    allowed: gate.allowed,
    reason: gate.reason,
    variant: gate.variant,
    currentVersion: app.getVersion(),
  })
  const gateSummary = `[updater] canary gate ${source}: ${gate.allowed ? 'allow' : 'block'} (${gate.reason})`
  if (gate.allowed) {
    console.info(gateSummary)
  } else {
    console.warn(gateSummary)
    _updateInfo = null
    if (userInitiated) {
      broadcast('update-error', { message: `Updates are currently paused by rollout policy. (${gate.reason})` })
    }
    return { available: false, blocked: true, blockReason: gate.reason, error: gate.detail }
  }

  const updater = getAutoUpdater()
  if (!updater) {
    captureError('updater_unavailable', new Error(UPDATER_UNAVAILABLE_MESSAGE), { source, userInitiated })
    return { available: false, error: UPDATER_UNAVAILABLE_MESSAGE }
  }
  bindUpdaterEvents()

  captureTelemetry('updater_check_started', { source, userInitiated })

  try {
    const result = await updater.checkForUpdates({
      source,
      disableUpdateReadyAction: true,
    })
    const version = versionFromPayload(result)
    captureTelemetry('updater_check_result', {
      source,
      userInitiated,
      available: version !== null,
      version: version ?? undefined,
      durationMs: Date.now() - startedAt,
    })
    return version ? { available: true, version } : { available: false }
  } catch (err) {
    captureError('updater_check_failed', err, {
      source,
      userInitiated,
      durationMs: Date.now() - startedAt,
    })
    throw err
  }
}

export function register(): void {
  bindUpdaterEvents()

  ipcMain.handle('check-for-update', async () => {
    try {
      return await runCheck({ source: 'manual-check', userInitiated: true })
    } catch (err) {
      return { available: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('download-update', async () => {
    try {
      const result = await runCheck({ source: 'download-button', userInitiated: true })
      if (result.blocked) return
      if (!result.available && !_updateInfo) {
        captureTelemetry('updater_download_without_available_update', { source: 'download-button' })
        broadcast('update-error', { message: result.error || NO_UPDATE_AVAILABLE_MESSAGE })
      }
    } catch (err) {
      captureError('updater_download_update_failed', err, { source: 'download-button' })
      broadcast('update-error', { message: err instanceof Error ? err.message : String(err) })
    }
  })

  ipcMain.handle('install-update', () => {
    const updater = getAutoUpdater()
    if (!updater) {
      captureError('updater_install_unavailable', new Error(UPDATER_UNAVAILABLE_MESSAGE), { source: 'install-update' })
      broadcast('update-error', { message: UPDATER_UNAVAILABLE_MESSAGE })
      return
    }
    try {
      captureTelemetry('updater_install_triggered', {
        source: 'install-update',
        version: _updateInfo?.version,
      })
      updater.restartAndInstall()
    } catch (err) {
      captureError('updater_install_failed', err, { source: 'install-update', version: _updateInfo?.version })
      broadcast('update-error', { message: err instanceof Error ? err.message : String(err) })
    }
  })

  ipcMain.handle('get-pending-update', () => _updateInfo)

  // Check on startup and periodically (respects autoUpdate setting at each check)
  const runIfEnabled = (): void => {
    if (settings.get('autoUpdate') !== false) runCheck({ source: 'auto-check', userInitiated: false }).catch(() => {})
  }
  setTimeout(runIfEnabled, 2000)
  setInterval(runIfEnabled, 10 * 60 * 1000)
}
