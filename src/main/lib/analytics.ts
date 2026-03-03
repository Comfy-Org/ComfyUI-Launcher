import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { PostHog } from 'posthog-node'
import * as settings from '../settings'
import type { RendererErrorReport } from '../../types/ipc'
import {
  DEFAULT_POSTHOG_HOST,
  POSTHOG_DISTINCT_ID_SETTING_KEY,
  normalizePosthogHost,
  parsePosthogTimeoutMs,
} from './posthogConfig'

const TELEMETRY_ENABLED_SETTING_KEY = 'telemetryEnabled'
const ERROR_REPORTING_ENABLED_SETTING_KEY = 'errorReportingEnabled'

const MAX_PROPERTY_KEYS = 50
const MAX_STRING_LENGTH = 2000
const MAX_STACK_LENGTH = 8000
const MAX_DEPTH = 4

let _cachedDistinctId: string | null = null
let _processHandlersBound = false
let _posthogClient: PostHog | null = null
let _posthogClientConfigKey: string | null = null

interface PosthogConfig {
  host: string
  projectToken: string
  distinctId: string
  timeoutMs: number
}

interface PosthogClientState {
  config: PosthogConfig
  client: PostHog
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on' ||
    normalized === 'enable' ||
    normalized === 'enabled'
  ) {
    return true
  }
  if (
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off' ||
    normalized === 'disable' ||
    normalized === 'disabled'
  ) {
    return false
  }
  return undefined
}

function getOrCreateDistinctId(): string {
  if (_cachedDistinctId) return _cachedDistinctId

  const envDistinctId = (process.env['COMFY_POSTHOG_DISTINCT_ID'] ?? '').trim()
  if (envDistinctId) {
    _cachedDistinctId = envDistinctId
    return envDistinctId
  }

  const existing = settings.get(POSTHOG_DISTINCT_ID_SETTING_KEY)
  if (typeof existing === 'string' && existing.trim().length > 0) {
    _cachedDistinctId = existing
    return existing
  }

  const generated = randomUUID()
  settings.set(POSTHOG_DISTINCT_ID_SETTING_KEY, generated)
  _cachedDistinctId = generated
  return generated
}

function isTelemetryEnabled(): boolean {
  const envOverride = parseBoolean(process.env['COMFY_POSTHOG_TELEMETRY_ENABLED'])
  if (envOverride !== undefined) return envOverride
  return settings.get(TELEMETRY_ENABLED_SETTING_KEY) === true
}

function isErrorReportingEnabled(): boolean {
  const envOverride = parseBoolean(process.env['COMFY_POSTHOG_ERROR_REPORTING_ENABLED'])
  if (envOverride !== undefined) return envOverride
  return settings.get(ERROR_REPORTING_ENABLED_SETTING_KEY) !== false
}

function getPosthogConfig(): PosthogConfig | null {
  const projectToken = (process.env['COMFY_POSTHOG_PROJECT_TOKEN'] ?? '').trim()
  if (!projectToken) return null

  const host = normalizePosthogHost((process.env['COMFY_POSTHOG_HOST'] ?? DEFAULT_POSTHOG_HOST).trim() || DEFAULT_POSTHOG_HOST)
  const timeoutMs = parsePosthogTimeoutMs(process.env['COMFY_POSTHOG_TIMEOUT_MS'] ?? process.env['COMFY_UPDATER_CANARY_TIMEOUT_MS'])

  return {
    host,
    projectToken,
    distinctId: getOrCreateDistinctId(),
    timeoutMs,
  }
}

function posthogConfigKey(config: PosthogConfig): string {
  return `${config.host}|${config.projectToken}|${config.distinctId}|${config.timeoutMs}`
}

function getPosthogClientState(): PosthogClientState | null {
  const config = getPosthogConfig()
  if (!config) return null

  const key = posthogConfigKey(config)
  if (!_posthogClient || _posthogClientConfigKey !== key) {
    if (_posthogClient) {
      try {
        _posthogClient.shutdown(config.timeoutMs)
      } catch {}
    }
    _posthogClient = new PostHog(config.projectToken, {
      host: config.host,
      requestTimeout: config.timeoutMs,
      featureFlagsRequestTimeoutMs: config.timeoutMs,
      fetchRetryCount: 0,
      sendFeatureFlagEvent: false,
      flushAt: 1,
      flushInterval: 0,
    })
    _posthogClientConfigKey = key
  }

  return { config, client: _posthogClient }
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}…`
}

function isSensitiveKey(key: string): boolean {
  return /(token|secret|password|cookie|authorization|auth)/i.test(key)
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[max-depth]'
  if (value == null) return null
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return truncateString(value, MAX_STRING_LENGTH)
  if (Array.isArray(value)) {
    return value.slice(0, MAX_PROPERTY_KEYS).map((entry) => sanitizeValue(entry, depth + 1))
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sanitized: Record<string, unknown> = {}
    for (const key of Object.keys(record).slice(0, MAX_PROPERTY_KEYS)) {
      sanitized[key] = isSensitiveKey(key) ? '[redacted]' : sanitizeValue(record[key], depth + 1)
    }
    return sanitized
  }
  return String(value)
}

function sanitizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeValue(properties)
  return (sanitized && typeof sanitized === 'object' ? sanitized : {}) as Record<string, unknown>
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name || 'Error',
      errorMessage: truncateString(error.message || 'Unknown error', MAX_STRING_LENGTH),
      errorStack: error.stack ? truncateString(error.stack, MAX_STACK_LENGTH) : null,
    }
  }

  return {
    errorName: 'NonError',
    errorMessage: truncateString(String(error), MAX_STRING_LENGTH),
    errorStack: null,
  }
}

function sendPosthogEvent(event: string, properties: Record<string, unknown>): void {
  const state = getPosthogClientState()
  if (!state) return
  try {
    state.client.capture({
      distinctId: state.config.distinctId,
      event,
      properties: {
        ...sanitizeProperties(properties),
        launcherVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[analytics] Failed to send PostHog event "${event}": ${msg}`)
  }
}

export function captureTelemetry(event: string, properties: Record<string, unknown> = {}): void {
  if (!isTelemetryEnabled()) return
  sendPosthogEvent(event, { category: 'telemetry', ...properties })
}

export function captureError(event: string, error: unknown, context: Record<string, unknown> = {}): void {
  if (!isErrorReportingEnabled()) return
  const serializedError = serializeError(error)
  sendPosthogEvent(event, {
    category: 'error-report',
    ...context,
    ...serializedError,
  })
}

export function reportRendererError(payload: RendererErrorReport): void {
  const message = payload.message || payload.reason || 'Renderer error'
  captureError('renderer_error', new Error(message), {
    type: payload.type,
    source: payload.source,
    line: payload.line,
    column: payload.column,
    rendererStack: payload.stack ? truncateString(payload.stack, MAX_STACK_LENGTH) : undefined,
    reason: payload.reason,
  })
}

export function registerProcessErrorHandlers(): void {
  if (_processHandlersBound) return
  _processHandlersBound = true

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    captureError('main_uncaught_exception', error, { origin })
  })

  process.on('unhandledRejection', (reason) => {
    captureError('main_unhandled_rejection', reason)
  })
}

export function shutdownAnalytics(): void {
  if (!_posthogClient) return
  try {
    const timeoutMs = getPosthogConfig()?.timeoutMs
    _posthogClient.shutdown(timeoutMs)
  } catch {}
  _posthogClient = null
  _posthogClientConfigKey = null
}
