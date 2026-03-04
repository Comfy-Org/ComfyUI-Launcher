import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import App from './App.vue'

interface DatadogRumApi {
  init(config: Record<string, unknown>): void
  addError(error: unknown, context?: Record<string, unknown>): void
}

function getDatadogRum(): DatadogRumApi | null {
  return ((window as Window & { DD_RUM?: DatadogRumApi }).DD_RUM || null)
}

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

const datadogClientToken = (import.meta.env.VITE_DATADOG_RUM_CLIENT_TOKEN || '').trim()
const datadogApplicationId = (import.meta.env.VITE_DATADOG_RUM_APPLICATION_ID || '').trim()
const datadogSite = (import.meta.env.VITE_DATADOG_RUM_SITE || 'us5.datadoghq.com').trim()
const datadogService = (import.meta.env.VITE_DATADOG_RUM_SERVICE || 'comfyui-launcher').trim()
const datadogEnv = (import.meta.env.VITE_DATADOG_RUM_ENV || 'prod-v2').trim()

const isDatadogEnabled = !isFlagDisabled(import.meta.env.VITE_DATADOG_RUM_ENABLED)
  && datadogClientToken.length > 0
  && datadogApplicationId.length > 0

let datadogRum: DatadogRumApi | null = null
if (isDatadogEnabled) {
  datadogRum = getDatadogRum()
}

if (isDatadogEnabled && datadogRum) {
  datadogRum.init({
    applicationId: datadogApplicationId,
    clientToken: datadogClientToken,
    site: datadogSite,
    service: datadogService,
    env: datadogEnv,
    sessionSampleRate: parseSampleRate(import.meta.env.VITE_DATADOG_RUM_SESSION_SAMPLE_RATE, 100),
    sessionReplaySampleRate: parseSampleRate(import.meta.env.VITE_DATADOG_RUM_SESSION_REPLAY_SAMPLE_RATE, 0),
    trackResources: true,
    trackLongTasks: true,
    trackUserInteractions: true,
  })
}

function reportRendererError(payload: {
  source: string
  message: string
  stack?: string
  context?: Record<string, unknown>
}): void {
  if (!isDatadogEnabled || !datadogRum) return
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
        ...payload.context,
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
