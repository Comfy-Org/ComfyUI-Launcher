import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

export interface ComfyDownloadProgress {
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

contextBridge.exposeInMainWorld('__comfyLauncher', {
  downloadModel: (url: string, filename: string, directory: string): Promise<boolean> => {
    return ipcRenderer.invoke('launcher-download-model', { url, filename, directory })
  },
  pauseDownload: (url: string): Promise<boolean> => {
    return ipcRenderer.invoke('model-download-pause', { url })
  },
  resumeDownload: (url: string): Promise<boolean> => {
    return ipcRenderer.invoke('model-download-resume', { url })
  },
  cancelDownload: (url: string): Promise<boolean> => {
    return ipcRenderer.invoke('model-download-cancel', { url })
  },
  onDownloadProgress: (
    callback: (data: ComfyDownloadProgress) => void
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) =>
      callback(data as ComfyDownloadProgress)
    ipcRenderer.on('launcher-download-progress', handler)
    return () => ipcRenderer.removeListener('launcher-download-progress', handler)
  },
})
