import { describe, expect, it, vi } from 'vitest'
import { evaluateUpdaterCanaryGate, resolveUpdaterCanaryConfig, type UpdaterCanaryConfig } from './updateGate'

const BASE_CONFIG: UpdaterCanaryConfig = {
  enabled: true,
  host: 'https://us.i.posthog.com',
  projectToken: 'phc_test',
  flagKey: 'launcher_auto_update_enabled',
  distinctId: 'test-distinct-id',
  fallbackPolicy: 'block',
  timeoutMs: 5000,
}

function buildConfig(overrides: Partial<UpdaterCanaryConfig> = {}): UpdaterCanaryConfig {
  return { ...BASE_CONFIG, ...overrides }
}

describe('evaluateUpdaterCanaryGate', () => {
  it('allows when gating is not configured', async () => {
    const fetcher = vi.fn()
    const decision = await evaluateUpdaterCanaryGate(buildConfig({ enabled: false }), fetcher)

    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('not-configured')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('respects explicit override without calling PostHog', async () => {
    const fetcher = vi.fn()
    const decision = await evaluateUpdaterCanaryGate(buildConfig({ override: false }), fetcher)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('override-block')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('allows update checks when the PostHog flag is true', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      featureFlags: {
        launcher_auto_update_enabled: true,
      },
    })
    const decision = await evaluateUpdaterCanaryGate(buildConfig(), fetcher)

    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('flag-allow')
  })

  it('blocks update checks when the PostHog flag is false', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      featureFlags: {
        launcher_auto_update_enabled: false,
      },
    })
    const decision = await evaluateUpdaterCanaryGate(buildConfig(), fetcher)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('flag-block')
  })

  it('treats non-boolean mapped flag values as missing', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      featureFlags: {
        launcher_auto_update_enabled: 'true',
      },
    })
    const decision = await evaluateUpdaterCanaryGate(buildConfig({ fallbackPolicy: 'block' }), fetcher)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('fallback-missing-flag')
  })

  it('allows update checks when the flag appears in array-style response', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      featureFlags: ['other_flag', 'launcher_auto_update_enabled'],
    })
    const decision = await evaluateUpdaterCanaryGate(buildConfig(), fetcher)

    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('flag-allow')
  })

  it('treats missing array-style flag keys as disabled', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      featureFlags: ['other_flag'],
    })
    const decision = await evaluateUpdaterCanaryGate(buildConfig({ fallbackPolicy: 'allow' }), fetcher)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('flag-block')
  })

  it('falls back to block when the flag is missing from response', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      featureFlags: {
        some_other_flag: true,
      },
    })
    const decision = await evaluateUpdaterCanaryGate(buildConfig({ fallbackPolicy: 'block' }), fetcher)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('fallback-missing-flag')
  })

  it('falls back to allow on network failures when configured', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'))
    const decision = await evaluateUpdaterCanaryGate(buildConfig({ fallbackPolicy: 'allow' }), fetcher)

    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('fallback-error')
  })

  it('defaults fallback policy to allow when unset', () => {
    const config = resolveUpdaterCanaryConfig({
      COMFY_POSTHOG_PROJECT_TOKEN: 'phc_test',
      COMFY_POSTHOG_DISTINCT_ID: 'test-distinct-id',
    })

    expect(config.flagKey).toBe('launcher_auto_update_enabled')
    expect(config.fallbackPolicy).toBe('allow')
  })

  it('does not allow overriding the canary flag key from env', () => {
    const config = resolveUpdaterCanaryConfig({
      COMFY_POSTHOG_PROJECT_TOKEN: 'phc_test',
      COMFY_UPDATER_CANARY_FLAG_KEY: 'different_flag',
    })

    expect(config.flagKey).toBe('launcher_auto_update_enabled')
  })
})
