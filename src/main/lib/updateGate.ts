import { randomUUID } from 'node:crypto'
import { PostHog } from 'posthog-node'
import type { FeatureFlagResult } from 'posthog-node'
import {
  DEFAULT_POSTHOG_HOST,
  DEFAULT_POSTHOG_PROJECT_TOKEN,
  DEFAULT_UPDATER_CANARY_FLAG_KEY,
  POSTHOG_DISTINCT_ID_SETTING_KEY,
  normalizePosthogHost,
  parsePosthogTimeoutMs,
} from './posthogConfig'

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

export interface UpdaterCanaryContext {
  currentVersion?: string
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

type PosthogDecideFetcher = (
  config: UpdaterCanaryConfig,
  context: UpdaterCanaryContext
) => Promise<FeatureFlagResult | undefined>

let _cachedDistinctId: string | null = null

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

function getOrCreateDistinctId(): string {
  if (_cachedDistinctId) return _cachedDistinctId

  try {
    // Dynamic require keeps this module test-friendly outside Electron runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const settings = require('../settings') as {
      get: (key: string) => unknown
      set: (key: string, value: unknown) => void
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
  } catch {
    const generated = randomUUID()
    _cachedDistinctId = generated
    return generated
  }
}

export function resolveUpdaterCanaryConfig(env: NodeJS.ProcessEnv = process.env): UpdaterCanaryConfig {
  const projectToken = (env['COMFY_POSTHOG_PROJECT_TOKEN'] ?? DEFAULT_POSTHOG_PROJECT_TOKEN).trim()
  const host = normalizePosthogHost((env['COMFY_POSTHOG_HOST'] ?? DEFAULT_POSTHOG_HOST).trim() || DEFAULT_POSTHOG_HOST)
  const distinctId = (env['COMFY_POSTHOG_DISTINCT_ID'] ?? env['COMFY_UPDATER_DISTINCT_ID'] ?? '').trim() || getOrCreateDistinctId()

  return {
    enabled: projectToken.length > 0,
    host,
    projectToken,
    flagKey: DEFAULT_UPDATER_CANARY_FLAG_KEY,
    distinctId,
    fallbackPolicy: parseFallbackPolicy(env['COMFY_UPDATER_CANARY_FALLBACK']),
    timeoutMs: parsePosthogTimeoutMs(env['COMFY_UPDATER_CANARY_TIMEOUT_MS']),
    override: parseBooleanOverride(env['COMFY_UPDATER_CANARY_OVERRIDE']),
  }
}

async function fetchPosthogDecide(
  config: UpdaterCanaryConfig,
  context: UpdaterCanaryContext
): Promise<FeatureFlagResult | undefined> {
  const client = new PostHog(config.projectToken, {
    host: config.host,
    requestTimeout: config.timeoutMs,
    featureFlagsRequestTimeoutMs: config.timeoutMs,
    fetchRetryCount: 0,
    sendFeatureFlagEvent: false,
    flushAt: 1,
    flushInterval: 0,
  })
  try {
    const personProperties: Record<string, string> = {}
    if (context.currentVersion) {
      personProperties['$app_version'] = context.currentVersion
      // Persist app version on the person profile so flag conditions can target it.
      client.identify({
        distinctId: config.distinctId,
        properties: personProperties,
      })
    }

    return await client.getFeatureFlagResult(config.flagKey, config.distinctId, {
      personProperties,
      sendFeatureFlagEvents: false,
    })
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
  fetcher: PosthogDecideFetcher = fetchPosthogDecide,
  context: UpdaterCanaryContext = {}
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
      detail: 'Updater canary gating is disabled (missing COMFY_POSTHOG_PROJECT_TOKEN).',
    }
  }

  try {
    const result = await fetcher(config, context)
    if (!result) {
      return fallbackDecision(
        config,
        'fallback-missing-flag',
        `Feature flag "${config.flagKey}" was not returned by PostHog.`
      )
    }

    return {
      allowed: result.enabled,
      reason: result.enabled ? 'flag-allow' : 'flag-block',
      detail: result.enabled
        ? `Feature flag "${config.flagKey}" enabled updates.`
        : `Feature flag "${config.flagKey}" blocked updates.`,
      variant: result.variant,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return fallbackDecision(config, 'fallback-error', `PostHog decide failed: ${message}`)
  }
}
