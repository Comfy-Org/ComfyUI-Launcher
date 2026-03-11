import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { dataDir } from './paths'

export type InstallationScope = 'user' | 'machine'

const WINDOWS_MACHINE_ROOT = 'ComfyUI Launcher'
const USER_SEED_MARKER = '.machine-user-seeded'

export function normalizeInstallationScope(value: unknown): InstallationScope {
  return value === 'machine' ? 'machine' : 'user'
}

export function isMachineScope(value: unknown): boolean {
  return normalizeInstallationScope(value) === 'machine'
}

export function machineDataDir(): string {
  if (process.platform === 'win32') {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData'
    return path.join(programData, WINDOWS_MACHINE_ROOT)
  }

  return path.join(app.getPath('home'), '.local', 'share', 'comfyui-launcher-machine')
}

export function resolveMachineUserDir(installationId: string): string {
  return path.join(dataDir(), 'machine-installs', installationId, 'user')
}

function isEffectivelyEmptyDir(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath)
    return entries.length === 0 || entries.every((entry) => entry === USER_SEED_MARKER)
  } catch {
    return true
  }
}

function markSeeded(userDir: string): void {
  fs.mkdirSync(userDir, { recursive: true })
  fs.writeFileSync(path.join(userDir, USER_SEED_MARKER), new Date().toISOString())
}

export function ensureMachineUserDir(seedDir: string | null, userDir: string): void {
  const markerPath = path.join(userDir, USER_SEED_MARKER)
  if (fs.existsSync(markerPath)) {
    fs.mkdirSync(userDir, { recursive: true })
    return
  }

  if (!seedDir || !fs.existsSync(seedDir)) {
    markSeeded(userDir)
    return
  }

  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(path.dirname(userDir), { recursive: true })
    fs.cpSync(seedDir, userDir, { recursive: true })
    markSeeded(userDir)
    return
  }

  if (isEffectivelyEmptyDir(userDir)) {
    fs.rmSync(userDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(userDir), { recursive: true })
    fs.cpSync(seedDir, userDir, { recursive: true })
  }

  markSeeded(userDir)
}
