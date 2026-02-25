import type { InstallationRecord } from '../installations'
import type { Cache } from '../lib/cache'
import type { DownloadProgress } from '../lib/download'
import type { ExtractProgress } from '../lib/extract'

// --- Field types ---

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

// --- Launch command ---

export interface LaunchCommand {
  cmd?: string
  args?: string[]
  cwd?: string
  port?: number
  remote?: boolean
  url?: string
  host?: string
  env?: NodeJS.ProcessEnv
}

// --- Install / action tools ---

export interface InstallTools {
  sendProgress: (step: string, data: { percent: number; status: string }) => void
  download: (url: string, dest: string, onProgress: ((p: DownloadProgress) => void) | null, options?: { signal?: AbortSignal }) => Promise<string>
  cache: Cache
  extract: (archivePath: string, dest: string, onProgress?: ((p: ExtractProgress) => void) | null, options?: { signal?: AbortSignal }) => Promise<void>
  signal?: AbortSignal
}

export interface ActionTools {
  update: (data: Record<string, unknown>) => Promise<void>
  sendProgress: (step: string, data: Record<string, unknown>) => void
  sendOutput: (text: string) => void
  signal?: AbortSignal
}

export interface PostInstallTools {
  sendProgress: (step: string, data: { percent: number; status: string }) => void
  update: (data: Record<string, unknown>) => Promise<void>
}

// --- Action / detail section types ---

export interface ActionResult {
  ok: boolean
  navigate?: string
  message?: string
}

export interface StatusTag {
  label: string
  style: string
}

export interface InstallStep {
  phase: string
  label: string
}

// --- Source plugin interface ---

export interface SourcePlugin {
  id: string
  label: string
  description?: string
  category: string
  hasConsole?: boolean
  skipInstall?: boolean
  fields: readonly SourceField[]
  defaultLaunchArgs?: string
  installSteps?: readonly InstallStep[]

  getDefaults?(): Record<string, unknown>
  getStatusTag?(installation: InstallationRecord): StatusTag | undefined
  buildInstallation(selections: Record<string, FieldOption | undefined>): Record<string, unknown>
  getListPreview?(installation: InstallationRecord): string | null
  getLaunchCommand(installation: InstallationRecord): LaunchCommand | null
  getListActions(installation: InstallationRecord): Record<string, unknown>[]
  getDetailSections(installation: InstallationRecord): Record<string, unknown>[]
  install?(installation: InstallationRecord, tools: InstallTools): Promise<void>
  postInstall?(installation: InstallationRecord, tools: PostInstallTools): Promise<void>
  probeInstallation(dirPath: string): Record<string, unknown> | null
  handleAction(
    actionId: string,
    installation: InstallationRecord,
    actionData: Record<string, unknown> | undefined,
    tools: ActionTools
  ): Promise<ActionResult>
  getFieldOptions(
    fieldId: string,
    selections: Record<string, FieldOption | undefined>,
    context: Record<string, unknown>
  ): Promise<FieldOption[]>
  fixupCopy?(srcPath: string, destPath: string): Promise<void>
}
