import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import fs from 'fs'
import path from 'path'
import * as settings from '../settings'

const ALLOWED_EXTENSIONS = ['.safetensors', '.sft', '.ckpt', '.pth', '.pt']

export interface DownloadProgress {
  url: string
  filename: string
  directory?: string
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
  tempPath: string
  window: BrowserWindow
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

function isPathContained(filePath: string, baseDir: string): boolean {
  const resolved = path.resolve(filePath)
  const resolvedBase = path.resolve(baseDir)
  return resolved.startsWith(resolvedBase + path.sep)
}

function hasValidExtension(filename: string): boolean {
  const lower = filename.toLowerCase()
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function broadcastProgress(progress: DownloadProgress): void {
  // Send to the originating ComfyUI window
  const pending = pendingDownloads.get(progress.url)
  if (pending) {
    pending.lastProgress = progress
    if (!pending.window.isDestroyed()) {
      pending.window.webContents.send('launcher-download-progress', progress)
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

function getUniqueFilePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  let i = 1
  let candidate = filePath
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`)
    i++
  }
  return candidate
}

function findPendingForItem(item: Electron.DownloadItem): PendingDownload | undefined {
  const candidates = [...item.getURLChain(), item.getURL()].filter(Boolean)
  for (const u of candidates) {
    const pending = pendingDownloads.get(u)
    if (pending) return pending
  }
  return undefined
}

export function startModelDownload(
  win: BrowserWindow,
  url: string,
  rawFilename: string,
  directory: string,
): boolean {
  const qIdx = rawFilename.indexOf('?')
  const filename = qIdx >= 0 ? rawFilename.substring(0, qIdx) : rawFilename
  const baseDir = getModelsBaseDir()
  const savePath = path.join(baseDir, directory, filename)
  const tempPath = path.join(baseDir, directory, `Unconfirmed ${filename}.tmp`)

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

  if (fs.existsSync(savePath)) {
    // File already exists — report completed without starting a download
    const progress = makeProgress({ progress: 1, status: 'completed' })
    broadcastProgress(progress)
    return true
  }

  if (pendingDownloads.has(url)) return true

  fs.mkdirSync(path.dirname(savePath), { recursive: true })

  const initial = makeProgress({ status: 'pending' })
  pendingDownloads.set(url, {
    url,
    filename,
    directory,
    savePath,
    tempPath,
    window: win,
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

export function attachSessionDownloadHandler(sess: Electron.Session): void {
  if (attachedSessions.has(sess)) return
  attachedSessions.add(sess)

  sess.on('will-download', (_event, item, webContents) => {
    const pending = findPendingForItem(item)

    if (pending) {
      // Managed model download — auto-save to the resolved path
      pending.item = item
      item.setSavePath(pending.tempPath)

      item.on('updated', (_ev, state) => {
        if (state !== 'progressing') return
        const total = item.getTotalBytes()
        const received = item.getReceivedBytes()
        const progress = total > 0 ? received / total : 0

        // Compute speed and ETA
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
          try {
            fs.renameSync(pending.tempPath, pending.savePath)
          } catch {
            try { fs.unlinkSync(pending.tempPath) } catch {}
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
          reportProgress({
            url: pending.url,
            filename: pending.filename,
            directory: pending.directory,
            progress: 1,
            status: 'completed',
          })
          pendingDownloads.delete(pending.url)
          new Notification({ title: 'Download Complete', body: `${pending.directory}/${pending.filename}` }).show()
        } else if (state === 'cancelled') {
          try { fs.unlinkSync(pending.tempPath) } catch {}
          reportProgress({
            url: pending.url,
            filename: pending.filename,
            directory: pending.directory,
            progress: 0,
            status: 'cancelled',
          })
          pendingDownloads.delete(pending.url)
        } else {
          try { fs.unlinkSync(pending.tempPath) } catch {}
          reportProgress({
            url: pending.url,
            filename: pending.filename,
            directory: pending.directory,
            progress: 0,
            status: 'error',
            error: `Download failed: ${state}`,
          })
          pendingDownloads.delete(pending.url)
          new Notification({ title: 'Download Failed', body: `${pending.filename}: ${state}` }).show()
        }
      })
    } else {
      // General download — browser-like save dialog
      const suggestedName = item.getFilename()
      const downloadsDir = app.getPath('downloads')
      const win = BrowserWindow.fromWebContents(webContents)

      if (win) {
        const filePath = dialog.showSaveDialogSync(win, {
          defaultPath: path.join(downloadsDir, suggestedName),
        })
        if (filePath) {
          item.setSavePath(filePath)
        } else {
          item.cancel()
        }
      } else {
        item.setSavePath(getUniqueFilePath(path.join(downloadsDir, suggestedName)))
      }
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

// ---- Cleanup ----

export function cleanupWindowDownloads(win: BrowserWindow): void {
  for (const [url, pending] of pendingDownloads) {
    if (pending.window === win) {
      if (pending.item) pending.item.cancel()
      pendingDownloads.delete(url)
    }
  }
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
}
