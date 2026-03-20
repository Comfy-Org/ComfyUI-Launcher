import fs from 'fs'
import path from 'path'
import * as installations from '../installations'
import * as settings from '../settings'
import sources from '../sources/index'
import type { InstallationRecord } from '../installations'
import { findComfyUIDir, mergeDirFlat } from './migrate'

interface OemManifestFile {
  version?: unknown
  modelDirs?: unknown
  workflowDirs?: unknown
}

interface ResolvedOemManifest {
  modelDirs: string[]
  workflowDirs: string[]
}

const OEM_DIR_NAME = 'ComfyUI Desktop 2.0'
const OEM_WORKFLOW_IMPORT_VERSION = 1
const sourceMap = Object.fromEntries(sources.map((source) => [source.id, source]))

function pathKey(dirPath: string): string {
  const resolved = path.resolve(dirPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const dirPath of paths) {
    const key = pathKey(dirPath)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(path.resolve(dirPath))
  }
  return result
}

function toPathList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
}

function resolveInsideRoot(root: string, maybeRelativePath: string): string | null {
  const resolved = path.resolve(root, maybeRelativePath)
  const relative = path.relative(root, resolved)
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved
  }
  return null
}

async function loadExistingDirs(root: string, values: string[]): Promise<string[]> {
  const resolvedDirs: string[] = []
  for (const value of values) {
    const resolved = resolveInsideRoot(root, value)
    if (!resolved) continue
    try {
      const stat = await fs.promises.stat(resolved)
      if (stat.isDirectory()) resolvedDirs.push(resolved)
    } catch {}
  }
  return uniquePaths(resolvedDirs)
}

function applyManagedModelDirs(managedModelDirs: string[]): void {
  const current = (settings.get('modelsDirs') as string[] | undefined) || [...settings.defaults.modelsDirs]
  const previousManaged = (settings.get('oemManagedModelDirs') as string[] | undefined) || []
  const previousKeys = new Set(previousManaged.map(pathKey))
  const retained = current.filter((dirPath) => !previousKeys.has(pathKey(dirPath)))
  const next = uniquePaths([...retained, ...managedModelDirs])

  if (next.length !== current.length || next.some((dirPath, index) => pathKey(dirPath) !== pathKey(current[index]!))) {
    settings.set('modelsDirs', next)
  }
  settings.set('oemManagedModelDirs', managedModelDirs.length > 0 ? managedModelDirs : undefined)
}

function isPromotableLocalInstall(installation: InstallationRecord): boolean {
  const source = sourceMap[installation.sourceId]
  return !!source && source.category === 'local' && installation.sourceId !== 'desktop'
}

async function importWorkflowsForInstalls(manifest: ResolvedOemManifest | null): Promise<void> {
  if (!manifest || manifest.workflowDirs.length === 0) return
  const currentVersion = settings.get('oemWorkflowImportVersion') as number | undefined
  if (currentVersion === OEM_WORKFLOW_IMPORT_VERSION) return

  const candidates = (await installations.list())
    .filter(isPromotableLocalInstall)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  if (candidates.length === 0) return

  const target = candidates.find((installation) => !!findComfyUIDir(installation.installPath)) || null
  if (!target) return

  const comfyDir = findComfyUIDir(target.installPath)
  if (!comfyDir) return

  const destWorkflows = path.join(comfyDir, 'user', 'default', 'workflows')
  for (const workflowDir of manifest.workflowDirs) {
    await mergeDirFlat(workflowDir, destWorkflows)
  }

  settings.set('oemWorkflowImportVersion', OEM_WORKFLOW_IMPORT_VERSION)
}

async function loadManifest(): Promise<ResolvedOemManifest | null> {
  const root = getOemRoot()
  if (!root) return null

  let raw: string
  try {
    raw = await fs.promises.readFile(path.join(root, 'manifest.json'), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }

  let parsed: OemManifestFile
  try {
    parsed = JSON.parse(raw) as OemManifestFile
  } catch {
    return null
  }

  if (parsed.version !== 1) return null

  const modelDirs = await loadExistingDirs(root, toPathList(parsed.modelDirs))
  const workflowDirs = await loadExistingDirs(root, toPathList(parsed.workflowDirs))

  return { modelDirs, workflowDirs }
}

export function getOemRoot(): string | null {
  if (process.platform !== 'win32') return null
  const programData = process.env.ProgramData
  if (!programData) return null
  return path.join(programData, OEM_DIR_NAME, 'OEM')
}

export async function syncOemSeed(): Promise<void> {
  const manifest = await loadManifest()

  applyManagedModelDirs(manifest?.modelDirs || [])
  await importWorkflowsForInstalls(manifest)
}
