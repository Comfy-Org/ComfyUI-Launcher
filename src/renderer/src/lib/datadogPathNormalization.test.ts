import { describe, expect, it } from 'vitest'
import type { RumErrorEvent } from '@datadog/browser-rum'
import { normalizeDatadogBundlePaths, normalizeRumErrorEvent } from './datadogPathNormalization'

describe('normalizeDatadogBundlePaths', () => {
  it('rewrites renderer file URLs to the synthetic Datadog bundle prefix', () => {
    const stack = 'Error: boom\n    at file:///Users/alice/ComfyUI/out/renderer/assets/index-abc123.js:1:23'

    expect(normalizeDatadogBundlePaths(stack)).toContain(
      'app://app/renderer/assets/index-abc123.js:1:23',
    )
  })

  it('rewrites Windows main-process paths to the synthetic Datadog bundle prefix', () => {
    const stack = 'Error: boom\n    at C:\\Users\\alice\\ComfyUI\\out\\main\\index.js:45:9'

    expect(normalizeDatadogBundlePaths(stack)).toContain(
      'app://app/main/index.js:45:9',
    )
  })

  it('leaves non-bundle URLs unchanged', () => {
    const url = 'https://example.com/app.js'

    expect(normalizeDatadogBundlePaths(url)).toBe(url)
  })
})

describe('normalizeRumErrorEvent', () => {
  it('updates the main stack, cause stacks, and resource URL when they point at built bundles', () => {
    const event = {
      error: {
        message: 'boom',
        source: 'custom',
        stack: 'Error: boom\n    at /Applications/ComfyUI/out/preload/index.js:5:2',
        causes: [
          {
            message: 'cause',
            source: 'custom',
            stack: 'Error: cause\n    at C:\\ComfyUI\\out\\main\\index.js:8:3',
          },
        ],
        resource: {
          method: 'GET',
          status_code: 500,
          url: 'file:///Users/alice/ComfyUI/out/renderer/assets/index-abc123.js',
        },
      },
    } as unknown as RumErrorEvent

    normalizeRumErrorEvent(event)

    expect(event.error.stack).toContain('app://app/preload/index.js:5:2')
    expect(event.error.causes?.[0]?.stack).toContain('app://app/main/index.js:8:3')
    expect(event.error.resource?.url).toBe('app://app/renderer/assets/index-abc123.js')
  })
})
