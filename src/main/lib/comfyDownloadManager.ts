import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import * as settings from '../settings'

export const ALLOWED_EXTENSIONS = ['.safetensors', '.sft', '.ckpt', '.pth', '.pt']

export interface DownloadProgress {
  url: string
  filename: string
  directory?: string
  savePath?: string
  progress: number
  receivedBytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSeconds?: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
}

interface PendingDownload {
  url: string
  filename: string
  directory: string
  savePath: string
  tempPath?: string
  window: BrowserWindow
  subscriberWindows: Set<BrowserWindow>
  item?: Electron.DownloadItem
  lastProgress: DownloadProgress
  lastSpeedBytes: number
  lastSpeedTime: number
}

const attachedSessions = new WeakSet<Electron.Session>()
const pendingDownloads = new Map<string, PendingDownload>()
let launcherWindow: BrowserWindow | null = null

export function setLauncherWindow(win: BrowserWindow | null): void {
  launcherWindow = win
}

function getModelsBaseDir(): string {
  const modelsDirs = settings.get('modelsDirs') as string[] | undefined
  return modelsDirs?.[0] || settings.defaults.modelsDirs[0]!
}

const TEMP_DIR_NAME = '.launcher-downloads'

function getTempDir(): string {
  return path.join(getModelsBaseDir(), TEMP_DIR_NAME)
}

export function isPathContained(filePath: string, baseDir: string): boolean {
  const resolved = path.resolve(filePath)
  const resolvedBase = path.resolve(baseDir)
  return resolved.startsWith(resolvedBase + path.sep)
}

export function hasValidExtension(filename: string): boolean {
  const lower = filename.toLowerCase()
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function stripQueryParams(rawFilename: string): string {
  const qIdx = rawFilename.indexOf('?')
  return qIdx >= 0 ? rawFilename.substring(0, qIdx) : rawFilename
}

function broadcastProgress(progress: DownloadProgress): void {
  // Send to the originating ComfyUI window and any subscribers
  const pending = pendingDownloads.get(progress.url)
  if (pending) {
    pending.lastProgress = progress
    if (!pending.window.isDestroyed()) {
      pending.window.webContents.send('launcher-download-progress', progress)
    }
    for (const sub of pending.subscriberWindows) {
      if (!sub.isDestroyed()) {
        sub.webContents.send('launcher-download-progress', progress)
      } else {
        pending.subscriberWindows.delete(sub)
      }
    }
  }
  // Also send to the Launcher window
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.webContents.send('model-download-progress', progress)
  }
}

function setTaskbarProgress(win: BrowserWindow, progress: DownloadProgress): void {
  if (win.isDestroyed()) return
  if (progress.status === 'downloading') {
    win.setProgressBar(progress.progress)
  } else if (
    progress.status === 'completed' ||
    progress.status === 'error' ||
    progress.status === 'cancelled'
  ) {
    win.setProgressBar(-1)
  }
}

function reportProgress(progress: DownloadProgress): void {
  broadcastProgress(progress)
  const pending = pendingDownloads.get(progress.url)
  if (pending) setTaskbarProgress(pending.window, progress)
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath)
    return true
  } catch {
    return false
  }
}

function findPendingForItem(item: Electron.DownloadItem): PendingDownload | undefined {
  const candidates = [...item.getURLChain(), item.getURL()].filter(Boolean)
  for (const u of candidates) {
    const pending = pendingDownloads.get(u)
    // Only match entries waiting for their DownloadItem (managed model downloads).
    // Entries that already have an item are active general downloads — don't hijack them.
    if (pending && !pending.item) return pending
  }
  return undefined
}

