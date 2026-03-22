import { app, BrowserWindow, Tray, Menu, ipcMain, shell, clipboard, screen } from 'electron'
import path from 'path'
import fs from 'fs'
import { execFile } from 'child_process'
import type { ChildProcess } from 'child_process'
import todesktop from '@todesktop/runtime'
import * as ipc from './lib/ipc'
import { getAppVersion } from './lib/ipc'
import * as updater from './lib/updater'
import * as settings from './settings'
import * as i18n from './lib/i18n'
import { configDir, migrateXdgPaths } from './lib/paths'
import { waitForPort, COMFY_BOOT_TIMEOUT_MS } from './lib/process'
import { isQuitInProgress, setQuitReason } from './lib/quit-state'
import type { InstallationRecord } from './installations'
import type { DatadogForwardedError } from '../types/ipc'
import {
  attachSessionDownloadHandler,
  cleanupTempDownloads,
  detachWindowDownloads,
  registerDownloadIpc,
  setMainWindow,
} from './lib/comfyDownloadManager'
import { getModelDownloadContentScript } from './lib/comfyContentScript'
import { shouldOpenInPopup } from './lib/allowedPopups'

todesktop.init({ autoUpdater: false })

const APP_ICON = path.join(__dirname, '..', '..', 'assets', 'Comfy_Logo_x256.png')
const TRAY_ICON = path.join(__dirname, '..', '..', 'assets', 'Comfy_Logo_x32.png')
const APP_VERSION = getAppVersion()

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

