import type { RumErrorEvent } from '@datadog/browser-rum'

// Synthetic bundle URLs used only for Datadog path matching.
export const DATADOG_BUNDLE_BASE_URL = 'app://app'

const DATADOG_BUNDLE_PATH_PATTERNS = [
  /file:\/\/\/[^\s)\n]*?[\\/]+out[\\/]+(renderer|main|preload)([\\/][^)\s\n:]+\.js)/g,
  /[A-Za-z]:\\[^\s)\n]*?\\out\\(renderer|main|preload)(\\[^)\s\n:]+\.js)/g,
  /\/[^\s)\n]*?\/out\/(renderer|main|preload)(\/[^)\s\n:]+\.js)/g,
]

export function normalizeDatadogBundlePaths(value: string | undefined): string | undefined {
  if (!value) return value

  let normalized = value
  for (const pattern of DATADOG_BUNDLE_PATH_PATTERNS) {
    normalized = normalized.replace(pattern, (_match, bundleName: string, resourcePath: string) => {
      return `${DATADOG_BUNDLE_BASE_URL}/${bundleName}${resourcePath.replace(/\\/g, '/')}`
    })
  }

  return normalized
}

const PII_PATH_PATTERNS = [
  /([A-Za-z]:[\\/]Users[\\/])[^\\/]+?(?=[\\/]|$)/g,
  /(\/Users\/)[^\\/]+?(?=\/|$)/g,
  /(\/home\/)[^\\/]+?(?=\/|$)/g,
]

export function scrubPII(value: string): string {
  let scrubbed = value
  for (const pattern of PII_PATH_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`)
  }
  return scrubbed
}

export function normalizeRumErrorEvent(event: RumErrorEvent): void {
  event.error.message = scrubPII(event.error.message)
  event.error.stack = normalizeDatadogBundlePaths(event.error.stack)
  if (event.error.stack) {
    event.error.stack = scrubPII(event.error.stack)
  }
  for (const cause of event.error.causes || []) {
    cause.stack = normalizeDatadogBundlePaths(cause.stack)
    if (cause.stack) {
      cause.stack = scrubPII(cause.stack)
    }
  }
  if (event.error.resource?.url) {
    event.error.resource.url = normalizeDatadogBundlePaths(event.error.resource.url) || event.error.resource.url
    event.error.resource.url = scrubPII(event.error.resource.url)
  }
}
