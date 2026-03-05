import type { ModelDownloadStatus } from '../../../types/ipc'

export type TelemetryValue = boolean | number | string | null | undefined
export type TelemetryContext = Record<string, TelemetryValue>

export const TELEMETRY_ACTION_EVENT_NAME = 'launcher-telemetry-action'

export interface TelemetryActionEventDetail {
  actionName: string
  context?: TelemetryContext
}

export function emitTelemetryAction(actionName: string, context: TelemetryContext = {}): void {
  window.dispatchEvent(new CustomEvent<TelemetryActionEventDetail>(TELEMETRY_ACTION_EVENT_NAME, {
    detail: { actionName, context },
  }))
}

export function toVariantBucket(variantId: string | undefined): string {
  if (!variantId) return 'unknown'
  return variantId.replace(/^(win|mac|linux)-/, '')
}

export function toErrorBucket(error: unknown): string {
  const message = (
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  ).toLowerCase()
  if (!message) return 'unknown'
  if (message.includes('cancel')) return 'cancelled'
  if (message.includes('timeout')) return 'timeout'
  if (message.includes('network') || message.includes('fetch')) return 'network'
  if (message.includes('disk') || message.includes('space')) return 'disk'
  if (message.includes('permission') || message.includes('access')) return 'permissions'
  if (message.includes('path')) return 'path'
  return 'other'
}

export function toCountBucket(count: number): string {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  if (count <= 2) return '2'
  if (count <= 4) return '3_4'
  if (count <= 9) return '5_9'
  return '10_plus'
}

export function toSizeBucket(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return 'unknown'
  if (bytes < 10 * 1024 * 1024) return 'lt_10mb'
  if (bytes < 100 * 1024 * 1024) return '10_99mb'
  if (bytes < 1024 * 1024 * 1024) return '100mb_1gb'
  return 'gte_1gb'
}

export function toFileExtension(filename: string | undefined): string {
  if (!filename) return 'unknown'
  const idx = filename.lastIndexOf('.')
  if (idx < 0 || idx === filename.length - 1) return 'none'
  return filename.slice(idx + 1).toLowerCase()
}

export function toModelDirectoryBucket(directory: string | undefined): string {
  if (!directory) return 'unknown'
  const normalized = directory.replace(/\\/g, '/').toLowerCase()
  const parts = normalized.split('/').filter(Boolean)
  const leaf = parts[parts.length - 1] || 'unknown'
  const known = new Set([
    'checkpoints',
    'loras',
    'vae',
    'controlnet',
    'embeddings',
    'upscale_models',
    'diffusion_models',
    'clip_vision',
    'clip',
    'text_encoders',
    'unet',
    'vae_approx',
  ])
  return known.has(leaf) ? leaf : 'other'
}

export function isTerminalModelDownloadStatus(status: ModelDownloadStatus): boolean {
  return status === 'completed' || status === 'error' || status === 'cancelled'
}
