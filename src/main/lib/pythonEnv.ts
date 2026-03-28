import fs from 'fs'
import path from 'path'
import type { InstallationRecord } from '../installations'

export function getUvPath(installPath: string): string {
  if (process.platform === 'win32') {
    return path.join(installPath, 'standalone-env', 'uv.exe')
  }
  return path.join(installPath, 'standalone-env', 'bin', 'uv')
}

export function getVenvDir(installPath: string): string {
  return path.join(installPath, 'ComfyUI', '.venv')
}

export function getVenvPythonPath(installPath: string): string {
  const venvDir = getVenvDir(installPath)
  if (process.platform === 'win32') {
    return path.join(venvDir, 'Scripts', 'python.exe')
  }
  return path.join(venvDir, 'bin', 'python3')
}

export function getActivePythonPath(installation: InstallationRecord): string | null {
  const pythonPath = getVenvPythonPath(installation.installPath)
  if (fs.existsSync(pythonPath)) return pythonPath
  // Fallback: legacy envs/default/ layout (pre-migration)
  const legacyPath = process.platform === 'win32'
    ? path.join(installation.installPath, 'envs', 'default', 'Scripts', 'python.exe')
    : path.join(installation.installPath, 'envs', 'default', 'bin', 'python3')
  if (fs.existsSync(legacyPath)) return legacyPath
  return null
}
