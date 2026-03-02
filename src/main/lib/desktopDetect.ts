import fs from 'fs'
import path from 'path'
import { homedir } from 'os'

export interface DesktopInstallInfo {
  configDir: string
  basePath: string
  executablePath: string | null
  hasVenv: boolean
}

function getDesktopConfigDir(): string | null {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) return null
    return path.join(appData, 'ComfyUI')
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'ComfyUI')
  }
  return null
}

export function findDesktopExecutable(): string | null {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (!localAppData) return null
    const candidate = path.join(localAppData, 'Programs', 'ComfyUI', 'ComfyUI.exe')
    if (fs.existsSync(candidate)) return candidate
    return null
  }
  if (process.platform === 'darwin') {
    const candidate = '/Applications/ComfyUI.app'
    if (fs.existsSync(candidate)) return candidate
    return null
  }
  return null
}

export function detectDesktopInstall(): DesktopInstallInfo | null {
  const configDir = getDesktopConfigDir()
  if (!configDir) return null

  const configPath = path.join(configDir, 'config.json')
  let basePath: string
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const config = JSON.parse(raw) as Record<string, unknown>
    if (typeof config.basePath !== 'string' || !config.basePath) return null
    basePath = config.basePath
  } catch {
    return null
  }

  if (!fs.existsSync(basePath)) return null

  const hasModels = fs.existsSync(path.join(basePath, 'models'))
  const hasUser = fs.existsSync(path.join(basePath, 'user'))
  if (!hasModels || !hasUser) return null

  return {
    configDir,
    basePath,
    executablePath: findDesktopExecutable(),
    hasVenv: fs.existsSync(path.join(basePath, '.venv')),
  }
}
