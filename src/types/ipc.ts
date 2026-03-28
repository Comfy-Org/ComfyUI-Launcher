// Canonical IPC types shared across main, preload, and renderer.
// This file is the single source of truth — do not duplicate these types elsewhere.

// Unsubscribe function returned by event listeners
export type Unsubscribe = () => void

// Theme identifiers
export type Theme = 'system' | 'dark' | 'light' | 'solarized' | 'nord' | 'arc' | 'github'
export type ResolvedTheme = Exclude<Theme, 'system'>

// --- Installation types ---
export interface Installation {
  id: string
  name: string
  sourceLabel: string
  sourceCategory: string
  version?: string
  statusTag?: { style: string; label: string }
  seen?: boolean
  listPreview?: string
  launchMode?: string
  launchArgs?: string
  hasConsole?: boolean
  installPath?: string
  status?: string
  lastLaunchedAt?: number
  [key: string]: unknown // allow extra fields from sources
}

export interface RunningInstance {
  installationId: string
  installationName: string
  port?: number
  url?: string
  mode: string
  startedAt?: number
}

// --- Source / New Install types ---
export interface Source {
  id: string
  label: string
  category?: string
  description?: string
  fields: SourceField[]
  hideInstallPath?: boolean
  skipInstall?: boolean
}

export interface SourceField {
  id: string
  label: string
  type: 'text' | 'select'
  defaultValue?: string
  action?: { label: string }
  errorTarget?: string
  renderAs?: 'cards'
}

export interface FieldOption {
  value: string
  label: string
  description?: string
  recommended?: boolean
  data?: Record<string, unknown>
}

// --- Detail types ---
export interface DetailSection {
  title?: string
  description?: string
  collapsed?: boolean
  pinBottom?: boolean
  tab?: string
  items?: DetailItem[]
  fields?: DetailField[]
  actions?: ActionDef[]
}

export interface DetailItem {
  label: string
  active?: boolean
  tag?: string
  actions?: ActionDef[]
}

export interface DetailFieldOption {
  value: string
  label: string
  description?: string
  recommended?: boolean
  data?: Record<string, unknown>
}

export interface ComfyArgDef {
  name: string
  flag: string
  help: string
  type: 'boolean' | 'value' | 'optional-value'
  metavar?: string
  choices?: string[]
  exclusiveGroup?: string
  category: string
}

export interface DetailField {
  id: string
  label: string
  value: string | boolean | number | Record<string, string> | null
  editable?: boolean
  editType?: 'select' | 'boolean' | 'text' | 'path' | 'channel-cards' | 'args-builder' | 'env-vars'
  options?: DetailFieldOption[]
  refreshSection?: boolean
  onChangeAction?: string
  tooltip?: string
}

export interface ActionDef {
  id: string
  label: string
  style?: 'primary' | 'danger'
  enabled?: boolean
  disabledMessage?: string
  tooltip?: string
  confirm?: ConfirmDef
  showProgress?: boolean
  progressTitle?: string
  cancellable?: boolean
  data?: Record<string, unknown>
  fieldSelects?: FieldSelectDef[]
  select?: SelectDef
  prompt?: PromptDef
}

export interface ConfirmDef {
  title?: string
  message?: string
  confirmLabel?: string
  options?: ConfirmOption[]
  messageDetails?: ModalDetailGroup[]
}

export interface ConfirmOption {
  id: string
  label: string
  checked?: boolean
}

export interface FieldSelectDef {
  sourceId: string
  fieldId: string
  field: string
  title?: string
  message?: string
  emptyMessage?: string
}

export interface SelectDef {
  source: string
  excludeSelf?: boolean
  filters?: Record<string, string>
  title?: string
  message?: string
  field: string
  emptyMessage?: string
}

export interface PromptDef {
  title?: string
  message?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  field: string
  required?: boolean | string
  messageDetails?: ModalDetailGroup[]
}

export interface ModalDetailGroup {
  label: string
  items: string[]
}

