import fs from 'fs'
import path from 'path'
import { readGitHead } from '../git'
import { scanCustomNodes, nodeKey } from '../nodes'
import { pipFreeze } from '../pip'
import { getUvPath, getActivePythonPath } from '../pythonEnv'
import type { Snapshot, SnapshotEntry } from './types'
import type { InstallationRecord } from '../../installations'
import type { ComfyVersion } from '../version'

// --- Constants ---

const SNAPSHOTS_DIR = path.join('.launcher', 'snapshots')
const MANIFEST_FILE = 'manifest.json'
const AUTO_SNAPSHOT_LIMIT = 200

// --- Per-install mutex ---

const _locks = new Map<string, Promise<void>>()

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (_locks.has(key)) {
    try { await _locks.get(key) } catch {}
  }
  let resolve!: () => void
  const lock = new Promise<void>((r) => (resolve = r))
  _locks.set(key, lock)
  try {
    return await fn()
  } finally {
    _locks.delete(key)
    resolve()
  }
}

// --- Helpers ---

export function snapshotsDir(installPath: string): string {
  return path.join(installPath, SNAPSHOTS_DIR)
}

/**
 * Validate and resolve a snapshot filename to an absolute path.
 * Returns null if the filename is invalid or escapes the snapshots directory.
 */
function resolveSnapshotPath(installPath: string, filename: string): string | null {
  if (!filename || filename !== path.basename(filename)) return null
  if (!filename.endsWith('.json')) return null
  const dir = path.resolve(snapshotsDir(installPath))
  const resolved = path.resolve(dir, filename)
  if (!resolved.startsWith(dir + path.sep)) return null
  return resolved
}

function readManifest(installPath: string): { comfyui_ref: string; version: string; id: string } {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(installPath, MANIFEST_FILE), 'utf8')) as Record<string, string>
    return {
      comfyui_ref: data.comfyui_ref || 'unknown',
      version: data.version || '',
      id: data.id || '',
    }
  } catch {
    return { comfyui_ref: 'unknown', version: '', id: '' }
  }
}