export async function startModelDownload(
  win: BrowserWindow,
  url: string,
  rawFilename: string,
  directory: string,
): Promise<boolean> {
  const filename = stripQueryParams(rawFilename)
  const baseDir = getModelsBaseDir()
  const savePath = path.join(baseDir, directory, filename)
  const tempDir = getTempDir()
  const tempPath = path.join(tempDir, `${Date.now()}-${filename}.tmp`)

  const makeProgress = (
    overrides: Partial<DownloadProgress>,
  ): DownloadProgress => ({
    url,
    filename,
    directory,
    progress: 0,
    status: 'pending',
    ...overrides,
  })

  if (!isPathContained(savePath, baseDir)) {
    reportProgress(makeProgress({ status: 'error', error: 'Save path is outside models directory' }))
    return false
  }

  if (!hasValidExtension(filename)) {
    reportProgress(makeProgress({
      status: 'error',
      error: `Invalid file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
    }))
    return false
  }

  if (await fileExists(savePath)) {
    // File already exists — report completed without starting a download
    const progress = makeProgress({ progress: 1, status: 'completed', savePath })
    broadcastProgress(progress)
    return true
  }

  const existing = pendingDownloads.get(url)
  if (existing) {
    if (win !== existing.window) {
      existing.subscriberWindows.add(win)
    }
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-download-progress', existing.lastProgress)
    }
    return true
  }

  await fs.promises.mkdir(path.dirname(savePath), { recursive: true })
  await fs.promises.mkdir(tempDir, { recursive: true })

  if (win.isDestroyed()) return false

  const initial = makeProgress({ status: 'pending' })
  pendingDownloads.set(url, {
    url,
    filename,
    directory,
    savePath,
    tempPath,
    window: win,
    subscriberWindows: new Set(),
    lastProgress: initial,
    lastSpeedBytes: 0,
    lastSpeedTime: Date.now(),
  })

  const sess = win.webContents.session
  attachSessionDownloadHandler(sess)
  sess.downloadURL(url)

  reportProgress(initial)
  return true
}

function attachDownloadListeners(item: Electron.DownloadItem, pending: PendingDownload): void {
  item.on('updated', (_ev, state) => {
    if (state !== 'progressing') return
    const total = item.getTotalBytes()
    const received = item.getReceivedBytes()
    const progress = total > 0 ? received / total : 0

    const now = Date.now()
    const elapsed = (now - pending.lastSpeedTime) / 1000
    let speed: number | undefined
    let eta: number | undefined
    if (elapsed >= 0.5) {
      const delta = received - pending.lastSpeedBytes
      speed = delta / elapsed
      pending.lastSpeedBytes = received
      pending.lastSpeedTime = now
      if (speed > 0 && total > 0) {
        eta = (total - received) / speed
      }
    } else {
      speed = pending.lastProgress.speedBytesPerSec
      eta = pending.lastProgress.etaSeconds
    }

    reportProgress({
      url: pending.url,
      filename: pending.filename,
      directory: pending.directory,
      progress,
      receivedBytes: received,
      totalBytes: total,
      speedBytesPerSec: speed,
      etaSeconds: eta,
      status: item.isPaused() ? 'paused' : 'downloading',
    })
  })

  item.once('done', (_ev, state) => {
    if (state === 'completed') {
      // Model downloads use a temp file that needs to be moved to the final path
      if (pending.tempPath) {
        try {
          fs.renameSync(pending.tempPath, pending.savePath)
        } catch {
          try { fs.unlinkSync(pending.tempPath) } catch {}
          if (!fs.existsSync(pending.savePath)) {
            reportProgress({
              url: pending.url,
              filename: pending.filename,
              directory: pending.directory,
              progress: 0,
              status: 'error',
              error: 'Failed to move downloaded file to final location',
            })
            pendingDownloads.delete(pending.url)
            return
          }
        }
      }
      reportProgress({
        url: pending.url,
        filename: pending.filename,
        directory: pending.directory,
        savePath: pending.savePath,
        progress: 1,
        status: 'completed',
      })
    } else if (state === 'cancelled') {
      if (pending.tempPath) { try { fs.unlinkSync(pending.tempPath) } catch {} }
      reportProgress({
        url: pending.url,
        filename: pending.filename,
        directory: pending.directory,
        progress: 0,
        status: 'cancelled',
      })
    } else {
      if (pending.tempPath) { try { fs.unlinkSync(pending.tempPath) } catch {} }
      reportProgress({
        url: pending.url,
        filename: pending.filename,
        directory: pending.directory,
        progress: 0,
        status: 'error',
        error: `Download failed: ${state}`,
      })
    }
    pendingDownloads.delete(pending.url)
  })
}

export function attachSessionDownloadHandler(sess: Electron.Session): void {
  if (attachedSessions.has(sess)) return
  attachedSessions.add(sess)

  sess.on('will-download', (_event, item, webContents) => {
    const pending = findPendingForItem(item)

    if (pending) {
      // Managed model download — auto-save to the resolved path
      pending.item = item
      item.setSavePath(pending.tempPath!)
      attachDownloadListeners(item, pending)
    } else {
      // General download — browser-like save dialog
      const suggestedName = item.getFilename()
      const downloadsDir = app.getPath('downloads')
      const win = BrowserWindow.fromWebContents(webContents)

      let savePath: string | undefined
      if (win) {
        const filePath = dialog.showSaveDialogSync(win, {
          defaultPath: path.join(downloadsDir, suggestedName),
        })
        if (filePath) {
          savePath = filePath
        } else {
          item.cancel()
          return
        }
      } else {
        // setSavePath must be synchronous within will-download
        let candidate = path.join(downloadsDir, suggestedName)
        let i = 1
        while (fs.existsSync(candidate)) {
          const ext = path.extname(suggestedName)
          const base = path.basename(suggestedName, ext)
          candidate = path.join(downloadsDir, `${base} (${i})${ext}`)
          i++
        }
        savePath = candidate
      }

      item.setSavePath(savePath)

      const url = item.getURL()
      const filename = path.basename(savePath)
      const fallbackWindow = win || launcherWindow || BrowserWindow.getAllWindows()[0]
      const general: PendingDownload = {
        url,
        filename,
        directory: '',
        savePath,
        window: fallbackWindow!,
        subscriberWindows: new Set(),
        item,
        lastProgress: { url, filename, progress: 0, status: 'pending' },
        lastSpeedBytes: 0,
        lastSpeedTime: Date.now(),
      }
      pendingDownloads.set(url, general)
      reportProgress(general.lastProgress)
      attachDownloadListeners(item, general)
    }
  })
}

// ---- Pause / Resume / Cancel ----

export function pauseModelDownload(url: string): boolean {
  const pending = pendingDownloads.get(url)
  if (!pending) return false
  if (pending.item && !pending.item.isPaused()) {
    pending.item.pause()
    reportProgress({
      ...pending.lastProgress,
      status: 'paused',
    })
  }
  return true
}

export function resumeModelDownload(url: string): boolean {
  const pending = pendingDownloads.get(url)
  if (!pending) return false
  if (pending.item && pending.item.isPaused()) {
    pending.item.resume()
    reportProgress({
      ...pending.lastProgress,
      status: 'downloading',
    })
  }
  return true
}

export function cancelModelDownload(url: string): boolean {
  const pending = pendingDownloads.get(url)
  if (!pending) return false
  if (pending.item) {
    pending.item.cancel()
  } else {
    // Download hasn't reached will-download yet — clean up immediately
    pendingDownloads.delete(url)
    reportProgress({
      url,
      filename: pending.filename,
      directory: pending.directory,
      progress: 0,
      status: 'cancelled',
    })
  }
  return true
}

// ---- Snapshot for seeding Launcher UI ----

export function getActiveDownloads(): DownloadProgress[] {
  const result: DownloadProgress[] = []
  for (const pending of pendingDownloads.values()) {
    result.push(pending.lastProgress)
  }
  return result
}

// ---- Window closed: detach downloads so they continue in the background ----

export function detachWindowDownloads(win: BrowserWindow): void {
  for (const pending of pendingDownloads.values()) {
    if (pending.window === win) {
      // Clear the taskbar progress on the closing window
      if (!win.isDestroyed()) win.setProgressBar(-1)
      // Downloads continue — the Launcher window still receives progress via broadcastProgress
    }
  }
}

// ---- Temp file cleanup ----

/** Remove the temp download directory and all its contents. */
export async function cleanupTempDownloads(): Promise<void> {
  try {
    await fs.promises.rm(getTempDir(), { recursive: true, force: true })
  } catch {}
}

// ---- IPC registration ----

export function registerDownloadIpc(): void {
  ipcMain.handle(
    'launcher-download-model',
    (event, { url, filename, directory }: { url: string; filename: string; directory: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return false
      return startModelDownload(win, url, filename, directory)
    },
  )

  ipcMain.handle('model-download-pause', (_event, { url }: { url: string }) =>
    pauseModelDownload(url),
  )

  ipcMain.handle('model-download-resume', (_event, { url }: { url: string }) =>
    resumeModelDownload(url),
  )

  ipcMain.handle('model-download-cancel', (_event, { url }: { url: string }) =>
    cancelModelDownload(url),
  )

  ipcMain.handle('model-download-list', () => getActiveDownloads())

  ipcMain.handle('show-download-in-folder', (_event, { savePath }: { savePath: string }) => {
    if (typeof savePath === 'string' && savePath) {
      shell.showItemInFolder(path.resolve(savePath))
    }
  })
}