// --- List actions ---
export interface ListAction {
  id: string
  label: string
  style?: 'primary' | 'danger'
  enabled?: boolean
  disabledMessage?: string
  confirm?: { title?: string; message?: string }
  showProgress?: boolean
  progressTitle?: string
  cancellable?: boolean
}

// --- Action results ---
export interface ActionResult {
  ok?: boolean
  navigate?: 'list' | 'detail'
  message?: string
  mode?: 'console' | 'window'
  portConflict?: PortConflictInfo
  cancelled?: boolean
  running?: boolean
}

export interface PortConflictInfo {
  port: number
  pids?: number[]
  nextPort?: number
  isComfy?: boolean
}

export interface AddResult {
  ok: boolean
  message?: string
  entry?: Installation
}

export interface KillResult {
  ok: boolean
}

export interface QuitActiveItem {
  name: string
  type: 'session' | 'operation' | 'download'
}

// --- Settings types ---
export interface SettingsSection {
  title?: string
  fields: SettingsField[]
  actions?: SettingsAction[]
}

export interface SettingsAction {
  label: string
  url?: string
  action?: string
}

export interface SettingsField {
  id: string
  label: string
  type: 'text' | 'path' | 'select' | 'boolean' | 'pathList' | 'number'
  value: string | boolean | number | string[] | null
  readonly?: boolean
  options?: { value: string; label: string }[]
  openable?: boolean
  placeholder?: string
  min?: number
  max?: number
  tooltip?: string
}

// --- Models types ---
export interface ModelsResult {
  systemDefault: string
  sections: ModelsSection[]
}

export interface ModelsSection {
  title?: string
  fields: ModelsField[]
}

export interface ModelsField {
  id: string
  label: string
  type: 'pathList'
  value: string[]
  tooltip?: string
}

// --- Probe types ---
export interface ProbeResult {
  sourceLabel: string
  version?: string
  repo?: string
  branch?: string
  [key: string]: unknown
}

// --- Progress types ---
export interface ProgressData {
  installationId: string
  phase: string
  status?: string
  percent?: number
  steps?: ProgressStep[]
}

export interface ProgressStep {
  phase: string
  label: string
}

// --- Event data types ---
export interface ComfyOutputData {
  installationId: string
  text: string
}

export interface ComfyExitedData {
  installationId: string
  installationName: string
  crashed?: boolean
  exitCode?: number
}

export interface GPUInfo {
  id?: string
  label: string
}

export interface HardwareValidation {
  supported: boolean
  error?: string
}

export interface NvidiaDriverCheck {
  driverVersion: string
  minimumVersion: string
  supported: boolean
}

export interface DiskSpaceInfo {
  free: number
  total: number
}

export type PathIssue = 'insideAppBundle' | 'oneDrive' | 'insideSharedDir' | 'insideExistingInstall'

// --- Update types ---
export interface UpdateInfo {
  version: string
}

export interface UpdateDownloadProgress {
  transferred: string
  total: string
  percent: number
}

// --- Model download types ---
export type ModelDownloadStatus =
  | 'pending'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'

export interface ModelDownloadProgress {
  url: string
  filename: string
  directory?: string
  savePath?: string
  progress: number
  receivedBytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSeconds?: number
  status: ModelDownloadStatus
  error?: string
}

// --- Track types ---
export interface TrackResult {
  ok: boolean
  message?: string
}

export interface SystemInfo {
  gpu_vendor: string | null
  gpu_label: string | null
  nvidia_driver_version: string | null
  nvidia_driver_supported: boolean | null
  platform: string
  arch: string
  os_version: string
  electron_version: string
  chrome_version: string
  total_memory_gb: number
  cpu_model: string
  cpu_cores: number
}

