export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'
export const DEFAULT_POSTHOG_TIMEOUT_MS = 5000
export const MIN_POSTHOG_TIMEOUT_MS = 1000
export const MAX_POSTHOG_TIMEOUT_MS = 30000
export const POSTHOG_DISTINCT_ID_SETTING_KEY = 'posthogDistinctId'

export function normalizePosthogHost(host: string): string {
  return host.replace(/\/+$/, '')
}

export function parsePosthogTimeoutMs(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_POSTHOG_TIMEOUT_MS
  return Math.max(MIN_POSTHOG_TIMEOUT_MS, Math.min(MAX_POSTHOG_TIMEOUT_MS, Math.round(parsed)))
}
