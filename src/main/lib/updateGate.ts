import { randomUUID } from 'node:crypto'
import { PostHog } from 'posthog-node'

export type UpdaterCanaryFallbackPolicy = 'allow' | 'block'

export interface UpdaterCanaryConfig {
  enabled: boolean
  host: string
  projectToken: string
  flagKey: string
  distinctId: string
  fallbackPolicy: UpdaterCanaryFallbackPolicy
  timeoutMs: number
  override?: boolean
}

export type UpdaterCanaryDecisionReason =
  | 'not-configured'
  | 'override-allow'
  | 'override-block'
  | 'flag-allow'
  | 'flag-block'
  | 'fallback-missing-flag'
  | 'fallback-error'

export interface UpdaterCanaryDecision {
  allowed: boolean
  reason: UpdaterCanaryDecisionReason
  detail: string
  variant?: string
}

interface ParsedFlagAssignment {
  found: boolean
  enabled: boolean
  variant?: string
}

type PosthogDecideFetcher = (config: UpdaterCanaryConfig) => Promise<unknown>

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'
const DEFAULT_TIMEOUT_MS = 5000
const MAX_TIMEOUT_MS = 30000
const MIN_TIMEOUT_MS = 1000
const DISTINCT_ID_SETTING_KEY = 'posthogDistinctId'

let _cachedDistinctId: string | null = null

class UpdateGatePostHogClient extends PostHog {
  async fetchFeatureFlags(distinctId: string, flagKey: string): Promise<Record<string, unknown>> {
    const result = await this.getFlags(distinctId, {}, {}, {}, { flag_keys_to_evaluate: [flagKey] })
    if (!result.success) {
      const statusSuffix = result.error.statusCode ? ` ${result.error.statusCode}` : ''
      throw new Error(`PostHog flags request failed (${result.error.type}${statusSuffix})`)
    }
    return result.response.featureFlags as Record<string, unknown>
  }
}

function normalizeHost(host: string): string {
  return host.replace(/\/+$/, '')
}

function parseBooleanOverride(value: string | undefined): boolean | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'allow') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'block') {
    return false
  }
  return undefined
}

function parseFallbackPolicy(value: string | undefined): UpdaterCanaryFallbackPolicy {
  return value?.trim().toLowerCase() === 'block' ? 'block' : 'allow'
}

function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(parsed)))
}

function parseFlagAssignment(rawFeatureFlags: unknown, flagKey: string): ParsedFlagAssignment {
  if (Array.isArray(rawFeatureFlags)) {
    const enabled = rawFeatureFlags.some((key) => key === flagKey)
    // Array payloads list only enabled flags, so absence means explicit false.
    return { found: true, enabled }
  }

  if (rawFeatureFlags && typeof rawFeatureFlags === 'object') {
    const flags = rawFeatureFlags as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(flags, flagKey)) {
      const value = flags[flagKey]
      if (typeof value === 'boolean') {
        return { found: true, enabled: value }
      }
      return { found: false, enabled: false }
    }
  }

  return { found: false, enabled: false }
}

function getOrCreateDistinctId(): string {
  if (_cachedDistinctId) return _cachedDistinctId

  try {
    // Dynamic require keeps this module test-friendly outside Electron runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const settings = require('../settings') as {
      get: (key: string) => unknown
      set: (key: string, value: unknown) => void
    }
    const existing = settings.get(DISTINCT_ID_SETTING_KEY)
    if (typeof existing === 'string' && existing.trim().length > 0) {
      _cachedDistinctId = existing
      return existing
    }

    const generated = randomUUID()
    settings.set(DISTINCT_ID_SETTING_KEY, generated)
    _cachedDistinctId = generated
    return generated
  } catch {
    const generated = randomUUID()
    _cachedDistinctId = generated
    return generated
  }
}

export function resolveUpdaterCanaryConfig(env: NodeJS.ProcessEnv = process.env): UpdaterCanaryConfig {
  const flagKey = (env['COMFY_UPDATER_CANARY_FLAG_KEY'] ?? '').trim()
  const projectToken = (env['COMFY_POSTHOG_PROJECT_TOKEN'] ?? '').trim()
  const host = normalizeHost((env['COMFY_POSTHOG_HOST'] ?? DEFAULT_POSTHOG_HOST).trim() || DEFAULT_POSTHOG_HOST)
  const distinctId = (env['COMFY_POSTHOG_DISTINCT_ID'] ?? env['COMFY_UPDATER_DISTINCT_ID'] ?? '').trim() || getOrCreateDistinctId()

  return {
    enabled: flagKey.length > 0 && projectToken.length > 0,
    host,
    projectToken,
    flagKey,
    distinctId,
    fallbackPolicy: parseFallbackPolicy(env['COMFY_UPDATER_CANARY_FALLBACK']),
    timeoutMs: parseTimeoutMs(env['COMFY_UPDATER_CANARY_TIMEOUT_MS']),
    override: parseBooleanOverride(env['COMFY_UPDATER_CANARY_OVERRIDE']),
  }
}

async function fetchPosthogDecide(config: UpdaterCanaryConfig): Promise<unknown> {
  const client = new UpdateGatePostHogClient(config.projectToken, {
    host: config.host,
    requestTimeout: config.timeoutMs,
    featureFlagsRequestTimeoutMs: config.timeoutMs,
    fetchRetryCount: 0,
    sendFeatureFlagEvent: false,
    flushAt: 1,
    flushInterval: 0,
  })
  try {
    const featureFlags = await client.fetchFeatureFlags(config.distinctId, config.flagKey)
    return { featureFlags }
  } finally {
    client.shutdown(config.timeoutMs)
  }
}

function fallbackDecision(
  config: UpdaterCanaryConfig,
  reason: 'fallback-error' | 'fallback-missing-flag',
  detail: string
): UpdaterCanaryDecision {
  const allowed = config.fallbackPolicy === 'allow'
  return { allowed, reason, detail }
}

export async function evaluateUpdaterCanaryGate(
  config: UpdaterCanaryConfig = resolveUpdaterCanaryConfig(),
  fetcher: PosthogDecideFetcher = fetchPosthogDecide
): Promise<UpdaterCanaryDecision> {
  if (config.override !== undefined) {
    return {
      allowed: config.override,
      reason: config.override ? 'override-allow' : 'override-block',
      detail: `Override set via COMFY_UPDATER_CANARY_OVERRIDE=${config.override ? 'allow' : 'block'}`,
    }
  }

  if (!config.enabled) {
    return {
      allowed: true,
      reason: 'not-configured',
      detail: 'Updater canary gating is disabled (missing COMFY_UPDATER_CANARY_FLAG_KEY or COMFY_POSTHOG_PROJECT_TOKEN).',
    }
  }

  try {
    const raw = await fetcher(config)
    const featureFlags = (raw as { featureFlags?: unknown })?.featureFlags
    const assignment = parseFlagAssignment(featureFlags, config.flagKey)

    if (!assignment.found) {
      return fallbackDecision(
        config,
        'fallback-missing-flag',
        `Feature flag "${config.flagKey}" was not returned by PostHog.`
      )
    }

    return {
      allowed: assignment.enabled,
      reason: assignment.enabled ? 'flag-allow' : 'flag-block',
      detail: assignment.enabled
        ? `Feature flag "${config.flagKey}" enabled updates.`
        : `Feature flag "${config.flagKey}" blocked updates.`,
      variant: assignment.variant,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return fallbackDecision(config, 'fallback-error', `PostHog decide failed: ${message}`)
  }
}