export interface SnapshotDiffEntry {
  createdAt: string
  trigger: string
  label: string | null
  nodesAdded: Array<{ id: string; type: string; dirName: string; enabled: boolean; version?: string; commit?: string }>
  nodesRemoved: Array<{ id: string; type: string; dirName: string; enabled: boolean; version?: string; commit?: string }>
  nodesChanged: Array<{
    id: string
    from: { version?: string; commit?: string; enabled: boolean }
    to: { version?: string; commit?: string; enabled: boolean }
  }>
  pipsAdded: Array<{ name: string; version: string }>
  pipsRemoved: Array<{ name: string; version: string }>
  pipsChanged: Array<{ name: string; from: string; to: string }>
  comfyuiChanged: boolean
  comfyui?: {
    from: { ref: string; commit: string | null }
    to: { ref: string; commit: string | null }
  }
  updateChannelChanged: boolean
  updateChannel?: { from: string; to: string }
}

export interface InstallationDdContext {
  installation_id: string
  variant: string
  source_id: string
  update_channel: string
  comfyui_version: string
  copied_from?: string
  copy_reason?: string
  snapshot_count: number
  latest_snapshot: {
    createdAt: string
    trigger: string
    label: string | null
    comfyui: {
      ref: string
      commit: string | null
      releaseTag: string
      variant: string
    }
    customNodes: Array<{
      id: string
      type: string
      dirName: string
      enabled: boolean
      version?: string
      commit?: string
    }>
    pipPackages: Record<string, string>
    pythonVersion?: string
    updateChannel?: string
  } | null
  snapshot_diffs: SnapshotDiffEntry[]
}

export interface DatadogForwardedError {
  source: string
  message: string
  stack?: string
  level?: 'debug' | 'info' | 'warn' | 'error' | 'critical'
  context?: Record<string, unknown>
}

// --- Snapshot tab types ---
export interface CopyEvent {
  installationId: string
  installationName: string
  copiedAt: string
  copyReason: 'copy' | 'copy-update' | 'release-update'
  exists: boolean
}

export interface SnapshotDiffSummary {
  nodesAdded: number
  nodesRemoved: number
  nodesChanged: number
  pipsAdded: number
  pipsRemoved: number
  pipsChanged: number
  comfyuiChanged: boolean
  updateChannelChanged: boolean
}

export interface SnapshotSummary {
  filename: string
  createdAt: string
  trigger: 'boot' | 'restart' | 'manual' | 'pre-update' | 'post-update' | 'post-restore'
  label: string | null
  comfyuiVersion: string
  nodeCount: number
  pipPackageCount: number
  diffVsPrevious?: SnapshotDiffSummary
}

export interface SnapshotListData {
  snapshots: SnapshotSummary[]
  copyEvents: CopyEvent[]
  totalCount: number
  context: {
    updateChannel: string
    pythonVersion: string
    variant: string
    variantLabel: string
  }
}

export interface SnapshotNodeInfo {
  id: string
  type: 'cnr' | 'git' | 'file'
  dirName: string
  enabled: boolean
  version?: string
  commit?: string
  url?: string
}

export interface SnapshotDetailData {
  filename: string
  createdAt: string
  trigger: string
  label: string | null
  comfyuiVersion: string
  comfyui: {
    ref: string
    commit: string | null
    releaseTag: string
    variant: string
  }
  pythonVersion?: string
  updateChannel?: string
  customNodes: SnapshotNodeInfo[]
  pipPackageCount: number
  pipPackages: Record<string, string>
}

export interface SnapshotDiffNodeChange {
  id: string
  type: string
  from: { version?: string; commit?: string; enabled: boolean }
  to: { version?: string; commit?: string; enabled: boolean }
}

export interface SnapshotDiffResult {
  comfyuiChanged: boolean
  comfyui?: {
    from: { ref: string; commit: string | null; formattedVersion: string }
    to: { ref: string; commit: string | null; formattedVersion: string }
  }
  updateChannelChanged: boolean
  updateChannel?: { from: string; to: string }
  nodesAdded: SnapshotNodeInfo[]
  nodesRemoved: SnapshotNodeInfo[]
  nodesChanged: SnapshotDiffNodeChange[]
  pipsAdded: Array<{ name: string; version: string }>
  pipsRemoved: Array<{ name: string; version: string }>
  pipsChanged: Array<{ name: string; from: string; to: string }>
}

