const SUPPORT_BASE_URL = 'https://support.comfy.org/hc/en-us/requests/new'

const ZENDESK_DISTRIBUTION_FIELD = 'tf_42243568391700'

export function buildSupportUrl(): string {
  const searchParams = new URLSearchParams({
    [ZENDESK_DISTRIBUTION_FIELD]: 'launcher',
  })
  return `${SUPPORT_BASE_URL}?${searchParams.toString()}`
}
