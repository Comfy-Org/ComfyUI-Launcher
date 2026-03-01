import path from 'path'
import fs from 'fs'
import { configDir, cacheDir, homeDir } from './lib/paths'
import { MODEL_FOLDER_TYPES } from './lib/models'

export interface Settings {
  cacheDir: string
  maxCachedFiles: number
  onLauncherClose: string
  modelsDirs: string[]
  inputDir: string
  outputDir: string
  [key: string]: unknown
}

const dataPath = path.join(configDir(), "settings.json")
const backupPath = dataPath + ".bak"
const tmpPath = dataPath + ".tmp"

const SHARED_ROOT = path.join(homeDir(), "ComfyUI-Shared")

export const defaults: Settings = {
  cacheDir: path.join(cacheDir(), "download-cache"),
  maxCachedFiles: 5,
  onLauncherClose: "tray",
  modelsDirs: [path.join(SHARED_ROOT, "models")],
  inputDir: path.join(SHARED_ROOT, "input"),
  outputDir: path.join(SHARED_ROOT, "output"),
}

const systemDefault = defaults.modelsDirs[0]!

function parseSettings(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {}
  return null
}

function load(): Settings {
  let parsed = parseSettings((() => { try { return fs.readFileSync(dataPath, "utf-8") } catch { return "" } })())
  if (!parsed) {
    // Primary file missing or corrupt — try backup
    parsed = parseSettings((() => { try { return fs.readFileSync(backupPath, "utf-8") } catch { return "" } })())
    if (parsed) {
      try { fs.copyFileSync(backupPath, dataPath) } catch {}
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
  fs.mkdirSync(path.dirname(dataPath), { recursive: true })
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2))
  try { fs.copyFileSync(dataPath, backupPath) } catch {}
  fs.renameSync(tmpPath, dataPath)
}

export function get(key: string): unknown {
  return load()[key]
}

export function set(key: string, value: unknown): void {
  const settings = load()
  settings[key] = value
  save(settings)
}

export function getAll(): Settings {
  return load()
}