export function formatTimestamp(date: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${pad(date.getMilliseconds(), 3)}`
}

// --- Core functions ---

export async function captureState(installPath: string, installation: InstallationRecord): Promise<Omit<Snapshot, 'createdAt' | 'trigger' | 'label' | 'version'>> {
  const comfyuiDir = path.join(installPath, 'ComfyUI')
  const manifest = readManifest(installPath)
  const commit = readGitHead(comfyuiDir)
  const customNodes = await scanCustomNodes(comfyuiDir)

  let pipPackages: Record<string, string> = {}
  const uvPath = getUvPath(installPath)
  const pythonPath = getActivePythonPath(installation)
  if (fs.existsSync(uvPath) && pythonPath) {
    try {
      pipPackages = await pipFreeze(uvPath, pythonPath)
    } catch (err) {
      console.warn('Snapshot: pip freeze failed:', (err as Error).message)
    }
  }

  const cv = installation.comfyVersion as ComfyVersion | undefined
  // Only carry forward stored version metadata when the commit matches.
  // If the user made external changes (manual git pull, etc.), the stored
  // baseTag/commitsAhead are stale and should not be baked into the snapshot.
  const commitMatches = cv?.commit === commit
  return {
    comfyui: {
      ref: manifest.comfyui_ref,
      commit,
      releaseTag: manifest.version,
      variant: manifest.id,
      baseTag: commitMatches ? cv?.baseTag : undefined,
      commitsAhead: commitMatches ? cv?.commitsAhead : undefined,
    },
    customNodes,
    pipPackages,
    pythonVersion: (installation.pythonVersion as string | undefined) || undefined,
    updateChannel: (installation.updateChannel as string | undefined) || 'stable',
  }
}

export function statesMatch(a: Snapshot, b: Omit<Snapshot, 'createdAt' | 'trigger' | 'label' | 'version'>): boolean {
  // ComfyUI version/commit
  if (a.comfyui.ref !== b.comfyui.ref || a.comfyui.commit !== b.comfyui.commit) return false

  // Custom nodes — compare by nodeKey (type:dirName)
  if (a.customNodes.length !== b.customNodes.length) return false
  const aNodes = new Map(a.customNodes.map((n) => [nodeKey(n), n]))
  for (const bn of b.customNodes) {
    const an = aNodes.get(nodeKey(bn))
    if (!an) return false
    if (an.type !== bn.type || an.version !== bn.version || an.commit !== bn.commit || an.enabled !== bn.enabled) return false
  }

  // Pip packages
  const aKeys = Object.keys(a.pipPackages)
  const bKeys = Object.keys(b.pipPackages)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a.pipPackages[key] !== b.pipPackages[key]) return false
  }

  return true
}

async function writeSnapshot(
  installPath: string,
  data: Omit<Snapshot, 'createdAt' | 'version'> & { trigger: Snapshot['trigger']; label: string | null }
): Promise<string> {
  const now = new Date()
  const snapshot: Snapshot = {
    version: 1,
    createdAt: now.toISOString(),
    trigger: data.trigger,
    label: data.label,
    comfyui: data.comfyui,
    customNodes: data.customNodes,
    pipPackages: data.pipPackages,
    pythonVersion: data.pythonVersion,
    updateChannel: data.updateChannel,
  }

  const dir = snapshotsDir(installPath)
  await fs.promises.mkdir(dir, { recursive: true })
  const suffix = Math.random().toString(16).slice(2, 8)
  const filename = `${formatTimestamp(now)}-${data.trigger}-${suffix}.json`
  const filePath = path.join(dir, filename)
  const tmpPath = `${filePath}.${suffix}.tmp`
  await fs.promises.writeFile(tmpPath, JSON.stringify(snapshot, null, 2))
  await fs.promises.rename(tmpPath, filePath)
  return filename
}

export async function listSnapshots(installPath: string): Promise<SnapshotEntry[]> {
  const dir = snapshotsDir(installPath)
  try {
    const files = await fs.promises.readdir(dir)
    const jsonFiles = files.filter((f) => f.endsWith('.json'))
    const results = await Promise.all(
      jsonFiles.map(async (file) => {
        try {
          const content = await fs.promises.readFile(path.join(dir, file), 'utf-8')
          return { filename: file, snapshot: JSON.parse(content) as Snapshot }
        } catch (err) {
          console.warn(`Snapshot: failed to read ${file}:`, (err as Error).message)
          return null
        }
      })
    )
    const entries = results.filter((e): e is SnapshotEntry => e !== null)
    // Sort newest first
    entries.sort((a, b) => b.snapshot.createdAt.localeCompare(a.snapshot.createdAt))
    return entries
  } catch {
    return []
  }
}



export async function loadSnapshot(installPath: string, filename: string): Promise<Snapshot> {
  const filePath = resolveSnapshotPath(installPath, filename)
  if (!filePath) throw new Error(`Invalid snapshot filename: ${filename}`)
  const content = await fs.promises.readFile(filePath, 'utf-8')
  return JSON.parse(content) as Snapshot
}

export async function deleteSnapshot(installPath: string, filename: string): Promise<void> {
  const filePath = resolveSnapshotPath(installPath, filename)
  if (!filePath) throw new Error(`Invalid snapshot filename: ${filename}`)
  await fs.promises.unlink(filePath)
}

/** Recompute snapshot count from disk. */
export async function getSnapshotCount(installPath: string): Promise<number> {
  return (await listSnapshots(installPath)).length
}

/**
 * After saving a restart snapshot, check if the immediately previous snapshot
 * was an intermediate restart from the same Manager install sequence (same nodes
 * and ComfyUI version, only pip packages differ). If so, delete it — the new
 * snapshot supersedes it with the fully-installed state.
 */
async function deduplicateRestartSnapshot(installPath: string, justSavedFilename: string): Promise<string | undefined> {
  const entries = await listSnapshots(installPath)

  const savedIdx = entries.findIndex((e) => e.filename === justSavedFilename)
  if (savedIdx < 0 || savedIdx >= entries.length - 1) return undefined

  const saved = entries[savedIdx]!
  const prev = entries[savedIdx + 1]!

  // Only deduplicate against unlabeled restart snapshots
  if (prev.snapshot.trigger !== 'restart' || prev.snapshot.label) return undefined

  // ComfyUI version must match
  if (prev.snapshot.comfyui.ref !== saved.snapshot.comfyui.ref ||
      prev.snapshot.comfyui.commit !== saved.snapshot.comfyui.commit) return undefined

  // Custom nodes must match exactly (same set, same versions)
  if (prev.snapshot.customNodes.length !== saved.snapshot.customNodes.length) return undefined
  const prevNodes = new Map(prev.snapshot.customNodes.map((n) => [nodeKey(n), n]))
  for (const node of saved.snapshot.customNodes) {
    const pn = prevNodes.get(nodeKey(node))
    if (!pn) return undefined
    if (pn.type !== node.type || pn.version !== node.version || pn.commit !== node.commit || pn.enabled !== node.enabled) return undefined
  }

  // Previous snapshot is an intermediate restart — remove it
  await deleteSnapshot(installPath, prev.filename)
  return prev.filename
}

export async function captureSnapshotIfChanged(
  installPath: string,
  installation: InstallationRecord,
  trigger: 'boot' | 'restart' | 'manual' | 'pre-update' | 'post-update' | 'post-restore'
): Promise<{ saved: boolean; filename?: string; deduplicated?: string }> {
  return withLock(installPath, async () => {
    const current = await captureState(installPath, installation)

    // Load last snapshot for comparison
    const lastFilename = installation.lastSnapshot as string | undefined
    if (lastFilename && trigger === 'boot') {
      try {
        const last = await loadSnapshot(installPath, lastFilename)
        if (statesMatch(last, current)) {
          return { saved: false }
        }
      } catch {
        // Last snapshot unreadable — save a new one
      }
    }

    const filename = await writeSnapshot(installPath, { ...current, trigger, label: null })

    // Deduplicate: if this is a restart snapshot, remove the previous intermediate
    // restart that captured state before pip packages were installed.
    let deduplicated: string | undefined
    if (trigger === 'restart') {
      deduplicated = await deduplicateRestartSnapshot(installPath, filename).catch(() => undefined)
    }

    // Prune old auto snapshots
    await pruneAutoSnapshots(installPath, AUTO_SNAPSHOT_LIMIT).catch(() => {})

    return { saved: true, filename, deduplicated }
  })
}

export async function saveSnapshot(
  installPath: string,
  installation: InstallationRecord,
  trigger: 'boot' | 'restart' | 'manual' | 'pre-update' | 'post-update' | 'post-restore',
  label?: string
): Promise<string> {
  return withLock(installPath, async () => {
    const current = await captureState(installPath, installation)
    return writeSnapshot(installPath, { ...current, trigger, label: label || null })
  })
}

export async function deduplicatePreUpdateSnapshot(installPath: string, preUpdateFilename: string): Promise<boolean> {
  const entries = await listSnapshots(installPath)
  const idx = entries.findIndex((e) => e.filename === preUpdateFilename)
  if (idx < 0 || idx >= entries.length - 1) return false

  const preUpdate = entries[idx]!
  if (preUpdate.snapshot.trigger !== 'pre-update') return false

  const prev = entries[idx + 1]!
  if (statesMatch(preUpdate.snapshot, prev.snapshot)) {
    await deleteSnapshot(installPath, preUpdateFilename)
    return true
  }
  return false
}

export async function pruneAutoSnapshots(installPath: string, keep: number): Promise<number> {
  const entries = await listSnapshots(installPath)
  const autoSnapshots = entries.filter((e) => (e.snapshot.trigger === 'boot' || e.snapshot.trigger === 'restart') && !e.snapshot.label)
  if (autoSnapshots.length <= keep) return 0

  const toDelete = autoSnapshots.slice(keep)
  let deleted = 0
  for (const entry of toDelete) {
    try {
      await deleteSnapshot(installPath, entry.filename)
      deleted++
    } catch (err) {
      console.warn(`Snapshot: failed to prune ${entry.filename}:`, (err as Error).message)
    }
  }
  return deleted
}
