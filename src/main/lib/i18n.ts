import path from 'path'
import fs from 'fs'

interface Messages {
  [key: string]: string | Messages
}

interface LocaleInfo {
  value: string
  label: string
}

const localesDir = path.join(__dirname, '..', '..', 'locales')

let currentLocale = 'en'
let fallback: Messages = {}
let messages: Messages = {}

function loadLocaleFile(locale: string): Messages | null {
  const filePath = path.join(localesDir, `${locale}.json`)
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function deepMerge(base: Messages, override: Messages): Messages {
  const result: Messages = { ...base }
  for (const key of Object.keys(override)) {
    const resultVal = result[key]
    const overrideVal = override[key]
    if (
      typeof resultVal === 'object' &&
      resultVal !== null &&
      typeof overrideVal === 'object' &&
      overrideVal !== null
    ) {
      result[key] = deepMerge(resultVal as Messages, overrideVal as Messages)
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal
    }
  }
  return result
}

function init(locale?: string): void {
  currentLocale = locale || 'en'
  fallback = loadLocaleFile('en') || {}
  const localeMessages = currentLocale !== 'en' ? loadLocaleFile(currentLocale) : null
  if (currentLocale !== 'en' && !localeMessages) {
    currentLocale = 'en'
  }
  messages = localeMessages ? deepMerge(fallback, localeMessages) : fallback
}

function t(key: string, params?: Record<string, string | number>): string {
  const parts = key.split('.')
  let val: Messages | string | undefined = messages
  for (const p of parts) {
    if (val == null || typeof val !== 'object') return key
    val = val[p]
  }
  if (typeof val !== 'string') return key
  if (params) {
    return val.replace(/\{(\w+)\}/g, (_, k: string) => {
      const replacement = params[k]
      return replacement !== undefined ? String(replacement) : `{${k}}`
    })
  }
  return val
}

function getMessages(): Messages {
  return messages
}

function getLocale(): string {
  return currentLocale
}

function getAvailableLocales(): LocaleInfo[] {
  try {
    const files = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'))
    return files.map((f) => {
      const loc = f.replace(/\.json$/, '')
      const data = loadLocaleFile(loc)
      return { value: loc, label: (data && data._label as string) || loc }
    })
  } catch {
    return []
  }
}

export { init, t, getMessages, getLocale, getAvailableLocales }
export type { Messages, LocaleInfo }
