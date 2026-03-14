const CLOUD_DISTRIBUTION_HOST = 'cloud.comfy.org'

const DEFAULT_UTM_PARAMS: Record<string, string> = {
  utm_source: 'comfyui_desktop_2',
  utm_medium: 'app_feature',
}

function warnSkippedUtm(reason: string, details: Record<string, string>): void {
  console.warn(`[cloud-utm] ${reason}`, details)
}

export function withCloudDistributionUtm(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    warnSkippedUtm('Skipped UTM tagging because URL parsing failed', { rawUrl })
    return rawUrl
  }
  if (url.hostname.toLowerCase() !== CLOUD_DISTRIBUTION_HOST) {
    warnSkippedUtm('Skipped UTM tagging because host is not cloud.comfy.org', {
      host: url.hostname,
      rawUrl: url.href,
    })
    return rawUrl
  }

  for (const [key, value] of Object.entries(DEFAULT_UTM_PARAMS)) {
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value)
    }
  }
  return url.href
}
