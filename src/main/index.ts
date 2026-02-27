import { app, BrowserWindow, Tray, Menu, ipcMain } from 'electron'
import path from 'path'
import type { ChildProcess } from 'child_process'
import * as ipc from './lib/ipc'
import * as updater from './lib/updater'
import * as settings from './settings'
import * as i18n from './lib/i18n'
import { migrateXdgPaths } from './lib/paths'
import { waitForPort } from './lib/process'
import type { InstallationRecord } from './installations'

const APP_ICON = path.join(__dirname, '..', '..', 'assets', 'Comfy_Logo_x256.png')
const TRAY_ICON = path.join(__dirname, '..', '..', 'assets', 'Comfy_Logo_x32.png')

let launcherWindow: BrowserWindow | null = null
let tray: Tray | null = null
const comfyWindows = new Map<string, BrowserWindow>()

function createLauncherWindow(): void {
  launcherWindow = new BrowserWindow({
    width: 1470,
    height: 880,
    minWidth: 650,
    minHeight: 500,
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  })

  launcherWindow.setMenuBarVisibility(false)

  if (process.env['ELECTRON_RENDERER_URL']) {
    launcherWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    launcherWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  launcherWindow.on('close', (e) => {
    const onClose = (settings.get('onLauncherClose') as string | undefined) || 'tray'
    if (onClose === 'tray') {
      e.preventDefault()
      launcherWindow!.hide()
      createTray()
      return
    }
    if (ipc.hasActiveOperations()) {
      e.preventDefault()
      if (!launcherWindow!.isDestroyed()) {
        launcherWindow!.webContents.send('confirm-quit')
      }
      return
    }
    quitApp()
  })
}

function updateTrayMenu(): void {
  if (!tray) return
  const contextMenu = Menu.buildFromTemplate([
    { label: i18n.t('tray.showLauncher'), click: () => showLauncher() },
    { type: 'separator' },
    { label: i18n.t('tray.quit'), click: () => quitApp() },
  ])
  tray.setContextMenu(contextMenu)
}

function createTray(): void {
  if (tray) return

  tray = new Tray(TRAY_ICON)
  tray.setToolTip('ComfyUI Launcher')
  updateTrayMenu()
  tray.on('double-click', () => showLauncher())
}

function showLauncher(): void {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.show()
    launcherWindow.focus()
  }
}

function quitApp(): void {
  ipc.cancelAll()
  for (const [_id, win] of comfyWindows) {
    if (!win.isDestroyed()) win.destroy()
  }
  comfyWindows.clear()
  if (tray) {
    tray.destroy()
    tray = null
  }
  app.exit(0)
}

function onComfyExited({ installationId }: { installationId?: string } = {}): void {
  if (installationId) {
    const win = comfyWindows.get(installationId)
    if (win && !win.isDestroyed()) win.destroy()
    comfyWindows.delete(installationId)
  }
}

function onComfyRestarted({ installationId, process: _proc }: { installationId?: string; process?: ChildProcess } = {}): void {
  if (!installationId) return
  const win = comfyWindows.get(installationId)
  if (!win || win.isDestroyed()) return

  const currentUrl = win.webContents.getURL()
  if (!currentUrl) return

  const url = new URL(currentUrl)
  const port = parseInt(url.port, 10)
  if (!port) return

  waitForPort(port, '127.0.0.1', { timeoutMs: 120000 })
    .then(() => {
      if (!win.isDestroyed()) {
        win.webContents.stop()
        win.loadURL(currentUrl)
      }
    })
    .catch((err) => {
      console.error(`ComfyUI restart failed for ${installationId}:`, err)
      if (launcherWindow && !launcherWindow.isDestroyed()) {
        launcherWindow.webContents.send('comfy-output', {
          installationId,
          text: `\n--- Restart failed: ${err.message || err} ---\n`,
        })
      }
    })
}

function onStop({ installationId }: { installationId?: string } = {}): void {
  if (installationId) {
    const win = comfyWindows.get(installationId)
    if (win && !win.isDestroyed()) win.destroy()
    comfyWindows.delete(installationId)
  } else {
    for (const [_id, win] of comfyWindows) {
      if (!win.isDestroyed()) win.destroy()
    }
    comfyWindows.clear()
  }
}

function onLaunch({ port, url, process: proc, installation, mode }: {
  port: number
  url?: string
  process: ChildProcess | null
  installation: InstallationRecord
  mode: string
}): void {
  const comfyUrl = url || `http://127.0.0.1:${port}`
  const installationId = installation.id

  if (mode === 'console') {
    if (proc) {
      proc.on('exit', () => {
        comfyWindows.delete(installationId)
      })
    }
    return
  }

  const comfyWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: APP_ICON,
    title: installation.name,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: (installation.browserPartition as string | undefined) === 'unique'
        ? `persist:${installation.id}`
        : 'persist:shared',
    },
  })
  comfyWindow.setMenuBarVisibility(false)
  comfyWindow.webContents.on('did-create-window', (childWindow) => {
    childWindow.setIcon(APP_ICON)
  })
  comfyWindow.webContents.on('page-title-updated', (e, title) => {
    e.preventDefault()
    comfyWindow.setTitle(`${title} — ${installation.name}`)
  })
  comfyWindow.loadURL(comfyUrl)

  const reloadComfy = (): void => {
    if (comfyWindow.isDestroyed()) return
    comfyWindow.webContents.stop()
    comfyWindow.loadURL(comfyUrl)
  }

  comfyWindow.webContents.on('will-prevent-unload', (e) => {
    e.preventDefault()
  })

  comfyWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F5' || (input.key === 'r' && (input.control || input.meta))) {
      e.preventDefault()
      reloadComfy()
    }
  })

  let failRetryTimer: ReturnType<typeof setTimeout> | null = null
  comfyWindow.webContents.on('did-fail-load', (_e, code, _desc, _failUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || failRetryTimer) return
    failRetryTimer = setTimeout(() => {
      failRetryTimer = null
      if (!comfyWindow.isDestroyed()) {
        comfyWindow.loadURL(comfyUrl)
      }
    }, 2000)
  })

  comfyWindow.webContents.on('render-process-gone', () => {
    reloadComfy()
  })

  comfyWindow.on('close', (e) => {
    e.preventDefault()
    ipc.stopRunning(installationId)
    comfyWindow.destroy()
  })

  comfyWindow.on('closed', () => {
    comfyWindows.delete(installationId)
  })

  comfyWindows.set(installationId, comfyWindow)

  if (proc) {
    proc.on('exit', () => {
      // Session registry handles state cleanup
    })
  }
}

ipcMain.handle('quit-app', () => quitApp())

ipcMain.handle('focus-comfy-window', (_event, installationId: string) => {
  const win = comfyWindows.get(installationId)
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return true
  }
  return false
})

app.whenReady().then(() => {
  migrateXdgPaths()

  const locale = (settings.get('language') as string | undefined) || app.getLocale().split('-')[0]
  i18n.init(locale)
  ipc.register({ onLaunch, onStop, onComfyExited, onComfyRestarted, onLocaleChanged: updateTrayMenu })
  updater.register()
  createTray()
  createLauncherWindow()
})

app.on('window-all-closed', () => {
  if (!tray && !ipc.hasRunningSessions()) {
    app.quit()
  }
})