export interface SnapshotDiffData {
  mode: 'previous' | 'current'
  baseLabel: string
  diff: SnapshotDiffResult
  empty: boolean
}

export interface SnapshotFilePreview {
  filePath: string
  installationName: string
  snapshotCount: number
  snapshots: SnapshotSummary[]
  newestSnapshot: SnapshotDetailData
}

// --- Error detail (async follow-up after a locked-file error) ---
export interface ErrorDetailData {
  installationId: string
  message: string
}

// --- IPC API interface ---
export interface ElectronApi {
  // Sources / New Install
  getSources(): Promise<Source[]>
  getFieldOptions(
    sourceId: string,
    fieldId: string,
    selections: Record<string, FieldOption>
  ): Promise<FieldOption[]>
  buildInstallation(
    sourceId: string,
    selections: Record<string, FieldOption>
  ): Promise<Record<string, unknown>>
  getDefaultInstallDir(): Promise<string>
  detectGPU(): Promise<GPUInfo | null>
  validateHardware(): Promise<HardwareValidation>
  checkNvidiaDriver(): Promise<NvidiaDriverCheck | null>

  // File/URL
  browseFolder(defaultPath?: string): Promise<string | null>
  openPath(targetPath: string): Promise<void>
  openExternal(url: string): Promise<void>
  getDiskSpace(targetPath: string): Promise<DiskSpaceInfo>
  validateInstallPath(targetPath: string): Promise<PathIssue[]>
  getInstallationSize(installationId: string): Promise<{ sizeBytes: number }>
  cancelInstallationSize(): Promise<void>

  // Locale
  getLocaleMessages(): Promise<Record<string, unknown>>
  getAvailableLocales(): Promise<{ value: string; label: string }[]>

  // Installations
  getInstallations(): Promise<Installation[]>
  addInstallation(data: Record<string, unknown>): Promise<AddResult>
  reorderInstallations(orderedIds: string[]): Promise<void>
  probeInstallation(dirPath: string): Promise<ProbeResult[]>
  trackInstallation(data: Record<string, unknown>): Promise<TrackResult>
  installInstance(installationId: string): Promise<void>
  updateInstallation(
    installationId: string,
    data: Record<string, unknown>
  ): Promise<ActionResult | void>

  // Running
  stopComfyUI(installationId: string): Promise<void>
  focusComfyWindow(installationId: string): Promise<void>
  getRunningInstances(): Promise<RunningInstance[]>
  cancelLaunch(): Promise<void>
  cancelOperation(installationId: string): Promise<void>
  killPortProcess(port: number): Promise<KillResult>

  // Actions
  getListActions(installationId: string): Promise<ListAction[]>
  getDetailSections(installationId: string): Promise<DetailSection[]>
  getComfyArgs(installationId: string): Promise<{ args: ComfyArgDef[]; error?: string } | null>
  runAction(
    installationId: string,
    actionId: string,
    actionData?: Record<string, unknown>
  ): Promise<ActionResult>

  // Snapshots
  getSnapshots(installationId: string): Promise<SnapshotListData>
  getSnapshotDetail(installationId: string, filename: string): Promise<SnapshotDetailData>
  getSnapshotDiff(installationId: string, filename: string, mode: 'previous' | 'current'): Promise<SnapshotDiffData>
  exportSnapshot(installationId: string, filename: string): Promise<{ ok: boolean; message?: string }>
  exportAllSnapshots(installationId: string): Promise<{ ok: boolean; message?: string }>
  importSnapshots(installationId: string): Promise<{ ok: boolean; imported?: number; skipped?: number; message?: string }>
  previewSnapshotFile(): Promise<{ ok: boolean; preview?: SnapshotFilePreview; message?: string }>
  previewDesktopMigration(): Promise<{ ok: boolean; message?: string; preview?: SnapshotFilePreview; snapshotPath?: string }>
  previewLocalMigration(installationId: string): Promise<{ ok: boolean; message?: string; preview?: SnapshotFilePreview; snapshotPath?: string }>
  previewSnapshotPath(filePath: string): Promise<{ ok: boolean; preview?: SnapshotFilePreview; message?: string }>
  createFromSnapshot(filePath: string, name?: string, releaseTag?: string, variantId?: string): Promise<{ ok: boolean; entry?: { id: string; name: string }; message?: string }>
  getPathForFile(file: File): string

