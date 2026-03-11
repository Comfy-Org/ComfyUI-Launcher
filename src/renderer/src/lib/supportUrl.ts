const FEEDBACK_URL = 'https://form.typeform.com/to/VhOXmuaL'

function detectPlatform(): string {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('win')) return 'windows'
  if (ua.includes('mac')) return 'mac'
  if (ua.includes('linux')) return 'linux'
  return 'unknown'
}

export function buildSupportUrl(version?: string): string {
  const url = new URL(FEEDBACK_URL)
  if (version) url.searchParams.set('ver', version)
  url.searchParams.set('platform', detectPlatform())
  return url.toString()
}
