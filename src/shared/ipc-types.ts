/**
 * Typed IPC channel definitions for ComfyUI Launcher.
 *
 * This file is the single source of truth for all IPC channel signatures.
 * Both main-process handlers and renderer-side callers reference these types.
 *
 * Convention: add new channels here FIRST, then implement the handler and caller.
 * The compiler will enforce that signatures match on both sides.
 *
 * This is a representative subset — expand as files are converted to TypeScript.
 */

// ---------------------------------------------------------------------------
// Domain types (used by IPC channels)
// ---------------------------------------------------------------------------

/** GPU detection result from lib/gpu.js */
export interface GPUInfo {
  id: string;
  name: string;
  vendor: string;
}

/** A single source (install method) as exposed to the renderer */
export interface SourceInfo {
  id: string;
  label: string;
  fields: SourceField[];
  skipInstall: boolean;
  hideInstallPath: boolean;
}

export interface SourceField {
  id: string;
  label: string;
  type: "select" | "text";
  defaultValue?: string;
  action?: { label: string };
}

export interface FieldOption {
  value: string;
  label: string;
}

/** Persisted installation record */
export interface Installation {
  id: string;
  name: string;
  sourceId: string;
  installPath?: string;
  status?: "installed" | "failed" | "partial-delete";
  createdAt: string;
  seen?: boolean;
  launchMode?: "window" | "console";
  browserPartition?: string;
  useSharedPaths?: boolean;
  launchArgs?: string;
  portConflict?: "auto" | "ask";
  updateTrack?: string;
  updateInfoByTrack?: Record<string, unknown>;
  remoteUrl?: string;
  [key: string]: unknown;
}

/** Installation as returned to the renderer (with computed fields) */
export interface InstallationView extends Installation {
  sourceLabel: string;
  sourceCategory?: string;
  hasConsole: boolean;
  listPreview?: string;
  statusTag?: { label: string; style: string };
}

/** Result from add-installation / track-installation */
export interface AddInstallationResult {
  ok: boolean;
  message?: string;
  entry?: Installation;
}

/** Result from run-action */
export interface ActionResult {
  ok: boolean;
  message?: string;
  navigate?: string;
  portConflict?: {
    port: number;
    pids: number[];
    isComfy: boolean;
    nextPort: number | null;
  };
  mode?: "window" | "console";
  port?: number;
  url?: string;
}

/** Action descriptor (from getListActions / getDetailSections) */
export interface Action {
  id: string;
  label: string;
  style?: "primary" | "danger" | "default";
  enabled?: boolean;
  confirm?: { title: string; message: string };
  showProgress?: boolean;
  progressTitle?: string;
}

/** Detail/settings section */
export interface Section {
  title: string;
  fields?: SectionField[];
  actions?: Action[];
}

export interface SectionField {
  id?: string;
  label: string;
  value?: unknown;
  type?: "text" | "path" | "number" | "select" | "boolean" | "pathList";
  editable?: boolean;
  readonly?: boolean;
  options?: Array<{ value: string; label: string }>;
  openable?: boolean;
  min?: number;
  max?: number;
}

/** Probe result from scanning a directory */
export interface ProbeResult {
  sourceId: string;
  sourceLabel: string;
  name?: string;
  [key: string]: unknown;
}

/** Running ComfyUI session info */
export interface SessionInfo {
  installationId: string;
  port: number;
  url?: string;
  mode: "window" | "console";
  installationName: string;
  startedAt: number;
}

/** Update info */
export interface UpdateInfo {
  version: string;
  tag: string;
  url: string;
}

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
  error?: string;
}

/** Locale info */
export interface LocaleInfo {
  value: string;
  label: string;
}

/** Install progress event payload */
export interface InstallProgress {
  installationId: string;
  phase: string;
  percent?: number;
  status?: string;
  steps?: string[];
}

/** Comfy output event payload */
export interface ComfyOutput {
  installationId: string;
  text: string;
}

/** Comfy exited event payload */
export interface ComfyExited {
  installationId: string;
  crashed: boolean;
  exitCode: number | null;
  installationName: string;
}

/** Instance lifecycle event payload */
export interface InstanceEvent {
  installationId: string;
  port?: number;
  url?: string;
  mode?: string;
  installationName?: string;
}

/** Update download progress */
export interface UpdateDownloadProgress {
  percent: number;
  transferred: string;
  total: string;
}

/** Models data returned by get-models-sections */
export interface ModelsData {
  systemDefault: string;
  sections: Section[];
}

// ---------------------------------------------------------------------------
// IPC Channel Maps
// ---------------------------------------------------------------------------

/**
 * Invoke channels: renderer calls, main responds.
 * Key = channel name, args = tuple of arguments, return = resolved value.
 */
