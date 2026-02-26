import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { DiskSpaceInfo, PathIssue } from '../../types/ipc'
import * as settings from '../settings'
import * as installations from '../installations'

/**
 * Get free and total disk space for the volume containing `targetPath`.
 * Walks up the path tree until it finds an existing directory to stat.
 * Works on Windows, macOS, and Linux via Node's fs.statfs.
 */
export async function getDiskSpace(targetPath: string): Promise<DiskSpaceInfo> {
  let dir = path.resolve(targetPath)

  // Walk up until we find a directory that exists
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const stats = await fs.promises.statfs(dir)
  return {
    free: stats.bavail * stats.bsize,
    total: stats.blocks * stats.bsize,
  }
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p)
  // Case-insensitive on Windows and macOS
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved
}

function isPathInside(candidate: string, parent: string): boolean {
  if (candidate === parent) return true
  const relative = path.relative(parent, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Build the set of restricted paths that installations must not be placed inside.
 * Covers the Electron app bundle/install directory and (on Windows) the
 * auto-updater cache directories.
 */
function getRestrictedPaths(): { path: string; issue: PathIssue }[] {
  const entries: { path: string; issue: PathIssue }[] = []
  const seen = new Set<string>()

  const add = (issue: PathIssue, rawPath?: string): void => {
    if (!rawPath) return
    const normalized = normalizePath(rawPath)
    if (seen.has(normalized)) return
    seen.add(normalized)
    entries.push({ path: normalized, issue })
  }

  // App install directory
  const exePath = app.getPath('exe')
  if (process.platform === 'darwin') {
    // Walk up to the .app bundle
    let current = exePath
    while (current && current !== '/' && !current.endsWith('.app')) {
      const next = path.dirname(current)
      if (next === current) break
      current = next
    }
    add('insideAppBundle', current.endsWith('.app') ? current : path.dirname(exePath))
  } else {
    add('insideAppBundle', path.dirname(exePath))
  }

  // Resources directory (contains app.asar)
  add('insideAppBundle', process.resourcesPath)

  // User data directory (config, databases, etc.)
  add('insideAppBundle', app.getPath('userData'))

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      // Updater cache directories (wiped on auto-update)
      add('insideAppBundle', path.join(localAppData, 'comfyui-launcher-updater'))
      add('insideAppBundle', path.join(localAppData, '@comfyorgcomfyui-launcher-updater'))
    }

    // OneDrive (personal, business, and generic env vars)
    add('oneDrive', process.env.OneDrive)
    add('oneDrive', process.env.OneDriveCommercial)
    add('oneDrive', process.env.OneDriveConsumer)
  }

  // Shared models, input, and output directories
  const s = settings.getAll()
  for (const dir of s.modelsDirs) {
    add('insideSharedDir', dir)
  }
  add('insideSharedDir', s.inputDir)
  add('insideSharedDir', s.outputDir)

  return entries
}

/**
 * Check whether a target path is inside a restricted location.
 * Returns the list of issues found, or an empty array if the path is safe.
 */
export async function validateInstallPath(targetPath: string): Promise<PathIssue[]> {
  const normalized = normalizePath(targetPath)
  const issues: PathIssue[] = []
  const seen = new Set<PathIssue>()

  for (const restricted of getRestrictedPaths()) {
    if (!seen.has(restricted.issue) && isPathInside(normalized, restricted.path)) {
      issues.push(restricted.issue)
      seen.add(restricted.issue)
    }
  }

  // Check against existing installation paths
  if (!seen.has('insideExistingInstall')) {
    const existing = await installations.list()
    for (const inst of existing) {
      if (!inst.installPath) continue
      const instNorm = normalizePath(inst.installPath)
      if (isPathInside(normalized, instNorm)) {
        issues.push('insideExistingInstall')
        break
      }
    }
  }

  return issues
}
