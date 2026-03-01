import { app, BrowserWindow, Tray, Menu, ipcMain, shell, clipboard, screen } from 'electron'
import path from 'path'
import fs from 'fs'
import type { ChildProcess } from 'child_process'
import todesktop from '@todesktop/runtime'
import * as ipc from './lib/ipc'
import * as updater from './lib/updater'
import * as settings from './settings'
import * as i18n from './lib/i18n'
import { configDir, migrateXdgPaths } from './lib/paths'
import { waitForPort } from './lib/process'
import type { InstallationRecord } from './installations'
import {
  attachSessionDownloadHandler,
  cleanupWindowDownloads,
  registerDownloadIpc,
  setLauncherWindow,
} from './lib/comfyDownloadManager'
import { getModelDownloadContentScript } from './lib/comfyContentScript'

todesktop.init({ autoUpdater: false })

const APP_ICON = path.join(__dirname, '..', '..', 'assets', 'Comfy_Logo_x256.png')
const TRAY_ICON = path.join(__dirname, '..', '..', 'assets', 'Comfy_Logo_x32.png')

const POPUP_ALLOWED_PREFIXES = [
  'https://dreamboothy.firebaseapp.com/',
  'https://dreamboothy-dev.firebaseapp.com/',
  'https://checkout.comfy.org/',
]

function shouldOpenInPopup(url: string): boolean {
  return POPUP_ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))
}

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

const windowStatePath = path.join(configDir(), 'window-state.json')
let windowStateCache: Record<string, WindowBounds> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

function getWindowStateCache(): Record<string, WindowBounds> {
  if (!windowStateCache) {
    try {
      windowStateCache = JSON.parse(fs.readFileSync(windowStatePath, 'utf-8'))
    } catch {
      windowStateCache = {}
    }
  }
  return windowStateCache!
}

function flushWindowState(): void {
  if (!windowStateCache) return
  try {
    fs.mkdirSync(path.dirname(windowStatePath), { recursive: true })
    fs.writeFileSync(windowStatePath, JSON.stringify(windowStateCache, null, 2))
  } catch {}
}

function saveWindowBounds(installationId: string, window: BrowserWindow): void {
  const state = getWindowStateCache()
  const maximized = window.isMaximized()
  const bounds = window.getBounds()
  state[installationId] = {
    ...(maximized ? (state[installationId] ?? bounds) : bounds),
    maximized,
  }
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushWindowState, 500)
}

function getSavedBounds(installationId: string): WindowBounds | undefined {
  return getWindowStateCache()[installationId]
}

function getWindowOptions(installationId: string): Partial<Electron.BrowserWindowConstructorOptions> {
  const saved = getSavedBounds(installationId)
  if (!saved) return { width: 1280, height: 900 }

  const savedRect = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
  const display = screen.getDisplayMatching(savedRect)
  const { x: wx, y: wy, width: ww, height: wh } = display.workArea
  const width = Math.min(saved.width, ww)
  const height = Math.min(saved.height, wh)
  const x = Math.max(wx, Math.min(saved.x, wx + ww - width))
  const y = Math.max(wy, Math.min(saved.y, wy + wh - height))
  return { x, y, width, height }
}

