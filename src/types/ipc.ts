// Canonical IPC types shared across main, preload, and renderer.
// This file is the single source of truth — do not duplicate these types elsewhere.

// Unsubscribe function returned by event listeners
export type Unsubscribe = () => void

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
  items?: DetailItem[]
  fields?: DetailField[]
  actions?: ActionDef[]
}

export interface DetailItem {
  label: string
  active?: boolean
  actions?: ActionDef[]
}

export interface DetailFieldOption {
  value: string
  label: string
  description?: string
  recommended?: boolean
  data?: Record<string, unknown>
}

export interface DetailField {
  id: string
  label: string
  value: string | boolean | number | null
  editable?: boolean
  editType?: 'select' | 'boolean' | 'text' | 'track-cards'
  options?: DetailFieldOption[]
  refreshSection?: boolean
  onChangeAction?: string
}

export interface ActionDef {
  id: string
  label: string
  style?: 'primary' | 'danger'
  enabled?: boolean
  disabledMessage?: string
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

// --- Settings types ---
export interface SettingsSection {
  title?: string
  fields: SettingsField[]
  actions?: SettingsAction[]
}

export interface SettingsAction {
  label: string
  url?: string
}

export interface SettingsField {
  id: string
  label: string
  type: 'text' | 'path' | 'select' | 'boolean' | 'pathList' | 'number'
  value: string | boolean | number | string[] | null
  readonly?: boolean
  options?: { value: string; label: string }[]
  openable?: boolean
  min?: number
  max?: number
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

// --- Track types ---
export interface TrackResult {
  ok: boolean
  message?: string
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

  // File/URL
  browseFolder(defaultPath?: string): Promise<string | null>
  openPath(targetPath: string): Promise<void>
  openExternal(url: string): Promise<void>
  getDiskSpace(targetPath: string): Promise<DiskSpaceInfo>
  validateInstallPath(targetPath: string): Promise<PathIssue[]>

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
  runAction(
    installationId: string,
    actionId: string,
    actionData?: Record<string, unknown>
  ): Promise<ActionResult>

  // Settings
  getSettingsSections(): Promise<SettingsSection[]>
  getModelsSections(): Promise<ModelsResult>
  getMediaSections(): Promise<SettingsSection[]>
  getUniqueName(baseName: string): Promise<string>
  setSetting(key: string, value: unknown): Promise<void>
  getSetting(key: string): Promise<unknown>

  // Theme
  getResolvedTheme(): Promise<string>

  // App
  quitApp(): Promise<void>

  // Updates
  checkForUpdate(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  getPendingUpdate(): Promise<UpdateInfo | null>

  // Event listeners (return unsubscribe functions)
  onInstallProgress(callback: (data: ProgressData) => void): Unsubscribe
  onComfyOutput(callback: (data: ComfyOutputData) => void): Unsubscribe
  onComfyExited(callback: (data: ComfyExitedData) => void): Unsubscribe
  onInstanceStarted(callback: (data: RunningInstance) => void): Unsubscribe
  onInstanceStopped(callback: (data: { installationId: string }) => void): Unsubscribe
  onThemeChanged(callback: (theme: string) => void): Unsubscribe
  onLocaleChanged(callback: (messages: Record<string, unknown>) => void): Unsubscribe
  onConfirmQuit(callback: () => void): Unsubscribe
  onInstallationsChanged(callback: () => void): Unsubscribe
  onUpdateAvailable(callback: (info: UpdateInfo) => void): Unsubscribe
  onUpdateDownloadProgress(callback: (progress: UpdateDownloadProgress) => void): Unsubscribe
  onUpdateDownloaded(callback: (info: UpdateInfo) => void): Unsubscribe
  onUpdateError(callback: (err: { message: string }) => void): Unsubscribe
}
