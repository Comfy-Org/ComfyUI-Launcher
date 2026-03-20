import path from 'path'
import fs from 'fs'
import { configDir, cacheDir, homeDir } from './lib/paths'
import { MODEL_FOLDER_TYPES } from './lib/models'
import { readFileSafe, writeFileSafe } from './lib/safe-file'

export interface KnownSettings {
  cacheDir: string
  maxCachedFiles: number
  onAppClose: 'tray' | 'quit'
  modelsDirs: string[]
  inputDir: string
  outputDir: string
  language?: string
  theme?: string
  autoUpdate?: boolean
  pypiMirror?: string
  telemetryEnabled?: boolean
  primaryInstallId?: string
  pinnedInstallIds?: string[]
  oemManagedModelDirs?: string[]
  oemWorkflowImportVersion?: number
}

export type Settings = KnownSettings & Record<string, unknown>

type DefaultedSettingKey =
  | 'cacheDir'
  | 'maxCachedFiles'
  | 'onAppClose'
  | 'modelsDirs'
  | 'inputDir'
  | 'outputDir'
type SettingsDefaults = Pick<KnownSettings, DefaultedSettingKey>

const dataPath = path.join(configDir(), "settings.json")

const SHARED_ROOT = path.join(homeDir(), "ComfyUI-Shared")

const SETTINGS_SCHEMA = {
  cacheDir: { nullable: false },
  maxCachedFiles: { nullable: false },
  onAppClose: { nullable: false },
  modelsDirs: { nullable: false },
  inputDir: { nullable: false },
  outputDir: { nullable: false },
  language: { nullable: false },
  theme: { nullable: false },
  autoUpdate: { nullable: false },
  pypiMirror: { nullable: false },
  telemetryEnabled: { nullable: false },
  primaryInstallId: { nullable: false },
  pinnedInstallIds: { nullable: false },
  oemManagedModelDirs: { nullable: false },
  oemWorkflowImportVersion: { nullable: false },
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
  onAppClose: "tray",
  modelsDirs: [path.join(SHARED_ROOT, "models")],
  inputDir: path.join(SHARED_ROOT, "input"),
  outputDir: path.join(SHARED_ROOT, "output"),
}

const systemDefault = defaults.modelsDirs[0]!
const shouldSanitizeCopiedUserDefaults = process.platform === 'win32'

function resolveIfNonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? path.resolve(value) : null
}

function getRelativeDefaultFromHome(currentDefault: string): string | null {
  const home = path.resolve(homeDir())
  const rel = path.relative(home, path.resolve(currentDefault))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

function isForeignUserDefaultPath(value: unknown, currentDefault: string): boolean {
  const candidate = resolveIfNonEmpty(value)
  if (!candidate) return false

  const currentResolved = path.resolve(currentDefault)
  if (candidate === currentResolved) return false

  const home = path.resolve(homeDir())
  const relativeDefault = getRelativeDefaultFromHome(currentDefault)
  if (!relativeDefault) return false

  let candidateHome = candidate
  for (const _part of relativeDefault.split(path.sep).filter(Boolean)) {
    candidateHome = path.dirname(candidateHome)
  }

  if (candidateHome === home) return false
  if (path.dirname(candidateHome) !== path.dirname(home)) return false

  return path.resolve(path.join(candidateHome, relativeDefault)) === candidate
}

function sanitizeUserDefaultPath(value: unknown, currentDefault: string): string {
  const candidate = resolveIfNonEmpty(value)
  if (!candidate) return currentDefault
  return isForeignUserDefaultPath(candidate, currentDefault) ? currentDefault : candidate
}

function sanitizeModelsDirs(value: unknown, currentDefault: string): string[] {
  const dirs = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const result: string[] = []

  for (const dir of dirs) {
    const candidate = resolveIfNonEmpty(dir)
    if (!candidate) continue
    if (isForeignUserDefaultPath(candidate, currentDefault)) continue
    if (seen.has(candidate)) continue
    seen.add(candidate)
    result.push(candidate)
  }

  // Only inject the system default when the list would otherwise be empty.
  // The user's chosen ordering (and primary path) is preserved.
  if (result.length === 0) {
    result.push(path.resolve(currentDefault))
  }

  return result
}

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
  let changed = false

  if (shouldSanitizeCopiedUserDefaults) {
    const nextCacheDir = sanitizeUserDefaultPath(result.cacheDir, defaults.cacheDir)
    if (nextCacheDir !== result.cacheDir) {
      result.cacheDir = nextCacheDir
      changed = true
    }

    const nextModelsDirs = sanitizeModelsDirs(result.modelsDirs, systemDefault)
    if (
      !Array.isArray(result.modelsDirs)
      || nextModelsDirs.length !== result.modelsDirs.length
      || nextModelsDirs.some((dir, index) => dir !== result.modelsDirs[index])
    ) {
      result.modelsDirs = nextModelsDirs
      changed = true
    }

    const nextInputDir = sanitizeUserDefaultPath(result.inputDir, defaults.inputDir)
    if (nextInputDir !== result.inputDir) {
      result.inputDir = nextInputDir
      changed = true
    }

    const nextOutputDir = sanitizeUserDefaultPath(result.outputDir, defaults.outputDir)
    if (nextOutputDir !== result.outputDir) {
      result.outputDir = nextOutputDir
      changed = true
    }
  }

  // Ensure modelsDirs is a valid array; inject system default only as a fallback
  if (!Array.isArray(result.modelsDirs) || result.modelsDirs.length === 0) {
    result.modelsDirs = [systemDefault]
    changed = true
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
  if (changed) save(result)
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

/** Keys whose values should be deleted when set to an empty or whitespace-only string. */
const EMPTY_STRING_MEANS_UNSET: ReadonlySet<string> = new Set<KnownSettingKey>(['pypiMirror'])

export function set<K extends string>(
  key: K,
  value: K extends KnownSettingKey ? KnownSettings[K] | undefined : unknown
): void {
  const settings = load()
  // `undefined` is the canonical "unset/default" value in settings.
  // For known non-nullable keys, treat `null` the same way.
  // For string keys in EMPTY_STRING_MEANS_UNSET, treat '' / whitespace as unset.
  if (
    value === undefined
    || (value === null && isKnownSettingKey(key) && !isNullableKnownSettingKey(key))
    || (typeof value === 'string' && value.trim() === '' && EMPTY_STRING_MEANS_UNSET.has(key))
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
