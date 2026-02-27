import fs from 'fs'
import path from 'path'
import { scanCustomNodes } from './nodes'
import { pipFreeze } from './pip'
import type { ScannedNode } from './nodes'
import type { InstallationRecord } from '../installations'

// --- Types ---

export interface Snapshot {
  version: 1
  createdAt: string
  trigger: 'boot' | 'manual' | 'pre-update'
  label: string | null
  comfyui: {
    ref: string
    commit: string | null
    releaseTag: string
    variant: string
  }
  customNodes: ScannedNode[]
  pipPackages: Record<string, string>
}

export interface SnapshotEntry {
  filename: string
  snapshot: Snapshot
}

export interface SnapshotDiff {
  comfyuiChanged: boolean
  comfyui?: {
    from: { ref: string; commit: string | null }
    to: { ref: string; commit: string | null }
  }
  nodesAdded: ScannedNode[]
  nodesRemoved: ScannedNode[]
  nodesChanged: Array<{
    id: string
    type: string
    from: { version?: string; commit?: string; enabled: boolean }
    to: { version?: string; commit?: string; enabled: boolean }
  }>
  pipsAdded: Array<{ name: string; version: string }>
  pipsRemoved: Array<{ name: string; version: string }>
  pipsChanged: Array<{ name: string; from: string; to: string }>
}

// --- Constants ---

const SNAPSHOTS_DIR = path.join('.launcher', 'snapshots')
const MANIFEST_FILE = 'manifest.json'
const AUTO_SNAPSHOT_LIMIT = 50

// --- Helpers ---

function snapshotsDir(installPath: string): string {
  return path.join(installPath, SNAPSHOTS_DIR)
}

function readGitHead(comfyuiDir: string): string | null {
  const headPath = path.join(comfyuiDir, '.git', 'HEAD')
  try {
    const content = fs.readFileSync(headPath, 'utf-8').trim()
    if (!content.startsWith('ref: ')) return content || null
    const refPath = path.join(comfyuiDir, '.git', content.slice(5))
    try {
      return fs.readFileSync(refPath, 'utf-8').trim() || null
    } catch {
      const packedRefsPath = path.join(comfyuiDir, '.git', 'packed-refs')
      try {
        const packed = fs.readFileSync(packedRefsPath, 'utf-8')
        const ref = content.slice(5)
        for (const line of packed.split('\n')) {
          if (line.startsWith('#') || !line.trim()) continue
          const [sha, name] = line.trim().split(/\s+/)
          if (name === ref) return sha || null
        }
      } catch {}
      return null
    }
  } catch {
    return null
  }
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

function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function getUvPath(installPath: string): string {
  if (process.platform === 'win32') {
    return path.join(installPath, 'standalone-env', 'uv.exe')
  }
  return path.join(installPath, 'standalone-env', 'bin', 'uv')
}

function getActivePythonPath(installation: InstallationRecord): string | null {
  const envName = (installation.activeEnv as string | undefined) || 'default'
  const envDir = path.join(installation.installPath, 'envs', envName)
  const pythonPath = process.platform === 'win32'
    ? path.join(envDir, 'Scripts', 'python.exe')
    : path.join(envDir, 'bin', 'python3')
  return fs.existsSync(pythonPath) ? pythonPath : null
}

// --- Core functions ---

async function captureState(installPath: string, installation: InstallationRecord): Promise<Omit<Snapshot, 'createdAt' | 'trigger' | 'label' | 'version'>> {
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

  return {
    comfyui: {
      ref: manifest.comfyui_ref,
      commit,
      releaseTag: manifest.version,
      variant: manifest.id,
    },
    customNodes,
    pipPackages,
  }
}

function statesMatch(a: Snapshot, b: Omit<Snapshot, 'createdAt' | 'trigger' | 'label' | 'version'>): boolean {
  // ComfyUI version/commit
  if (a.comfyui.ref !== b.comfyui.ref || a.comfyui.commit !== b.comfyui.commit) return false

  // Custom nodes — compare by id, type, version, commit, enabled
  if (a.customNodes.length !== b.customNodes.length) return false
  const aNodes = new Map(a.customNodes.map((n) => [n.id, n]))
  for (const bn of b.customNodes) {
    const an = aNodes.get(bn.id)
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

export async function captureSnapshotIfChanged(
  installPath: string,
  installation: InstallationRecord,
  trigger: 'boot' | 'manual' | 'pre-update'
): Promise<{ saved: boolean; filename?: string }> {
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

  // Prune old auto snapshots
  await pruneAutoSnapshots(installPath, AUTO_SNAPSHOT_LIMIT).catch(() => {})

  return { saved: true, filename }
}

export async function saveSnapshot(
  installPath: string,
  installation: InstallationRecord,
  trigger: 'boot' | 'manual' | 'pre-update',
  label?: string
): Promise<string> {
  const current = await captureState(installPath, installation)
  return writeSnapshot(installPath, { ...current, trigger, label: label || null })
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
  }

  const dir = snapshotsDir(installPath)
  await fs.promises.mkdir(dir, { recursive: true })
  const filename = `${formatTimestamp(now)}-${data.trigger}.json`
  const filePath = path.join(dir, filename)
  const tmpPath = filePath + '.tmp'
  await fs.promises.writeFile(tmpPath, JSON.stringify(snapshot, null, 2))
  await fs.promises.rename(tmpPath, filePath)
  return filename
}

export async function listSnapshots(installPath: string): Promise<SnapshotEntry[]> {
  const dir = snapshotsDir(installPath)
  try {
    const files = await fs.promises.readdir(dir)
    const entries: SnapshotEntry[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const content = await fs.promises.readFile(path.join(dir, file), 'utf-8')
        entries.push({ filename: file, snapshot: JSON.parse(content) as Snapshot })
      } catch {}
    }
    // Sort newest first
    entries.sort((a, b) => b.snapshot.createdAt.localeCompare(a.snapshot.createdAt))
    return entries
  } catch {
    return []
  }
}

export function listSnapshotsSync(installPath: string): SnapshotEntry[] {
  const dir = snapshotsDir(installPath)
  try {
    const files = fs.readdirSync(dir)
    const entries: SnapshotEntry[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8')
        entries.push({ filename: file, snapshot: JSON.parse(content) as Snapshot })
      } catch {}
    }
    entries.sort((a, b) => b.snapshot.createdAt.localeCompare(a.snapshot.createdAt))
    return entries
  } catch {
    return []
  }
}