  // Settings
  getSettingsSections(): Promise<SettingsSection[]>
  getModelsSections(): Promise<ModelsResult>
  getMediaSections(): Promise<SettingsSection[]>
  getUniqueName(baseName: string): Promise<string>
  setSetting(key: string, value: unknown): Promise<void>
  getSetting(key: string): Promise<unknown>

  // Theme
  getResolvedTheme(): Promise<ResolvedTheme>

  // App
  getAppVersion(): Promise<string>
  quitApp(): Promise<void>
  resetZoom(): Promise<void>
  getSystemInfo(): Promise<SystemInfo>
  getInstallationDdContext(installationId: string): Promise<InstallationDdContext | null>

  // Updates
  checkForUpdate(): Promise<{ available: boolean; version?: string; error?: string }>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  getPendingUpdate(): Promise<UpdateInfo | null>
  getUpdateCapabilities(): Promise<{ canAutoUpdate: boolean; systemManaged: boolean }>

  // Model downloads
  listModelDownloads(): Promise<ModelDownloadProgress[]>
  pauseModelDownload(url: string): Promise<boolean>
  resumeModelDownload(url: string): Promise<boolean>
  cancelModelDownload(url: string): Promise<boolean>
  showDownloadInFolder(savePath: string): Promise<void>

  // Event listeners (return unsubscribe functions)
  onInstallProgress(callback: (data: ProgressData) => void): Unsubscribe
  onComfyOutput(callback: (data: ComfyOutputData) => void): Unsubscribe
  onComfyExited(callback: (data: ComfyExitedData) => void): Unsubscribe
  onInstanceLaunching(callback: (data: { installationId: string; installationName: string }) => void): Unsubscribe
  onInstanceLaunchFailed(callback: (data: { installationId: string }) => void): Unsubscribe
  onInstanceStarted(callback: (data: RunningInstance) => void): Unsubscribe
  onInstanceStopping(callback: (data: { installationId: string }) => void): Unsubscribe
  onInstanceStopped(callback: (data: { installationId: string }) => void): Unsubscribe
  onThemeChanged(callback: (theme: ResolvedTheme) => void): Unsubscribe
  onLocaleChanged(callback: (messages: Record<string, unknown>) => void): Unsubscribe
  onConfirmQuit(callback: (details: QuitActiveItem[]) => void): Unsubscribe
  onInstallationsChanged(callback: () => void): Unsubscribe
  onInstallationsVersionsUpdated(callback: (updates: { id: string; version: string }[]) => void): Unsubscribe
  onUpdateAvailable(callback: (info: UpdateInfo) => void): Unsubscribe
  onUpdateDownloadProgress(callback: (progress: UpdateDownloadProgress) => void): Unsubscribe
  onUpdateDownloaded(callback: (info: UpdateInfo) => void): Unsubscribe
  onUpdateError(callback: (err: { message: string }) => void): Unsubscribe
  onZoomChanged(callback: (level: number) => void): Unsubscribe
  onModelDownloadProgress(callback: (progress: ModelDownloadProgress) => void): Unsubscribe
  onTelemetrySettingChanged(callback: (enabled: boolean | undefined) => void): Unsubscribe
  onDatadogError(callback: (payload: DatadogForwardedError) => void): Unsubscribe
  onErrorDetail(callback: (data: ErrorDetailData) => void): Unsubscribe
}

/** Action IDs that require the installation to be stopped before running.
 *  Shared between main and renderer processes. */
export const REQUIRES_STOPPED = new Set([
  'delete',
  'copy',
  'copy-update',
  'release-update',
  'migrate-to-standalone',
  'snapshot-restore',
  'update-comfyui',
  'migrate-from',
])