function attachContextMenu(comfyWindow: BrowserWindow): void {
  comfyWindow.webContents.on('context-menu', (_event, params) => {
    const { editFlags, isEditable, selectionText, linkURL } = params
    const hasSelection = selectionText.trim().length > 0
    const hasLink = linkURL.length > 0

    if (!isEditable && !hasSelection && !hasLink) return

    const menuItems: Electron.MenuItemConstructorOptions[] = []

    if (hasLink) {
      menuItems.push(
        { label: i18n.t('contextMenu.openLinkInBrowser'), click: () => shell.openExternal(linkURL) },
        { label: i18n.t('contextMenu.copyLinkAddress'), click: () => clipboard.writeText(linkURL) },
      )
    }

    if (hasLink && (isEditable || hasSelection)) {
      menuItems.push({ type: 'separator' })
    }

    if (isEditable) {
      menuItems.push(
        { label: i18n.t('contextMenu.cut'), role: 'cut', enabled: editFlags.canCut },
        { label: i18n.t('contextMenu.copy'), role: 'copy', enabled: editFlags.canCopy },
        { label: i18n.t('contextMenu.paste'), role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { label: i18n.t('contextMenu.selectAll'), role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    } else if (hasSelection) {
      menuItems.push(
        { label: i18n.t('contextMenu.copy'), role: 'copy', enabled: editFlags.canCopy },
        { label: i18n.t('contextMenu.selectAll'), role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    }

    Menu.buildFromTemplate(menuItems).popup({ window: comfyWindow })
  })
}

let launcherWindow: BrowserWindow | null = null
let tray: Tray | null = null
const comfyWindows = new Map<string, BrowserWindow>()
let isQuitting = false

function createLauncherWindow(): void {
  launcherWindow = new BrowserWindow({
    width: 1470,
    height: 880,
    minWidth: 650,
    minHeight: 500,
    icon: APP_ICON,
    backgroundColor: '#202020',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  })
  launcherWindow.once('ready-to-show', () => launcherWindow?.show())

  launcherWindow.setMenuBarVisibility(false)
  launcherWindow.webContents.on('did-finish-load', () => {
    if (launcherWindow && !launcherWindow.isDestroyed()) {
      launcherWindow.webContents.setZoomLevel(0)
    }
  })

  function notifyZoomLevel(): void {
    if (launcherWindow && !launcherWindow.isDestroyed()) {
      const level = launcherWindow.webContents.getZoomLevel()
      launcherWindow.webContents.send('zoom-changed', level)
    }
  }

  // Pinch-to-zoom
  launcherWindow.webContents.on('zoom-changed', () => notifyZoomLevel())

  // Keyboard zoom (Ctrl/Cmd + =/-/0)
  launcherWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    const mod = input.control || input.meta
    if (mod && (input.key === '=' || input.key === '+' || input.key === '-' || input.key === '0')) {
      setTimeout(notifyZoomLevel, 50)
    }
  })

  setLauncherWindow(launcherWindow)

  launcherWindow.on('closed', () => {
    launcherWindow = null
    setLauncherWindow(null)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    launcherWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    launcherWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  launcherWindow.on('close', (e) => {
    if (isQuitting) return

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
  isQuitting = true
  ipc.cancelAll()
  for (const [_id, win] of comfyWindows) {
    if (!win.isDestroyed()) win.destroy()
  }
  comfyWindows.clear()
  if (tray) {
    tray.destroy()
    tray = null
  }
  app.quit()
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

  const saved = getSavedBounds(installationId)
  const windowOptions = getWindowOptions(installationId)
  const comfyWindow = new BrowserWindow({
    ...windowOptions,
    minWidth: 800,
    minHeight: 600,
    icon: APP_ICON,
    title: installation.name,
    backgroundColor: '#171717',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/comfyPreload.js'),
      partition: (installation.browserPartition as string | undefined) === 'unique'
        ? `persist:${installation.id}`
        : 'persist:shared',
    },
  })
  comfyWindow.setMenuBarVisibility(false)

  if (saved?.maximized) comfyWindow.maximize()

  comfyWindow.on('resize', () => saveWindowBounds(installationId, comfyWindow))
  comfyWindow.on('move', () => saveWindowBounds(installationId, comfyWindow))
  comfyWindow.webContents.on('did-create-window', (childWindow) => {
    childWindow.setIcon(APP_ICON)
  })
  comfyWindow.webContents.on('page-title-updated', (e, title) => {
    e.preventDefault()
    comfyWindow.setTitle(`${title} — ${installation.name}`)
  })
  comfyWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenInPopup(url)) {
      return { action: 'allow' }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Download management: attach session handler and inject content script
  attachSessionDownloadHandler(comfyWindow.webContents.session)
  comfyWindow.webContents.on('dom-ready', () => {
    comfyWindow.webContents
      .executeJavaScript(getModelDownloadContentScript())
      .catch(() => {})
  })

  attachContextMenu(comfyWindow)

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
    cleanupWindowDownloads(comfyWindow)
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

ipcMain.handle('reset-zoom', () => {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.webContents.setZoomLevel(0)
  }
})

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
  registerDownloadIpc()
  ipc.register({ onLaunch, onStop, onComfyExited, onComfyRestarted, onLocaleChanged: updateTrayMenu })
  updater.register()
  createTray()
  createLauncherWindow()
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (!tray && !ipc.hasRunningSessions()) {
    app.quit()
  }
})
