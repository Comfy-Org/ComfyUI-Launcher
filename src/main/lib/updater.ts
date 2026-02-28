import { ipcMain, BrowserWindow } from 'electron'
import todesktop from '@todesktop/runtime'
import * as settings from '../settings'

interface UpdateInfo {
  version: string
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
    _updateInfo = { version }
    broadcast('update-downloaded', _updateInfo)
  })

  updater.on('error', (...args: unknown[]) => {
    broadcast('update-error', { message: updaterErrorMessage(args) })
  })
}

async function checkForUpdate(source: string): Promise<{ available: boolean; version?: string; error?: string }> {
  const updater = getAutoUpdater()
  if (!updater) {
    return { available: false, error: UPDATER_UNAVAILABLE_MESSAGE }
  }
  bindUpdaterEvents()
  const result = await updater.checkForUpdates({
    source,
    disableUpdateReadyAction: true,
  })
  const version = versionFromPayload(result)
  return version ? { available: true, version } : { available: false }
}

function runCheck(source: string): Promise<{ available: boolean; version?: string; error?: string }> {
  return checkForUpdate(source)
}

export function register(): void {
  bindUpdaterEvents()

  ipcMain.handle('check-for-update', async () => {
    try {
      return await runCheck('manual-check')
    } catch (err) {
      return { available: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('download-update', async () => {
    try {
      const result = await runCheck('download-button')
      if (!result.available && !_updateInfo) {
        broadcast('update-error', { message: result.error || NO_UPDATE_AVAILABLE_MESSAGE })
      }
    } catch (err) {
      broadcast('update-error', { message: err instanceof Error ? err.message : String(err) })
    }
  })

  ipcMain.handle('install-update', () => {
    const updater = getAutoUpdater()
    if (!updater) {
      broadcast('update-error', { message: UPDATER_UNAVAILABLE_MESSAGE })
      return
    }
    try {
      updater.restartAndInstall()
    } catch (err) {
      broadcast('update-error', { message: err instanceof Error ? err.message : String(err) })
    }
  })

  ipcMain.handle('get-pending-update', () => _updateInfo)

  // Check on startup and periodically (respects autoUpdate setting at each check)
  const runIfEnabled = (): void => {
    if (settings.get('autoUpdate') !== false) runCheck('auto-check').catch(() => {})
  }
  setTimeout(runIfEnabled, 2000)
  setInterval(runIfEnabled, 10 * 60 * 1000)
}
