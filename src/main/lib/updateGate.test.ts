import { describe, expect, it, vi } from 'vitest'
import { evaluateUpdaterCanaryGate, resolveUpdaterCanaryConfig, type UpdaterCanaryConfig } from './updateGate'
import type { FeatureFlagResult } from 'posthog-node'

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

function buildResult(overrides: Partial<FeatureFlagResult> = {}): FeatureFlagResult {
  return {
    key: 'launcher_auto_update_enabled',
    enabled: true,
    variant: 'allow',
    payload: undefined,
    ...overrides,
  }
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
    const fetcher = vi.fn().mockResolvedValue(buildResult({ enabled: true }))
    const decision = await evaluateUpdaterCanaryGate(buildConfig(), fetcher)

    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('flag-allow')
  })

  it('blocks update checks when the PostHog flag is false', async () => {
    const fetcher = vi.fn().mockResolvedValue(buildResult({ enabled: false }))
    const decision = await evaluateUpdaterCanaryGate(buildConfig(), fetcher)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('flag-block')
  })

  it('falls back when the flag result is missing', async () => {
    const fetcher = vi.fn().mockResolvedValue(undefined)
    const decision = await evaluateUpdaterCanaryGate(buildConfig({ fallbackPolicy: 'block' }), fetcher)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('fallback-missing-flag')
  })

  it('ignores payload data for gate decisions', async () => {
    const fetcher = vi.fn().mockResolvedValue(buildResult({ enabled: true, payload: { any: 'value' } }))
    const decision = await evaluateUpdaterCanaryGate(buildConfig(), fetcher)

    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('flag-allow')
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

  it('passes app_version context into the fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue(buildResult({ enabled: true }))
    await evaluateUpdaterCanaryGate(buildConfig(), fetcher, { currentVersion: '1.2.3' })

    expect(fetcher).toHaveBeenCalledWith(expect.any(Object), { currentVersion: '1.2.3' })
  })
})
