import { app, ipcMain, BrowserWindow, shell } from 'electron'
import { fetchJSON } from './fetch'
import * as settings from '../settings'
import type { AppUpdater, ProgressInfo } from 'electron-updater'

const REPO = 'Comfy-Org/ComfyUI-Launcher'
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`

interface UpdateInfo {
  version: string
  tag: string
  url: string
}

let _updateInfo: UpdateInfo | null = null
let _autoUpdater: AppUpdater | null = null

function broadcast(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    try {
      if (!win.isDestroyed()) win.webContents.send(channel, data)
    } catch {}
  })
}

function currentVersion(): string {
  if (app.isPackaged) return app.getVersion()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../../package.json') as { version: string }
  return pkg.version
}

function isNewer(remote: string, local: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .replace(/-.+$/, '')
      .split('.')
      .map(Number)
  const r = parse(remote)
  const l = parse(local)
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] ?? 0
    const lv = l[i] ?? 0
    if (rv > lv) return true
    if (rv < lv) return false
  }
  return false
}

async function checkForUpdate(): Promise<{ available: boolean; version?: string; error?: string }> {
  const release = (await fetchJSON(RELEASES_URL)) as { tag_name: string; html_url: string }
  const remoteVersion = release.tag_name.replace(/^v/, '')
  const localVersion = currentVersion()

  if (isNewer(remoteVersion, localVersion)) {
    _updateInfo = {
      version: remoteVersion,
      tag: release.tag_name,
      url: release.html_url,
    }
    broadcast('update-available', _updateInfo)
    return { available: true, version: remoteVersion }
  }

  _updateInfo = null
  return { available: false }
}

function loadAutoUpdater(): AppUpdater | null {
  if (_autoUpdater) return _autoUpdater
  try {
    // Dynamic require - electron-updater is only available in packaged builds
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as { autoUpdater: AppUpdater }
    _autoUpdater = autoUpdater
    _autoUpdater.autoDownload = false
    _autoUpdater.autoInstallOnAppQuit = false

    _autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      broadcast('update-download-progress', {
        percent: Math.round(progress.percent),
        transferred: (progress.transferred / 1048576).toFixed(1),
        total: (progress.total / 1048576).toFixed(1),
      })
    })

    _autoUpdater.on('update-downloaded', () => {
      broadcast('update-downloaded', _updateInfo)
    })

    _autoUpdater.on('error', (err: Error) => {
      broadcast('update-error', { message: err.message })
    })

    return _autoUpdater
  } catch {
    return null
  }
}

export function register(): void {
  ipcMain.handle('check-for-update', async () => {
    try {
      return await checkForUpdate()
    } catch (err) {
      return { available: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('download-update', async () => {
    if (!_updateInfo) {
      broadcast('update-error', { message: 'No update available. Try checking for updates first.' })
      return
    }
    if (!app.isPackaged) {
      shell.openExternal(_updateInfo.url)
      return
    }
    const updater = loadAutoUpdater()
    if (updater) {
      await updater.checkForUpdates()
      await updater.downloadUpdate()
    } else {
      shell.openExternal(_updateInfo.url)
    }
  })

  ipcMain.handle('install-update', () => {
    const updater = loadAutoUpdater()
    if (updater) {
      updater.quitAndInstall(false, true)
    }
  })

  ipcMain.handle('get-pending-update', () => _updateInfo)

  // Check on startup and periodically (respects autoUpdate setting at each check)
  const runIfEnabled = (): void => {
    if (settings.get('autoUpdate') !== false) checkForUpdate().catch(() => {})
  }
  setTimeout(runIfEnabled, 2000)
  setInterval(runIfEnabled, 10 * 60 * 1000)
}
