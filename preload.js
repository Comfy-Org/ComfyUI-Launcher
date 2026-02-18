const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSources: () => ipcRenderer.invoke("get-sources"),
  getFieldOptions: (sourceId, fieldId, selections) =>
    ipcRenderer.invoke("get-field-options", sourceId, fieldId, selections),
  buildInstallation: (sourceId, selections) =>
    ipcRenderer.invoke("build-installation", sourceId, selections),
  getDefaultInstallDir: () => ipcRenderer.invoke("get-default-install-dir"),
  detectGPU: () => ipcRenderer.invoke("detect-gpu"),
  browseFolder: (defaultPath) => ipcRenderer.invoke("browse-folder", defaultPath),
  openPath: (targetPath) => ipcRenderer.invoke("open-path", targetPath),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  getLocaleMessages: () => ipcRenderer.invoke("get-locale-messages"),
  getAvailableLocales: () => ipcRenderer.invoke("get-available-locales"),
  getInstallations: () => ipcRenderer.invoke("get-installations"),
  addInstallation: (data) => ipcRenderer.invoke("add-installation", data),
  reorderInstallations: (orderedIds) => ipcRenderer.invoke("reorder-installations", orderedIds),
  probeInstallation: (dirPath) => ipcRenderer.invoke("probe-installation", dirPath),
  trackInstallation: (data) => ipcRenderer.invoke("track-installation", data),
  installInstance: (installationId) =>
    ipcRenderer.invoke("install-instance", installationId),
  onInstallProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("install-progress", handler);
    return () => ipcRenderer.removeListener("install-progress", handler);
  },
  onComfyOutput: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("comfy-output", handler);
    return () => ipcRenderer.removeListener("comfy-output", handler);
  },
  onComfyExited: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("comfy-exited", handler);
    return () => ipcRenderer.removeListener("comfy-exited", handler);
  },
  stopComfyUI: (installationId) => ipcRenderer.invoke("stop-comfyui", installationId),
  focusComfyWindow: (installationId) => ipcRenderer.invoke("focus-comfy-window", installationId),
  getRunningInstances: () => ipcRenderer.invoke("get-running-instances"),
  onInstanceStarted: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("instance-started", handler);
    return () => ipcRenderer.removeListener("instance-started", handler);
  },
  onInstanceStopped: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("instance-stopped", handler);
    return () => ipcRenderer.removeListener("instance-stopped", handler);
  },
  cancelLaunch: () => ipcRenderer.invoke("cancel-launch"),
  killPortProcess: (port) => ipcRenderer.invoke("kill-port-process", port),
  getListActions: (installationId) =>
    ipcRenderer.invoke("get-list-actions", installationId),
  updateInstallation: (installationId, data) =>
    ipcRenderer.invoke("update-installation", installationId, data),
  getDetailSections: (installationId) =>
    ipcRenderer.invoke("get-detail-sections", installationId),
  runAction: (installationId, actionId, actionData) =>
    ipcRenderer.invoke("run-action", installationId, actionId, actionData),
  getSettingsSections: () => ipcRenderer.invoke("get-settings-sections"),
  getModelsSections: () => ipcRenderer.invoke("get-models-sections"),
  setSetting: (key, value) => ipcRenderer.invoke("set-setting", key, value),
  getSetting: (key) => ipcRenderer.invoke("get-setting", key),
  getResolvedTheme: () => ipcRenderer.invoke("get-resolved-theme"),
  onThemeChanged: (callback) => {
    const handler = (_event, theme) => callback(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => ipcRenderer.removeListener("theme-changed", handler);
  },
  quitApp: () => ipcRenderer.invoke("quit-app"),
  onConfirmQuit: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("confirm-quit", handler);
    return () => ipcRenderer.removeListener("confirm-quit", handler);
  },
  checkForUpdate: () => ipcRenderer.invoke("check-for-update"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  getPendingUpdate: () => ipcRenderer.invoke("get-pending-update"),
  onUpdateAvailable: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("update-available", handler);
    return () => ipcRenderer.removeListener("update-available", handler);
  },
  onUpdateDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("update-download-progress", handler);
    return () => ipcRenderer.removeListener("update-download-progress", handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("update-downloaded", handler);
    return () => ipcRenderer.removeListener("update-downloaded", handler);
  },
  onUpdateError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("update-error", handler);
    return () => ipcRenderer.removeListener("update-error", handler);
  },
});
