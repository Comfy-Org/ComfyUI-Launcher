import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ElectronApi, ResolvedTheme } from '../types/ipc'

const api: ElectronApi = {
  // Sources / New Install
  getSources: () => ipcRenderer.invoke('get-sources'),
  getFieldOptions: (sourceId, fieldId, selections) =>
    ipcRenderer.invoke('get-field-options', sourceId, fieldId, selections),
  buildInstallation: (sourceId, selections) =>
    ipcRenderer.invoke('build-installation', sourceId, selections),
  getDefaultInstallDir: () => ipcRenderer.invoke('get-default-install-dir'),
  detectGPU: () => ipcRenderer.invoke('detect-gpu'),
  validateHardware: () => ipcRenderer.invoke('validate-hardware'),
  checkNvidiaDriver: () => ipcRenderer.invoke('check-nvidia-driver'),

  // File/URL
  browseFolder: (defaultPath?) => ipcRenderer.invoke('browse-folder', defaultPath),
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getDiskSpace: (targetPath) => ipcRenderer.invoke('get-disk-space', targetPath),
  validateInstallPath: (targetPath) => ipcRenderer.invoke('validate-install-path', targetPath),

  // Locale
  getLocaleMessages: () => ipcRenderer.invoke('get-locale-messages'),
  getAvailableLocales: () => ipcRenderer.invoke('get-available-locales'),

  // Installations
  getInstallations: () => ipcRenderer.invoke('get-installations'),
  addInstallation: (data) => ipcRenderer.invoke('add-installation', data),
  reorderInstallations: (orderedIds) =>
    ipcRenderer.invoke('reorder-installations', orderedIds),
  probeInstallation: (dirPath) => ipcRenderer.invoke('probe-installation', dirPath),
  trackInstallation: (data) => ipcRenderer.invoke('track-installation', data),
  installInstance: (installationId) =>
    ipcRenderer.invoke('install-instance', installationId),
  updateInstallation: (installationId, data) =>
    ipcRenderer.invoke('update-installation', installationId, data),

  // Running
  stopComfyUI: (installationId) => ipcRenderer.invoke('stop-comfyui', installationId),
  focusComfyWindow: (installationId) =>
    ipcRenderer.invoke('focus-comfy-window', installationId),
  getRunningInstances: () => ipcRenderer.invoke('get-running-instances'),
  cancelLaunch: () => ipcRenderer.invoke('cancel-launch'),
  cancelOperation: (installationId) =>
    ipcRenderer.invoke('cancel-operation', installationId),
  killPortProcess: (port) => ipcRenderer.invoke('kill-port-process', port),

  // Actions
  getListActions: (installationId) =>
    ipcRenderer.invoke('get-list-actions', installationId),
  getDetailSections: (installationId) =>
    ipcRenderer.invoke('get-detail-sections', installationId),
  runAction: (installationId, actionId, actionData?) =>
    ipcRenderer.invoke('run-action', installationId, actionId, actionData),

  // Settings
  getSettingsSections: () => ipcRenderer.invoke('get-settings-sections'),
  getModelsSections: () => ipcRenderer.invoke('get-models-sections'),
  getUniqueName: (baseName: string) => ipcRenderer.invoke('get-unique-name', baseName),
  getMediaSections: () => ipcRenderer.invoke('get-media-sections'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),

  // Theme
  getResolvedTheme: () => ipcRenderer.invoke('get-resolved-theme'),

  // App
  quitApp: () => ipcRenderer.invoke('quit-app'),

  // Updates
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getPendingUpdate: () => ipcRenderer.invoke('get-pending-update'),

  // Event listeners (return unsubscribe functions)
  onInstallProgress: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('install-progress', handler)
    return () => ipcRenderer.removeListener('install-progress', handler)
  },
  onComfyOutput: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('comfy-output', handler)
    return () => ipcRenderer.removeListener('comfy-output', handler)
  },
  onComfyExited: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('comfy-exited', handler)
    return () => ipcRenderer.removeListener('comfy-exited', handler)
  },
  onInstanceStarted: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('instance-started', handler)
    return () => ipcRenderer.removeListener('instance-started', handler)
  },
  onInstanceStopped: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('instance-stopped', handler)
    return () => ipcRenderer.removeListener('instance-stopped', handler)
  },
  onThemeChanged: (callback) => {
    const handler = (_event: IpcRendererEvent, theme: unknown) => callback(theme as ResolvedTheme)
    ipcRenderer.on('theme-changed', handler)
    return () => ipcRenderer.removeListener('theme-changed', handler)
  },
  onLocaleChanged: (callback) => {
    const handler = (_event: IpcRendererEvent, messages: unknown) => callback(messages as Record<string, unknown>)
    ipcRenderer.on('locale-changed', handler)
    return () => ipcRenderer.removeListener('locale-changed', handler)
  },
  onConfirmQuit: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('confirm-quit', handler)
    return () => ipcRenderer.removeListener('confirm-quit', handler)
  },
  onInstallationsChanged: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('installations-changed', handler)
    return () => ipcRenderer.removeListener('installations-changed', handler)
  },
  onUpdateAvailable: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('update-available', handler)
    return () => ipcRenderer.removeListener('update-available', handler)
  },
  onUpdateDownloadProgress: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('update-download-progress', handler)
    return () => ipcRenderer.removeListener('update-download-progress', handler)
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('update-downloaded', handler)
    return () => ipcRenderer.removeListener('update-downloaded', handler)
  },
  onUpdateError: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('update-error', handler)
    return () => ipcRenderer.removeListener('update-error', handler)
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  (globalThis as Record<string, unknown>).api = api
}
