import type { InstallationRecord } from '../shared'

export interface ActionContext {
  event: Electron.IpcMainInvokeEvent
  installationId: string
  inst: InstallationRecord
  actionData?: Record<string, unknown>
}

export interface ActionResult {
  ok: boolean
  message?: string
  navigate?: string
  running?: boolean
  cancelled?: boolean
  mode?: string
  port?: number
  url?: string
  portConflict?: Record<string, unknown>
}
