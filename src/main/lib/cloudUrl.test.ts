import { afterEach, describe, expect, it, vi } from 'vitest'
import { withCloudDistributionUtm } from './cloudUrl'

describe('withCloudDistributionUtm', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds default UTM params for cloud distribution links', () => {
    const result = withCloudDistributionUtm('https://cloud.comfy.org/')
    const url = new URL(result)

    expect(url.hostname).toBe('cloud.comfy.org')
    expect(url.searchParams.get('utm_source')).toBe('comfyui_desktop_2')
    expect(url.searchParams.get('utm_medium')).toBe('app_feature')
    expect(url.searchParams.has('utm_campaign')).toBe(false)
  })

  it('preserves existing query params and UTM overrides', () => {
    const result = withCloudDistributionUtm(
      'https://cloud.comfy.org/path?plan=pro&utm_source=custom-source'
    )
    const url = new URL(result)

    expect(url.searchParams.get('plan')).toBe('pro')
    expect(url.searchParams.get('utm_source')).toBe('custom-source')
    expect(url.searchParams.get('utm_medium')).toBe('app_feature')
    expect(url.searchParams.has('utm_campaign')).toBe(false)
  })

  it('does not modify non-cloud URLs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = 'https://example.com/path?plan=pro'
    expect(withCloudDistributionUtm(input)).toBe(input)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('returns invalid URLs unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(withCloudDistributionUtm('not a url')).toBe('not a url')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