async function flushWindowState(): Promise<void> {
  if (!windowStateCache) return
  try {
    await fs.promises.mkdir(path.dirname(windowStatePath), { recursive: true })
    await fs.promises.writeFile(windowStatePath, JSON.stringify(windowStateCache, null, 2))
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

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
const comfyWindows = new Map<string, BrowserWindow>()

function focusExternalProcessWindow(pid: number): void {
  if (process.platform === 'win32') {
    // AppActivate accepts a numeric PID to bring the process window to the foreground.
    // wscript is near-instant compared to PowerShell.
    const vbsPath = path.join(app.getPath('temp'), `comfy-focus-${pid}.vbs`)
    fs.writeFileSync(vbsPath, `CreateObject("WScript.Shell").AppActivate ${pid}`)
    execFile('wscript.exe', ['//Nologo', '//B', vbsPath], { windowsHide: true }, () => {
      fs.unlink(vbsPath, () => {})
    })
  } else if (process.platform === 'darwin') {
    execFile('osascript', ['-e',
      `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
    ], () => {})
  }
}
let processErrorHandlersRegistered = false

function serializeUnknownError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || 'Error',
      stack: error.stack,
    }
  }
  if (typeof error === 'string') {
    return { message: error }
  }
  if (error === null || error === undefined) {
    return { message: 'Unknown error' }
  }
  try {
    return { message: JSON.stringify(error) }
  } catch {
    return { message: String(error) }
  }
}

function forwardDatadogError(payload: DatadogForwardedError): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.webContents.send('dd-error', payload)
  } catch {}
}

function registerProcessErrorHandlers(): void {
  if (processErrorHandlersRegistered) return
  processErrorHandlersRegistered = true

  process.on('uncaughtExceptionMonitor', (error) => {
    const serialized = serializeUnknownError(error)
    forwardDatadogError({
      source: 'main-uncaught-exception',
      message: serialized.message,
      stack: serialized.stack,
      level: 'critical',
      context: { origin: 'main-process' },
    })
  })

  process.on('unhandledRejection', (reason) => {
    const serialized = serializeUnknownError(reason)
    forwardDatadogError({
      source: 'main-unhandled-rejection',
      message: serialized.message,
      stack: serialized.stack,
      level: 'error',
      context: { origin: 'main-process' },
    })
  })

  app.on('child-process-gone', (_event, details) => {
    const extra = details as unknown as Record<string, unknown>
    forwardDatadogError({
      source: 'main-child-process-gone',
      message: `Child process ${details.type} exited: ${details.reason}`,
      level: 'error',
      context: {
        origin: 'main-process',
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        name: extra['name'],
        serviceName: extra['serviceName'],
      },
    })
  })
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1470,
    height: 880,
    minWidth: 650,
    minHeight: 500,
    icon: APP_ICON,
    title: `ComfyUI Desktop 2.0 v${APP_VERSION}`,
    backgroundColor: '#202020',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  })
  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  const loadTarget = process.env['ELECTRON_RENDERER_URL'] || 'index.html (file)'

  if (isDev) {
    console.log(`[main] dev mode — loading renderer from ${loadTarget}`)
    console.log(`[main] platform=${process.platform} electron=${process.versions.electron} chrome=${process.versions.chrome}`)
  }

  mainWindow.once('ready-to-show', () => {
    if (isDev) console.log('[main] ready-to-show fired')
    mainWindow?.show()
    if (process.platform === 'win32') mainWindow?.moveTop()
    mainWindow?.focus()
    createTray()
  })

  attachContextMenu(mainWindow)
  mainWindow.setMenuBarVisibility(false)
  mainWindow.webContents.on('did-finish-load', () => {
    if (isDev) console.log(`[main] did-finish-load — url=${mainWindow?.webContents.getURL()}`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setZoomLevel(0)
    }
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, description, failUrl, isMainFrame) => {
    if (!isMainFrame) return
    console.error(`[main] did-fail-load: code=${code} desc="${description}" url=${failUrl}`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    forwardDatadogError({
      source: 'main-render-process-gone',
      message: `Main renderer process exited (${details.reason})`,
      level: 'critical',
      context: {
        origin: 'main-process',
        reason: details.reason,
        exitCode: details.exitCode,
      },
    })
  })

  function notifyZoomLevel(): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const level = mainWindow.webContents.getZoomLevel()
      mainWindow.webContents.send('zoom-changed', level)
    }
  }

  // Pinch-to-zoom
  mainWindow.webContents.on('zoom-changed', () => notifyZoomLevel())

  // Keyboard zoom (Ctrl/Cmd + =/-/0)
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    const mod = input.control || input.meta
    if (mod && (input.key === '=' || input.key === '+' || input.key === '-' || input.key === '0')) {
      setTimeout(notifyZoomLevel, 50)
    }
  })

  setMainWindow(mainWindow)

  mainWindow.on('closed', () => {
    mainWindow = null
    setMainWindow(null)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('close', (e) => {
    if (isQuitInProgress()) return

    const onClose = (settings.get('onAppClose') as string | undefined) || 'tray'
    if (onClose === 'tray') {
      e.preventDefault()
      mainWindow!.hide()
      createTray()
      return
    }
    if (ipc.hasActiveOperations()) {
      e.preventDefault()
      ipc.getActiveDetails()
        .catch(() => [] as Awaited<ReturnType<typeof ipc.getActiveDetails>>)
        .then((details) => {
          if (mainWindow!.isDestroyed()) return
          if (details.length === 0) { quitApp(); return }
          mainWindow!.webContents.send('confirm-quit', details)
        })
      return
    }
    quitApp()
  })
}

function updateTrayMenu(): void {
  if (!tray) return
  const contextMenu = Menu.buildFromTemplate([
    { label: i18n.t('tray.showApp'), click: () => showMainWindow() },
    { type: 'separator' },
    { label: i18n.t('tray.quit'), click: () => quitApp() },
  ])
  tray.setContextMenu(contextMenu)
}

function createTray(): void {
  if (tray) return

  tray = new Tray(TRAY_ICON)
  tray.setToolTip('ComfyUI Desktop 2.0')
  updateTrayMenu()
  tray.on('double-click', () => showMainWindow())
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }
}

function quitApp(): void {
  setQuitReason('user-quit')
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

  waitForPort(port, '127.0.0.1', { timeoutMs: COMFY_BOOT_TIMEOUT_MS })
    .then(() => {
      if (!win.isDestroyed()) {
        win.webContents.stop()
        win.loadURL(currentUrl)
      }
    })
    .catch((err) => {
      console.error(`ComfyUI restart failed for ${installationId}:`, err)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('comfy-output', {
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

  if (mode === 'console' || mode === 'external') {
    return
  }

  const saved = getSavedBounds(installationId)
  const windowOptions = getWindowOptions(installationId)
  const comfyWindow = new BrowserWindow({
    ...windowOptions,
    minWidth: 800,
    minHeight: 600,
    icon: APP_ICON,
    title: `${installation.name} — Desktop 2.0 v${APP_VERSION}`,
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
    comfyWindow.setTitle(`${title} — ${installation.name} — Desktop 2.0 v${APP_VERSION}`)
  })
  comfyWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenInPopup(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { preload: undefined } } }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Download management: attach session handler and inject content script
  const isLocal = !url
  attachSessionDownloadHandler(comfyWindow.webContents.session)
  comfyWindow.webContents.on('dom-ready', () => {
    const preamble = isLocal ? '' : 'window.__comfyDesktop2Remote = true;\n'
    comfyWindow.webContents
      .executeJavaScript(preamble + getModelDownloadContentScript())
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

  comfyWindow.webContents.on('render-process-gone', (_event, details) => {
    forwardDatadogError({
      source: 'comfy-window-render-process-gone',
      message: `Comfy window renderer process exited (${details.reason})`,
      level: 'error',
      context: {
        origin: 'main-process',
        installationId,
        reason: details.reason,
        exitCode: details.exitCode,
      },
    })
    reloadComfy()
  })

  comfyWindow.on('close', (e) => {
    e.preventDefault()
    detachWindowDownloads(comfyWindow)
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomLevel(0)
  }
})

ipcMain.handle('focus-comfy-window', (_event, installationId: string) => {
  const win = comfyWindows.get(installationId)
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return true
  }

  // For external processes (e.g. Desktop), bring the child process window to front
  const proc = ipc.getSessionProcess(installationId)
  if (proc?.pid) {
    focusExternalProcessWindow(proc.pid)
    return true
  }

  return false
})

if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  if (app.isPackaged) {
    app.on('second-instance', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        if (mainWindow.isMinimized()) mainWindow.restore()
        if (process.platform === 'win32') mainWindow.moveTop()
        mainWindow.focus()
      }
    })
  }

  app.whenReady().then(() => {
    migrateXdgPaths()
    registerProcessErrorHandlers()

    const locale = (settings.get('language') as string | undefined) || app.getLocale().split('-')[0]
    i18n.init(locale)
    registerDownloadIpc()
    cleanupTempDownloads()
    ipc.register({ onLaunch, onStop, onComfyExited, onComfyRestarted, onLocaleChanged: updateTrayMenu })
    updater.register()
    createMainWindow()
  })

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on('before-quit', () => {
    if (!isQuitInProgress()) setQuitReason('user-quit')
    cleanupTempDownloads()
  })

  app.on('window-all-closed', () => {
    if (!tray && !ipc.hasRunningSessions()) {
      app.quit()
    }
  })
}