export interface IpcInvokeChannels {
  // Sources
  "get-sources": { args: []; return: SourceInfo[] };
  "get-field-options": {
    args: [sourceId: string, fieldId: string, selections: Record<string, string>];
    return: FieldOption[];
  };
  "detect-gpu": { args: []; return: GPUInfo | null };
  "build-installation": {
    args: [sourceId: string, selections: Record<string, string>];
    return: Record<string, unknown>;
  };

  // Paths
  "get-default-install-dir": { args: []; return: string };
  "browse-folder": { args: [defaultPath?: string]; return: string | null };
  "open-path": { args: [targetPath: string]; return: string };
  "open-external": { args: [url: string]; return: void };

  // Installations
  "get-installations": { args: []; return: InstallationView[] };
  "add-installation": { args: [data: Partial<Installation>]; return: AddInstallationResult };
  "reorder-installations": { args: [orderedIds: string[]]; return: void };
  "probe-installation": { args: [dirPath: string]; return: ProbeResult[] };
  "track-installation": { args: [data: Partial<Installation>]; return: AddInstallationResult };
  "install-instance": { args: [installationId: string]; return: ActionResult };
  "update-installation": {
    args: [installationId: string, data: Record<string, unknown>];
    return: void;
  };

  // Actions
  "get-list-actions": { args: [installationId: string]; return: Action[] };
  "get-detail-sections": { args: [installationId: string]; return: Section[] };
  "run-action": {
    args: [installationId: string, actionId: string, actionData?: Record<string, unknown>];
    return: ActionResult;
  };

  // Sessions
  "stop-comfyui": { args: [installationId?: string]; return: void };
  "focus-comfy-window": { args: [installationId: string]; return: boolean };
  "get-running-instances": { args: []; return: SessionInfo[] };
  "cancel-launch": { args: []; return: void };
  "cancel-operation": { args: [installationId: string]; return: void };
  "kill-port-process": { args: [port: number]; return: { ok: boolean } };

  // Settings
  "get-settings-sections": { args: []; return: Section[] };
  "get-models-sections": { args: []; return: ModelsData };
  "set-setting": { args: [key: string, value: unknown]; return: void };
  "get-setting": { args: [key: string]; return: unknown };
  "get-resolved-theme": { args: []; return: "dark" | "light" };

  // i18n
  "get-locale-messages": { args: []; return: Record<string, string> };
  "get-available-locales": { args: []; return: LocaleInfo[] };

  // App lifecycle
  "quit-app": { args: []; return: void };

  // Updates
  "check-for-update": { args: []; return: UpdateCheckResult };
  "download-update": { args: []; return: void };
  "install-update": { args: []; return: void };
  "get-pending-update": { args: []; return: UpdateInfo | null };
}

/**
 * Event channels: main pushes to renderer.
 * Key = channel name, value = payload type.
 */
export interface IpcEventChannels {
  "install-progress": InstallProgress;
  "comfy-output": ComfyOutput;
  "comfy-exited": ComfyExited;
  "instance-started": InstanceEvent;
  "instance-stopped": InstanceEvent;
  "theme-changed": "dark" | "light";
  "locale-changed": Record<string, string>;
  "confirm-quit": void;
  "update-available": UpdateInfo;
  "update-download-progress": UpdateDownloadProgress;
  "update-downloaded": UpdateInfo;
  "update-error": { message: string };
}

// ---------------------------------------------------------------------------
// Type-safe IPC helpers (used in preload and main process)
// ---------------------------------------------------------------------------

/**
 * Type-safe wrapper for ipcRenderer.invoke.
 * Usage in preload:
 *   const result = await typedInvoke(ipcRenderer, 'get-sources');
 *   // result is typed as SourceInfo[]
 */
export type TypedInvoke = <C extends keyof IpcInvokeChannels>(
  channel: C,
  ...args: IpcInvokeChannels[C]["args"]
) => Promise<IpcInvokeChannels[C]["return"]>;

/**
 * Type-safe wrapper for ipcMain.handle.
 * Usage in main:
 *   typedHandle(ipcMain, 'get-sources', async () => { ... });
 *   // handler return type must match SourceInfo[]
 */
export type TypedHandle = <C extends keyof IpcInvokeChannels>(
  channel: C,
  handler: (
    event: unknown,
    ...args: IpcInvokeChannels[C]["args"]
  ) => IpcInvokeChannels[C]["return"] | Promise<IpcInvokeChannels[C]["return"]>
) => void;

/**
 * Type-safe wrapper for webContents.send / ipcRenderer.on.
 */
export type TypedSend = <C extends keyof IpcEventChannels>(
  channel: C,
  ...args: IpcEventChannels[C] extends void ? [] : [data: IpcEventChannels[C]]
) => void;

export type TypedOn = <C extends keyof IpcEventChannels>(
  channel: C,
  callback: IpcEventChannels[C] extends void ? () => void : (data: IpcEventChannels[C]) => void
) => () => void;
