/**
 * Type declarations for the renderer process.
 *
 * Since renderer files currently load as raw <script> tags (no bundler),
 * this .d.ts file provides type information for `window.api` without
 * requiring any code changes. Once Proposal #1 (electron-vite) lands,
 * this can be replaced with proper TypeScript imports.
 */

import type {
  IpcInvokeChannels,
  IpcEventChannels,
} from "./shared/ipc-types";

/**
 * The `window.api` object exposed by preload.js via contextBridge.
 * Each method corresponds to an IPC channel defined in ipc-types.ts.
 */
interface ElectronApi {
  // Invoke channels (renderer → main, two-way)
  getSources(): Promise<IpcInvokeChannels["get-sources"]["return"]>;
  getFieldOptions(
    ...args: IpcInvokeChannels["get-field-options"]["args"]
  ): Promise<IpcInvokeChannels["get-field-options"]["return"]>;
  buildInstallation(
    ...args: IpcInvokeChannels["build-installation"]["args"]
  ): Promise<IpcInvokeChannels["build-installation"]["return"]>;
  getDefaultInstallDir(): Promise<IpcInvokeChannels["get-default-install-dir"]["return"]>;
  detectGPU(): Promise<IpcInvokeChannels["detect-gpu"]["return"]>;
  browseFolder(
    ...args: IpcInvokeChannels["browse-folder"]["args"]
  ): Promise<IpcInvokeChannels["browse-folder"]["return"]>;
  openPath(
    ...args: IpcInvokeChannels["open-path"]["args"]
  ): Promise<IpcInvokeChannels["open-path"]["return"]>;
  openExternal(
    ...args: IpcInvokeChannels["open-external"]["args"]
  ): Promise<IpcInvokeChannels["open-external"]["return"]>;
  getLocaleMessages(): Promise<IpcInvokeChannels["get-locale-messages"]["return"]>;
  getAvailableLocales(): Promise<IpcInvokeChannels["get-available-locales"]["return"]>;
  getInstallations(): Promise<IpcInvokeChannels["get-installations"]["return"]>;
  addInstallation(
    ...args: IpcInvokeChannels["add-installation"]["args"]
  ): Promise<IpcInvokeChannels["add-installation"]["return"]>;
  reorderInstallations(
    ...args: IpcInvokeChannels["reorder-installations"]["args"]
  ): Promise<IpcInvokeChannels["reorder-installations"]["return"]>;
  probeInstallation(
    ...args: IpcInvokeChannels["probe-installation"]["args"]
  ): Promise<IpcInvokeChannels["probe-installation"]["return"]>;
  trackInstallation(
    ...args: IpcInvokeChannels["track-installation"]["args"]
  ): Promise<IpcInvokeChannels["track-installation"]["return"]>;
  installInstance(
    ...args: IpcInvokeChannels["install-instance"]["args"]
  ): Promise<IpcInvokeChannels["install-instance"]["return"]>;
  stopComfyUI(
    ...args: IpcInvokeChannels["stop-comfyui"]["args"]
  ): Promise<IpcInvokeChannels["stop-comfyui"]["return"]>;
  focusComfyWindow(
    ...args: IpcInvokeChannels["focus-comfy-window"]["args"]
  ): Promise<IpcInvokeChannels["focus-comfy-window"]["return"]>;
  getRunningInstances(): Promise<IpcInvokeChannels["get-running-instances"]["return"]>;
  cancelLaunch(): Promise<IpcInvokeChannels["cancel-launch"]["return"]>;
  cancelOperation(
    ...args: IpcInvokeChannels["cancel-operation"]["args"]
  ): Promise<IpcInvokeChannels["cancel-operation"]["return"]>;
  killPortProcess(
    ...args: IpcInvokeChannels["kill-port-process"]["args"]
  ): Promise<IpcInvokeChannels["kill-port-process"]["return"]>;
  getListActions(
    ...args: IpcInvokeChannels["get-list-actions"]["args"]
  ): Promise<IpcInvokeChannels["get-list-actions"]["return"]>;
  updateInstallation(
    ...args: IpcInvokeChannels["update-installation"]["args"]
  ): Promise<IpcInvokeChannels["update-installation"]["return"]>;
  getDetailSections(
    ...args: IpcInvokeChannels["get-detail-sections"]["args"]
  ): Promise<IpcInvokeChannels["get-detail-sections"]["return"]>;
  runAction(
    ...args: IpcInvokeChannels["run-action"]["args"]
  ): Promise<IpcInvokeChannels["run-action"]["return"]>;
  getSettingsSections(): Promise<IpcInvokeChannels["get-settings-sections"]["return"]>;
  getModelsSections(): Promise<IpcInvokeChannels["get-models-sections"]["return"]>;
  setSetting(
    ...args: IpcInvokeChannels["set-setting"]["args"]
  ): Promise<IpcInvokeChannels["set-setting"]["return"]>;
  getSetting(
    ...args: IpcInvokeChannels["get-setting"]["args"]
  ): Promise<IpcInvokeChannels["get-setting"]["return"]>;
  getResolvedTheme(): Promise<IpcInvokeChannels["get-resolved-theme"]["return"]>;
  quitApp(): Promise<IpcInvokeChannels["quit-app"]["return"]>;
  checkForUpdate(): Promise<IpcInvokeChannels["check-for-update"]["return"]>;
  downloadUpdate(): Promise<IpcInvokeChannels["download-update"]["return"]>;
  installUpdate(): Promise<IpcInvokeChannels["install-update"]["return"]>;
  getPendingUpdate(): Promise<IpcInvokeChannels["get-pending-update"]["return"]>;

  // Event channels (main → renderer, push)
  onInstallProgress(callback: (data: IpcEventChannels["install-progress"]) => void): () => void;
  onComfyOutput(callback: (data: IpcEventChannels["comfy-output"]) => void): () => void;
  onComfyExited(callback: (data: IpcEventChannels["comfy-exited"]) => void): () => void;
  onInstanceStarted(callback: (data: IpcEventChannels["instance-started"]) => void): () => void;
  onInstanceStopped(callback: (data: IpcEventChannels["instance-stopped"]) => void): () => void;
  onThemeChanged(callback: (data: IpcEventChannels["theme-changed"]) => void): () => void;
  onLocaleChanged(callback: (data: IpcEventChannels["locale-changed"]) => void): () => void;
  onConfirmQuit(callback: () => void): () => void;
  onUpdateAvailable(callback: (data: IpcEventChannels["update-available"]) => void): () => void;
  onUpdateDownloadProgress(
    callback: (data: IpcEventChannels["update-download-progress"]) => void
  ): () => void;
  onUpdateDownloaded(callback: (data: IpcEventChannels["update-downloaded"]) => void): () => void;
  onUpdateError(callback: (data: IpcEventChannels["update-error"]) => void): () => void;
}

declare global {
  interface Window {
    api: ElectronApi;
  }
}