export async function loadSnapshot(installPath: string, filename: string): Promise<Snapshot> {
  const filePath = path.join(snapshotsDir(installPath), filename)
  const content = await fs.promises.readFile(filePath, 'utf-8')
  return JSON.parse(content) as Snapshot
}

export async function deleteSnapshot(installPath: string, filename: string): Promise<void> {
  const dir = snapshotsDir(installPath)
  const filePath = path.join(dir, filename)
  // Ensure the resolved path is within the snapshots directory
  if (!filePath.startsWith(dir + path.sep) && filePath !== dir) return
  await fs.promises.unlink(filePath)
}

export function diffSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff {
  const diff: SnapshotDiff = {
    comfyuiChanged: false,
    nodesAdded: [],
    nodesRemoved: [],
    nodesChanged: [],
    pipsAdded: [],
    pipsRemoved: [],
    pipsChanged: [],
  }

  // ComfyUI version
  if (a.comfyui.ref !== b.comfyui.ref || a.comfyui.commit !== b.comfyui.commit) {
    diff.comfyuiChanged = true
    diff.comfyui = {
      from: { ref: a.comfyui.ref, commit: a.comfyui.commit },
      to: { ref: b.comfyui.ref, commit: b.comfyui.commit },
    }
  }

  // Custom nodes
  const aNodes = new Map(a.customNodes.map((n) => [n.id, n]))
  const bNodes = new Map(b.customNodes.map((n) => [n.id, n]))

  for (const [id, bn] of bNodes) {
    const an = aNodes.get(id)
    if (!an) {
      diff.nodesAdded.push(bn)
    } else if (an.version !== bn.version || an.commit !== bn.commit || an.enabled !== bn.enabled) {
      diff.nodesChanged.push({
        id,
        type: bn.type,
        from: { version: an.version, commit: an.commit, enabled: an.enabled },
        to: { version: bn.version, commit: bn.commit, enabled: bn.enabled },
      })
    }
  }
  for (const [id, an] of aNodes) {
    if (!bNodes.has(id)) {
      diff.nodesRemoved.push(an)
    }
  }

  // Pip packages
  for (const [name, ver] of Object.entries(b.pipPackages)) {
    if (!(name in a.pipPackages)) {
      diff.pipsAdded.push({ name, version: ver })
    } else if (a.pipPackages[name] !== ver) {
      diff.pipsChanged.push({ name, from: a.pipPackages[name]!, to: ver })
    }
  }
  for (const name of Object.keys(a.pipPackages)) {
    if (!(name in b.pipPackages)) {
      diff.pipsRemoved.push({ name, version: a.pipPackages[name]! })
    }
  }

  return diff
}

export async function pruneAutoSnapshots(installPath: string, keep: number): Promise<number> {
  const entries = await listSnapshots(installPath)
  const autoSnapshots = entries.filter((e) => e.snapshot.trigger === 'boot' && !e.snapshot.label)
  if (autoSnapshots.length <= keep) return 0

  const toDelete = autoSnapshots.slice(keep)
  let deleted = 0
  for (const entry of toDelete) {
    try {
      await deleteSnapshot(installPath, entry.filename)
      deleted++
    } catch {}
  }
  return deleted
}
