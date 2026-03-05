import path from 'path'
import fs from 'fs'
import { configDir, cacheDir, homeDir } from './lib/paths'
import { MODEL_FOLDER_TYPES } from './lib/models'
import { readFileSafe, writeFileSafe } from './lib/safe-file'

export interface KnownSettings {
  cacheDir: string
  maxCachedFiles: number
  onLauncherClose: 'tray' | 'quit'
  modelsDirs: string[]
  inputDir: string
  outputDir: string
  language?: string
  theme?: string
  autoUpdate?: boolean
  primaryInstallId?: string
  pinnedInstallIds?: string[]
}

export type Settings = KnownSettings & Record<string, unknown>

type DefaultedSettingKey =
  | 'cacheDir'
  | 'maxCachedFiles'
  | 'onLauncherClose'
  | 'modelsDirs'
  | 'inputDir'
  | 'outputDir'
type SettingsDefaults = Pick<KnownSettings, DefaultedSettingKey>

const dataPath = path.join(configDir(), "settings.json")

const SHARED_ROOT = path.join(homeDir(), "ComfyUI-Shared")

const SETTINGS_SCHEMA = {
  cacheDir: { nullable: false },
  maxCachedFiles: { nullable: false },
  onLauncherClose: { nullable: false },
  modelsDirs: { nullable: false },
  inputDir: { nullable: false },
  outputDir: { nullable: false },
  language: { nullable: false },
  theme: { nullable: false },
  autoUpdate: { nullable: false },
  primaryInstallId: { nullable: false },
  pinnedInstallIds: { nullable: false },
} as const satisfies Record<keyof KnownSettings, { nullable: boolean }>

export type KnownSettingKey = keyof typeof SETTINGS_SCHEMA
export type NullableKnownSettingKey = {
  [K in KnownSettingKey]-?: (typeof SETTINGS_SCHEMA)[K]['nullable'] extends true ? K : never
}[KnownSettingKey]

const KNOWN_SETTING_KEYS = Object.keys(SETTINGS_SCHEMA) as KnownSettingKey[]

function isKnownSettingKey(key: string): key is KnownSettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key)
}

function isNullableKnownSettingKey(key: KnownSettingKey): key is NullableKnownSettingKey {
  return SETTINGS_SCHEMA[key].nullable
}

export const defaults: SettingsDefaults = {
  cacheDir: path.join(cacheDir(), "download-cache"),
  maxCachedFiles: 5,
  onLauncherClose: "tray",
  modelsDirs: [path.join(SHARED_ROOT, "models")],
  inputDir: path.join(SHARED_ROOT, "input"),
  outputDir: path.join(SHARED_ROOT, "output"),
}

const systemDefault = defaults.modelsDirs[0]!

function load(): Settings {
  let parsed: Record<string, unknown> | null = null
  const raw = readFileSafe(dataPath)
  if (raw) {
    try {
      const obj: unknown = JSON.parse(raw)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsed = obj as Record<string, unknown>
    } catch {}
  }
  if (parsed) {
    for (const key of KNOWN_SETTING_KEYS) {
      if (parsed[key] === null && !isNullableKnownSettingKey(key)) {
        delete parsed[key]
      }
    }
  }
  const result: Settings = { ...defaults, ...(parsed || {}) }
  // Ensure system default directory is always present in modelsDirs
  if (!Array.isArray(result.modelsDirs)) {
    result.modelsDirs = [systemDefault]
  } else if (!result.modelsDirs.some((d) => path.resolve(d) === path.resolve(systemDefault))) {
    result.modelsDirs.unshift(systemDefault)
  }
  // Create the system default directory and model subdirectories on disk
  try {
    fs.mkdirSync(systemDefault, { recursive: true })
    for (const folder of MODEL_FOLDER_TYPES) {
      fs.mkdirSync(path.join(systemDefault, folder), { recursive: true })
    }
  } catch {}
  // Create shared input/output directories
  try {
    for (const key of ["inputDir", "outputDir"] as const) {
      const dir = (result[key] as string | undefined) || defaults[key]
      fs.mkdirSync(dir, { recursive: true })
    }
  } catch {}
  return result
}

function save(settings: Settings): void {
  writeFileSafe(dataPath, JSON.stringify(settings, null, 2), true)
}

export function get<K extends KnownSettingKey>(key: K): KnownSettings[K]
export function get(key: string): unknown
export function get(key: string): unknown {
  return load()[key]
}

export function set<K extends string>(
  key: K,
  value: K extends KnownSettingKey ? KnownSettings[K] | undefined : unknown
): void {
  const settings = load()
  // `undefined` is the canonical "unset/default" value in settings.
  // For known non-nullable keys, treat `null` the same way.
  if (
    value === undefined
    || (value === null && isKnownSettingKey(key) && !isNullableKnownSettingKey(key))
  ) {
    delete settings[key]
    save(settings)
    return
  }
  settings[key] = value
  save(settings)
}

export function getAll(): Settings {
  return load()
}
