import './assets/main.css'

import { datadogRum, type RumBeforeSend } from '@datadog/browser-rum'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import App from './App.vue'
import { normalizeRumErrorEvent } from './lib/datadogPathNormalization'
import {
  TELEMETRY_ACTION_EVENT_NAME,
  type TelemetryActionEventDetail,
  type TelemetryContext,
} from './lib/telemetry'

function serializeUnknownError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || 'Error',
      stack: error.stack,
    }
  }
  if (typeof error === 'string') {
    return { message: error }
  }
  if (error === null || error === undefined) {
    return { message: 'Unknown error' }
  }
  try {
    return { message: JSON.stringify(error) }
  } catch {
    return { message: String(error) }
  }
}

function parseSampleRate(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(100, parsed))
}

function isFlagDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'off'].includes((value || '').trim().toLowerCase())
}

type DatadogTrackingConsent = 'granted' | 'not-granted'

const DEFAULT_DATADOG_APPLICATION_ID = '74a97924-20d7-4890-8e55-0c2b87193373'
const DEFAULT_DATADOG_CLIENT_TOKEN = 'pub5b0afc7fe0411fcebad80bb87274d711'
const DEFAULT_DATADOG_SERVICE = 'comfyui-desktop-2'

const datadogClientToken = (
  import.meta.env.VITE_DATADOG_RUM_CLIENT_TOKEN
  || DEFAULT_DATADOG_CLIENT_TOKEN
).trim()
const datadogApplicationId = (
  import.meta.env.VITE_DATADOG_RUM_APPLICATION_ID
  || DEFAULT_DATADOG_APPLICATION_ID
).trim()
const datadogSite = (import.meta.env.VITE_DATADOG_RUM_SITE || 'us5.datadoghq.com').trim()
const datadogService = (import.meta.env.VITE_DATADOG_RUM_SERVICE || DEFAULT_DATADOG_SERVICE).trim()
const datadogEnv = (import.meta.env.VITE_DATADOG_RUM_ENV || 'prod-v2').trim()
const datadogVersion = (import.meta.env.VITE_DATADOG_RUM_VERSION || '').trim()

const isDatadogConfigured = !isFlagDisabled(import.meta.env.VITE_DATADOG_RUM_ENABLED)
  && datadogClientToken.length > 0
  && datadogApplicationId.length > 0

let isDatadogInitialized = false

const datadogBeforeSend: RumBeforeSend = (event) => {
  if (event.type === 'error') {
    normalizeRumErrorEvent(event)
  }
  return true
}

function toDatadogTrackingConsent(enabled: boolean | undefined): DatadogTrackingConsent {
  return enabled === false ? 'not-granted' : 'granted'
}

async function getTelemetryEnabledSetting(): Promise<boolean | undefined> {
  try {
    return await window.api.getSetting('telemetryEnabled') as boolean | undefined
  } catch {
    return undefined
  }
}

function setDatadogTrackingConsent(consent: DatadogTrackingConsent): void {
  if (!isDatadogInitialized) return
  try {
    datadogRum.setTrackingConsent(consent)
  } catch {}
}

function trackTelemetryAction(actionName: string, context: TelemetryContext): void {
  if (!isDatadogInitialized) return
  try {
    datadogRum.addAction(actionName, context)
  } catch {}
}

function handleTelemetryActionBridgeEvent(event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail as TelemetryActionEventDetail | undefined
  if (!detail || typeof detail !== 'object') return
  if (typeof detail.actionName !== 'string' || detail.actionName.length === 0) return
  const context = detail.context && typeof detail.context === 'object' ? detail.context : {}
  trackTelemetryAction(detail.actionName, context)
}


async function initializeDatadog(): Promise<void> {
  if (!isDatadogConfigured) return
  const telemetryEnabled = await getTelemetryEnabledSetting()
  try {
    datadogRum.init({
      applicationId: datadogApplicationId,
      clientToken: datadogClientToken,
      site: datadogSite,
      service: datadogService,
      env: datadogEnv,
      version: datadogVersion || undefined,
      trackingConsent: toDatadogTrackingConsent(telemetryEnabled),
      beforeSend: datadogBeforeSend,
      sessionSampleRate: parseSampleRate(import.meta.env.VITE_DATADOG_RUM_SESSION_SAMPLE_RATE, 100),
      sessionReplaySampleRate: parseSampleRate(import.meta.env.VITE_DATADOG_RUM_SESSION_REPLAY_SAMPLE_RATE, 0),
      trackResources: true,
      trackLongTasks: true,
      trackUserInteractions: true,
    })
    isDatadogInitialized = true
    trackTelemetryAction('launcher.session.started', {
      app_env: datadogEnv,
      app_version: datadogVersion || 'unknown',
      is_packaged: !import.meta.env.DEV,
      telemetry_effective_enabled: telemetryEnabled !== false,
    })
    window.api.getSystemInfo().then((info) => {
      trackTelemetryAction('launcher.session.system_info', info as unknown as Record<string, string | number | boolean | null | undefined>)
    }).catch(() => {})
  } catch {}
}

window.api.onTelemetrySettingChanged((enabled) => {
  if (!isDatadogConfigured) return
  setDatadogTrackingConsent(toDatadogTrackingConsent(enabled))
})

window.addEventListener(TELEMETRY_ACTION_EVENT_NAME, handleTelemetryActionBridgeEvent)

void initializeDatadog()

function reportRendererError(payload: {
  source: string
  message: string
  stack?: string
  context?: Record<string, unknown>
}): void {
  if (!isDatadogInitialized) return
  const error = new Error(payload.message || 'Unknown error')
  if (payload.stack) {
    error.stack = payload.stack
  }
  try {
    datadogRum.addError(error, {
      source: 'custom',
      context: {
        origin: 'renderer',
        forwarded_source: payload.source,
        ...(payload.context || {}),
      },
    })
  } catch {}
}

window.addEventListener('error', (event) => {
  const serialized = serializeUnknownError(event.error || event.message)
  reportRendererError({
    source: 'renderer-window-error',
    message: serialized.message,
    stack: serialized.stack,
    context: {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    },
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const serialized = serializeUnknownError(event.reason)
  reportRendererError({
    source: 'renderer-unhandled-rejection',
    message: serialized.message,
    stack: serialized.stack,
  })
})

window.api.onDatadogError((data) => {
  reportRendererError({
    source: data.source || 'main-forwarded-error',
    message: data.message || 'Unknown forwarded error',
    stack: data.stack,
    context: {
      origin: 'main-process',
      level: data.level,
      ...(data.context || {}),
    },
  })
})

window.api.onInstanceStarted((data) => {
  if (!isDatadogInitialized) return
  window.api.getInstallationDdContext(data.installationId).then((ctx) => {
    if (!ctx) return
    const { snapshot_diffs, ...metadata } = ctx
    trackTelemetryAction('launcher.session.installation_started', metadata as unknown as Record<string, string | number | boolean | null | undefined>)
    if (snapshot_diffs.length > 0) {
      try { datadogRum.addAction('launcher.session.snapshot_history', { installation_id: ctx.installation_id, snapshot_diffs }) } catch {}
    }
  }).catch(() => {})
})

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en: {} },
  missingWarn: false,
  fallbackWarn: false,
})

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.mount('#app')

export { i18n }
