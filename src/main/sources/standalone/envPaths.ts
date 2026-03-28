import fs from 'fs'
import path from 'path'
export {
  getUvPath, getActivePythonPath, getVenvDir, getVenvPythonPath,
} from '../../lib/pythonEnv'
export const MANIFEST_FILE = 'manifest.json'
export const DEFAULT_LAUNCH_ARGS = '--enable-manager'

const VARIANT_LABELS: Record<string, string> = {
  'nvidia': 'NVIDIA',
  'intel-xpu': 'Intel Arc (XPU)',
  'amd': 'AMD',
  'cpu': 'CPU',
  'mps': 'Apple Silicon (MPS)',
}

export const PLATFORM_PREFIX: Record<string, string> = {
  win32: 'win-',
  darwin: 'mac-',
  linux: 'linux-',
}

export function stripPlatform(variantId: string): string {
  return variantId.replace(/^(win|mac|linux)-/, '')
}

export function getVariantLabel(variantId: string): string {
  const stripped = stripPlatform(variantId)
  if (VARIANT_LABELS[stripped]) return VARIANT_LABELS[stripped]!
  for (const [key, label] of Object.entries(VARIANT_LABELS)) {
    if (stripped === key || stripped.startsWith(key + '-')) {
      const suffix = stripped.slice(key.length + 1)
      return suffix ? `${label} (${suffix.toUpperCase()})` : label
    }
  }
  return stripped
}

export function findSitePackages(envRoot: string): string | null {
  if (process.platform === 'win32') {
    return path.join(envRoot, 'Lib', 'site-packages')
  }
  const libDir = path.join(envRoot, 'lib')
  try {
    const pyDir = fs.readdirSync(libDir).find((d) => d.startsWith('python'))
    if (pyDir) return path.join(libDir, pyDir, 'site-packages')
  } catch {}
  return null
}

export function getMasterPythonPath(installPath: string): string {
  if (process.platform === 'win32') {
    return path.join(installPath, 'standalone-env', 'python.exe')
  }
  return path.join(installPath, 'standalone-env', 'bin', 'python3')
}

export function recommendVariant(variantId: string, gpu: string | undefined): boolean {
  const stripped = stripPlatform(variantId)
  if (!gpu) return stripped === 'cpu'
  if (gpu === 'nvidia') return stripped === 'nvidia' || stripped.startsWith('nvidia-')
  if (gpu === 'amd') return stripped === 'amd' || stripped.startsWith('amd-')
  if (gpu === 'mps') return stripped === 'mps' || stripped.startsWith('mps-')
  if (gpu === 'intel') return stripped === 'intel-xpu' || stripped.startsWith('intel-xpu-')
  return false
}
