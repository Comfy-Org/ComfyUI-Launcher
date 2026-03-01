import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { readGitHead, isGitAvailable, gitClone, gitFetchAndCheckout } from './git'
import { scanCustomNodes, nodeKey } from './nodes'
import { pipFreeze } from './pip'
import { installCnrNode, switchCnrVersion, isSafePathComponent } from './cnr'
import type { ScannedNode } from './nodes'
import type { InstallationRecord } from '../installations'

// --- Types ---

export interface Snapshot {
  version: 1
  createdAt: string
  trigger: 'boot' | 'restart' | 'manual' | 'pre-update' | 'post-update' | 'post-restore'
  label: string | null
  comfyui: {
    ref: string
    commit: string | null
    releaseTag: string
    variant: string
    displayVersion?: string
  }
  customNodes: ScannedNode[]
  pipPackages: Record<string, string>
  pythonVersion?: string
  updateChannel?: string
}

export interface SnapshotEntry {
  filename: string
  snapshot: Snapshot
}

export interface SnapshotDiff {
  comfyuiChanged: boolean
  comfyui?: {
    from: { ref: string; commit: string | null; displayVersion?: string }
    to: { ref: string; commit: string | null; displayVersion?: string }
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

function snapshotsDir(installPath: string): string {
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

function formatTimestamp(date: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${pad(date.getMilliseconds(), 3)}`
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
      displayVersion: (installation.version as string | undefined) || undefined,
    },
    customNodes,
    pipPackages,
    pythonVersion: (installation.pythonVersion as string | undefined) || undefined,
    updateChannel: (installation.updateChannel as string | undefined) || undefined,
  }
}

function statesMatch(a: Snapshot, b: Omit<Snapshot, 'createdAt' | 'trigger' | 'label' | 'version'>): boolean {
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
    const entries: SnapshotEntry[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const content = await fs.promises.readFile(path.join(dir, file), 'utf-8')
        entries.push({ filename: file, snapshot: JSON.parse(content) as Snapshot })
      } catch (err) {
        console.warn(`Snapshot: failed to read ${file}:`, (err as Error).message)
      }
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
      } catch (err) {
        console.warn(`Snapshot: failed to read ${file}:`, (err as Error).message)
      }
    }
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
      from: { ref: a.comfyui.ref, commit: a.comfyui.commit, displayVersion: a.comfyui.displayVersion },
      to: { ref: b.comfyui.ref, commit: b.comfyui.commit, displayVersion: b.comfyui.displayVersion },
    }
  }

  // Custom nodes — keyed by (type, dirName)
  const aNodes = new Map(a.customNodes.map((n) => [nodeKey(n), n]))
  const bNodes = new Map(b.customNodes.map((n) => [nodeKey(n), n]))

  for (const [key, bn] of bNodes) {
    const an = aNodes.get(key)
    if (!an) {
      diff.nodesAdded.push(bn)
    } else if (an.version !== bn.version || an.commit !== bn.commit || an.enabled !== bn.enabled || an.type !== bn.type) {
      diff.nodesChanged.push({
        id: bn.id,
        type: bn.type,
        from: { version: an.version, commit: an.commit, enabled: an.enabled },
        to: { version: bn.version, commit: bn.commit, enabled: bn.enabled },
      })
    }
  }
  for (const [key, an] of aNodes) {
    if (!bNodes.has(key)) {
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

/**
 * Capture the current live state and diff it against a target snapshot.
 * Returns the diff from current → target (what a restore would change).
 */
export async function diffAgainstCurrent(
  installPath: string,
  installation: InstallationRecord,
  target: Snapshot
): Promise<SnapshotDiff> {
  const state = await captureState(installPath, installation)
  const current: Snapshot = {
    version: 1,
    createdAt: new Date().toISOString(),
    trigger: 'manual',
    label: null,
    ...state,
  }
  return diffSnapshots(current, target)
}

/**
 * After a successful update, check if the pre-update snapshot is identical to
 * the snapshot before it. If so, it's redundant and can be removed.
 */
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
    } catch {}
  }
  return deleted
}

// --- Pip Restore ---

/**
 * Protected packages that should not be modified during snapshot restore.
 * Matches Manager's skip list plus core tooling.
 *
 * TODO: Expand by detecting packages from the PyTorch index URL rather than
 * hardcoded names. This would automatically cover new CUDA packages without
 * maintaining a list. Also consider computing transitive dependencies of
 * protected packages to avoid breaking their dep chains.
 */
const PROTECTED_EXACT = new Set(['pip', 'setuptools', 'wheel', 'uv'])
const PROTECTED_PREFIXES = ['torch', 'nvidia', 'triton', 'cuda']

function isProtectedPackage(name: string): boolean {
  const lower = name.toLowerCase()
  if (PROTECTED_EXACT.has(lower)) return true
  return PROTECTED_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(prefix + '-') || lower.startsWith(prefix + '_'))
}

/** Normalize a package name for dist-info directory matching (PEP 503). */
function normalizeDistInfoName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '_')
}

function findSitePackagesDir(envRoot: string): string | null {
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

/** Find a package's dist-info directory in site-packages. */
function findDistInfoDir(sitePackages: string, packageName: string): string | null {
  const normalized = normalizeDistInfoName(packageName)
  try {
    for (const entry of fs.readdirSync(sitePackages)) {
      if (!entry.endsWith('.dist-info')) continue
      // dist-info format: {normalized_name}-{version}.dist-info
      // Normalized name uses _ not -, so first '-' separates name from version
      const stem = entry.slice(0, -'.dist-info'.length)
      const dashIdx = stem.indexOf('-')
      if (dashIdx < 0) continue
      const dirName = stem.slice(0, dashIdx)
      if (normalizeDistInfoName(dirName) === normalized) {
        return entry
      }
    }
  } catch {}
  return null
}

/**
 * Find all directories/files in site-packages belonging to a package.
 * Uses the RECORD file from dist-info to identify top-level entries.
 */
function findPackageEntries(sitePackages: string, packageName: string): string[] {
  const entries: string[] = []
  const distInfo = findDistInfoDir(sitePackages, packageName)
  if (!distInfo) return entries

  entries.push(distInfo)

  const recordPath = path.join(sitePackages, distInfo, 'RECORD')
  try {
    const content = fs.readFileSync(recordPath, 'utf-8')
    const topLevels = new Set<string>()
    for (const line of content.split('\n')) {
      const filePath = line.split(',')[0]?.trim()
      if (!filePath || filePath.startsWith('..') || filePath === '') continue
      const topLevel = filePath.replace(/\\/g, '/').split('/')[0]!
      if (topLevel && topLevel !== distInfo) {
        topLevels.add(topLevel)
      }
    }
    for (const tl of topLevels) {
      if (fs.existsSync(path.join(sitePackages, tl))) {
        entries.push(tl)
      }
    }
  } catch {
    // Fallback: look for common name patterns
    const normalized = normalizeDistInfoName(packageName)
    for (const suffix of ['', '.py', '.libs', '.data']) {
      const candidate = normalized + suffix
      if (fs.existsSync(path.join(sitePackages, candidate)) && !entries.includes(candidate)) {
        entries.push(candidate)
      }
    }
  }

  return entries
}

/**
 * Create a targeted backup of specific packages from site-packages.
 * Only backs up directories/files that belong to the listed packages.
 */
async function createTargetedBackup(sitePackages: string, packageNames: string[]): Promise<string> {
  const backupDir = path.join(path.dirname(sitePackages), `.restore-backup-${Date.now()}`)
  await fs.promises.mkdir(backupDir, { recursive: true })

  const failures: string[] = []
  for (const pkg of packageNames) {
    const pkgEntries = findPackageEntries(sitePackages, pkg)
    for (const entry of pkgEntries) {
      const src = path.join(sitePackages, entry)
      const dst = path.join(backupDir, entry)
      try {
        const stat = fs.statSync(src)
        if (stat.isDirectory()) {
          fs.cpSync(src, dst, { recursive: true })
        } else {
          await fs.promises.mkdir(path.dirname(dst), { recursive: true })
          await fs.promises.copyFile(src, dst)
        }
      } catch (err) {
        failures.push(`${entry}: ${(err as Error).message}`)
      }
    }
  }

  if (failures.length > 0) {
    // Clean up incomplete backup
    await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {})
    throw new Error(`Backup failed for ${failures.length} entry(s): ${failures.join('; ')}`)
  }

  return backupDir
}

/** Restore backed-up package files to site-packages. */
async function restoreFromBackup(backupDir: string, sitePackages: string): Promise<void> {
  try {
    const entries = await fs.promises.readdir(backupDir)
    for (const entry of entries) {
      const src = path.join(backupDir, entry)
      const dst = path.join(sitePackages, entry)
      await fs.promises.rm(dst, { recursive: true, force: true }).catch(() => {})
      const stat = fs.statSync(src)
      if (stat.isDirectory()) {
        fs.cpSync(src, dst, { recursive: true })
      } else {
        await fs.promises.copyFile(src, dst)
      }
    }
  } catch (err) {
    console.error('Failed to restore from backup:', (err as Error).message)
  }
}

/** Run a uv pip command and stream output. Returns the exit code. */
function runUvPip(
  uvPath: string,
  args: string[],
  cwd: string,
  sendOutput: (text: string) => void
): Promise<number> {
  return new Promise<number>((resolve) => {
    const proc = spawn(uvPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    proc.stdout.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
    proc.stderr.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
    proc.on('error', (err) => {
      sendOutput(`Error: ${err.message}\n`)
      resolve(1)
    })
    proc.on('exit', (code) => resolve(code ?? 1))
  })
}

export interface RestoreResult {
  installed: string[]
  removed: string[]
  changed: Array<{ name: string; from: string; to: string }>
  protectedSkipped: string[]
  failed: string[]
  errors: string[]
}

/**
 * Restore pip packages to match a target snapshot.
 * Creates a targeted backup of affected packages before making changes.
 * On failure, reverts from backup.
 */
export async function restorePipPackages(
  installPath: string,
  installation: InstallationRecord,
  targetSnapshot: Snapshot,
  sendProgress: (phase: string, data: Record<string, unknown>) => void,
  sendOutput: (text: string) => void,
  signal?: AbortSignal
): Promise<RestoreResult> {
  const result: RestoreResult = {
    installed: [], removed: [], changed: [],
    protectedSkipped: [], failed: [], errors: [],
  }

  const uvPath = getUvPath(installPath)
  const pythonPath = getActivePythonPath(installation)
  if (!pythonPath || !fs.existsSync(uvPath)) {
    throw new Error('Python environment or uv not found')
  }

  // 1. Capture current pip state
  sendProgress('restore', { percent: 5, status: 'Analyzing current environment…' })
  sendOutput('\nAnalyzing pip packages…\n')
  const currentPips = await pipFreeze(uvPath, pythonPath)
  const targetPips = targetSnapshot.pipPackages
  const currentCount = Object.keys(currentPips).length
  const targetCount = Object.keys(targetPips).length
  sendOutput(`Found ${currentCount} current package(s), target snapshot has ${targetCount}\n`)

  // 2. Compute what needs to change
  const toInstall: Array<{ name: string; version: string }> = []
  const toRemove: string[] = []

  for (const [name, version] of Object.entries(targetPips)) {
    if (isProtectedPackage(name)) {
      if (!(name in currentPips) || currentPips[name] !== version) {
        result.protectedSkipped.push(name)
      }
      continue
    }
    // Skip non-standard versions (editable installs, direct references)
    if (version.startsWith('-e ') || version.includes('://')) continue

    if (!(name in currentPips)) {
      toInstall.push({ name, version })
    } else if (currentPips[name] !== version) {
      result.changed.push({ name, from: currentPips[name]!, to: version })
      toInstall.push({ name, version })
    }
  }

  for (const name of Object.keys(currentPips)) {
    if (!(name in targetPips)) {
      if (isProtectedPackage(name)) {
        result.protectedSkipped.push(name)
      } else {
        toRemove.push(name)
      }
    }
  }

  // Print the plan
  const newPkgs = toInstall.filter((p) => !result.changed.some((c) => c.name === p.name))
  const pipPlanParts: string[] = []
  if (newPkgs.length > 0) pipPlanParts.push(`install ${newPkgs.length}`)
  if (result.changed.length > 0) pipPlanParts.push(`change ${result.changed.length}`)
  if (toRemove.length > 0) pipPlanParts.push(`remove ${toRemove.length}`)
  if (result.protectedSkipped.length > 0) pipPlanParts.push(`${result.protectedSkipped.length} protected (skipped)`)
  if (pipPlanParts.length > 0) {
    sendOutput(`\nPlan: ${pipPlanParts.join(', ')} package(s)\n\n`)
  } else {
    sendOutput('\nNo package changes needed\n')
  }

  if (toInstall.length === 0 && toRemove.length === 0) {
    return result
  }

  // 3. Create targeted backup of packages that will be modified or removed
  sendProgress('restore', { percent: 10, status: 'Creating backup of affected packages…' })
  const envName = (installation.activeEnv as string | undefined) || 'default'
  const envDir = path.join(installPath, 'envs', envName)
  const sitePackages = findSitePackagesDir(envDir)
  if (!sitePackages) {
    throw new Error('Could not locate site-packages directory')
  }

  const packagesToBackup = [
    ...toInstall.filter((p) => p.name in currentPips).map((p) => p.name),
    ...toRemove,
  ]

  let backupDir: string | null = null
  if (packagesToBackup.length > 0) {
    backupDir = await createTargetedBackup(sitePackages, packagesToBackup)
  }

  try {
    // 4. Install missing + upgrade/downgrade changed packages
    if (toInstall.length > 0 && !signal?.aborted) {
      const totalOps = toInstall.length + toRemove.length
      sendProgress('restore', { percent: 20, status: `Installing ${toInstall.length} package(s)…` })

      const specs = toInstall.map((p) => `${p.name}==${p.version}`)

      // Try bulk install first
      sendOutput(`\nInstalling ${specs.length} package(s)…\n`)
      const bulkResult = await runUvPip(uvPath, ['pip', 'install', ...specs, '--python', pythonPath], installPath, sendOutput)

      if (bulkResult !== 0) {
        sendOutput('\n⚠ Bulk install failed, falling back to one-by-one with --no-deps\n\n')

        for (let i = 0; i < specs.length; i++) {
          if (signal?.aborted) break
          const spec = specs[i]!
          const name = toInstall[i]!.name
          const percent = 20 + Math.round((i / totalOps) * 50)
          sendProgress('restore', { percent, status: `Installing ${name}…` })

          const singleResult = await runUvPip(
            uvPath, ['pip', 'install', spec, '--no-deps', '--python', pythonPath], installPath, sendOutput
          )

          if (singleResult !== 0) {
            result.failed.push(name)
            result.errors.push(`Failed to install ${spec}`)
          } else if (!result.changed.some((c) => c.name === name)) {
            result.installed.push(name)
          }
        }
      } else {
        for (const p of toInstall) {
          if (!result.changed.some((c) => c.name === p.name)) {
            result.installed.push(p.name)
          }
        }
      }
    }

    // 5. Remove extra packages (present in current but absent from snapshot)
    if (toRemove.length > 0 && !signal?.aborted) {
      sendProgress('restore', { percent: 75, status: `Removing ${toRemove.length} extra package(s)…` })
      sendOutput(`\nRemoving ${toRemove.length} extra package(s)…\n`)

      const removeResult = await runUvPip(
        uvPath, ['pip', 'uninstall', ...toRemove, '--python', pythonPath], installPath, sendOutput
      )

      if (removeResult === 0) {
        result.removed.push(...toRemove)
      } else {
        for (const name of toRemove) {
          const singleResult = await runUvPip(
            uvPath, ['pip', 'uninstall', name, '--python', pythonPath], installPath, sendOutput
          )
          if (singleResult === 0) {
            result.removed.push(name)
          } else {
            result.failed.push(name)
            result.errors.push(`Failed to remove ${name}`)
          }
        }
      }
    }

    // 6. If there were failures, revert the entire operation
    if (result.failed.length > 0 && backupDir) {
      sendProgress('restore', { percent: 90, status: 'Reverting due to failures…' })
      sendOutput('\n⚠ Some operations failed. Reverting from backup…\n')
      await restoreFromBackup(backupDir, sitePackages)

      // Also uninstall any newly installed packages (weren't in current state)
      const newlyInstalled = result.installed
      if (newlyInstalled.length > 0) {
        await runUvPip(
          uvPath, ['pip', 'uninstall', ...newlyInstalled, '--python', pythonPath], installPath, sendOutput
        ).catch(() => {})
      }

      result.installed = []
      result.removed = []
      result.changed = []
      result.errors.push('Restore reverted to pre-restore state due to failures')
    }
  } catch (err) {
    // Catastrophic failure — revert
    if (backupDir) {
      sendOutput(`\n⚠ Restore failed: ${(err as Error).message}\nReverting from backup…\n`)
      await restoreFromBackup(backupDir, sitePackages)
    }
    throw err
  } finally {
    if (backupDir) {
      await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return result
}

// --- Custom Node Restore ---

export interface NodeRestoreResult {
  installed: string[]
  switched: string[]
  enabled: string[]
  disabled: string[]
  removed: string[]
  skipped: string[]
  failed: Array<{ id: string; error: string }>
  unreportable: string[]
}

const PYTORCH_RE = /^(torch|torchvision|torchaudio|torchsde)(\s*[<>=!~;[#]|$)/i

function isManagerNode(node: ScannedNode): boolean {
  return node.id.toLowerCase().includes('comfyui-manager')
}

async function disableNode(customNodesDir: string, dirName: string): Promise<void> {
  const src = path.join(customNodesDir, dirName)
  const disabledDir = path.join(customNodesDir, '.disabled')
  await fs.promises.mkdir(disabledDir, { recursive: true })
  const dst = path.join(disabledDir, dirName)
  await fs.promises.rm(dst, { recursive: true, force: true }).catch(() => {})
  await fs.promises.rename(src, dst)
}

async function enableNode(customNodesDir: string, dirName: string): Promise<void> {
  const src = path.join(customNodesDir, '.disabled', dirName)
  const dst = path.join(customNodesDir, dirName)
  await fs.promises.rm(dst, { recursive: true, force: true }).catch(() => {})
  await fs.promises.rename(src, dst)
}

async function runPostInstallScripts(
  nodePath: string,
  uvPath: string,
  pythonPath: string,
  installPath: string,
  sendOutput: (text: string) => void
): Promise<void> {
  const reqPath = path.join(nodePath, 'requirements.txt')
  if (fs.existsSync(reqPath)) {
    try {
      const reqContent = await fs.promises.readFile(reqPath, 'utf-8')
      const filtered = reqContent.split('\n').filter((l) => !PYTORCH_RE.test(l.trim())).join('\n')
      const filteredReqPath = path.join(installPath, `.restore-reqs-${path.basename(nodePath)}.txt`)
      await fs.promises.writeFile(filteredReqPath, filtered, 'utf-8')

      try {
        await runUvPip(uvPath, ['pip', 'install', '-r', filteredReqPath, '--python', pythonPath], installPath, sendOutput)
      } finally {
        try { await fs.promises.unlink(filteredReqPath) } catch {}
      }
    } catch (err) {
      sendOutput(`⚠ requirements.txt failed for ${path.basename(nodePath)}: ${(err as Error).message}\n`)
    }
  }

  const installScript = path.join(nodePath, 'install.py')
  if (fs.existsSync(installScript)) {
    try {
      await new Promise<void>((resolve) => {
        const proc = spawn(pythonPath, ['-s', installScript], {
          cwd: nodePath,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        proc.stdout.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
        proc.stderr.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
        proc.on('error', (err) => {
          sendOutput(`⚠ install.py error: ${err.message}\n`)
          resolve()
        })
        proc.on('exit', () => resolve())
      })
    } catch (err) {
      sendOutput(`⚠ install.py failed for ${path.basename(nodePath)}: ${(err as Error).message}\n`)
    }
  }
}

export async function restoreCustomNodes(
  installPath: string,
  installation: InstallationRecord,
  targetSnapshot: Snapshot,
  sendProgress: (phase: string, data: Record<string, unknown>) => void,
  sendOutput: (text: string) => void,
  signal?: AbortSignal
): Promise<NodeRestoreResult> {
  const result: NodeRestoreResult = {
    installed: [], switched: [], enabled: [], disabled: [],
    removed: [], skipped: [], failed: [], unreportable: [],
  }

  const comfyuiDir = path.join(installPath, 'ComfyUI')
  const customNodesDir = path.join(comfyuiDir, 'custom_nodes')

  // 1. Scan current custom nodes
  sendProgress('restore-nodes', { percent: 5, status: 'Scanning custom nodes…' })
  sendOutput('Scanning current custom nodes…\n')
  const currentNodes = await scanCustomNodes(comfyuiDir)
  const currentByKey = new Map(currentNodes.map((n) => [nodeKey(n), n]))
  const targetByKey = new Map(targetSnapshot.customNodes.map((n) => [nodeKey(n), n]))
  sendOutput(`Found ${currentNodes.length} current node(s), target snapshot has ${targetSnapshot.customNodes.length}\n`)

  // Check git availability for git node operations
  const needsGit = targetSnapshot.customNodes.some((n) =>
    n.type === 'git' && (
      !currentByKey.has(nodeKey(n)) ||
      currentByKey.get(nodeKey(n))?.commit !== n.commit
    )
  )
  const gitAvailable = needsGit ? await isGitAvailable() : false
  if (needsGit && !gitAvailable) {
    sendOutput('⚠ git is not available in PATH — git node operations will be skipped\n')
  }

  // Compute and print the plan
  const toRemove: string[] = []
  const toDisable: string[] = []
  const toInstallNodes: string[] = []
  const toSwitch: string[] = []
  const toEnable: string[] = []
  for (const [key, currentNode] of currentByKey) {
    if (isManagerNode(currentNode)) continue
    if (!targetByKey.has(key)) toRemove.push(currentNode.id)
  }
  for (const targetNode of targetSnapshot.customNodes) {
    if (isManagerNode(targetNode)) continue
    const currentNode = currentByKey.get(nodeKey(targetNode))
    if (!currentNode) {
      if (targetNode.type !== 'file') toInstallNodes.push(targetNode.id)
    } else if (!currentNode.enabled && targetNode.enabled) {
      toEnable.push(targetNode.id)
    } else if (currentNode.enabled && !targetNode.enabled) {
      toDisable.push(targetNode.id)
    } else if (targetNode.enabled || currentNode.enabled) {
      if (targetNode.type === 'cnr' && targetNode.version && currentNode.version !== targetNode.version) {
        toSwitch.push(targetNode.id)
      } else if (targetNode.type === 'git' && targetNode.commit && currentNode.commit !== targetNode.commit) {
        toSwitch.push(targetNode.id)
      }
    }
  }

  const planParts: string[] = []
  if (toInstallNodes.length > 0) planParts.push(`install ${toInstallNodes.length}`)
  if (toSwitch.length > 0) planParts.push(`switch ${toSwitch.length}`)
  if (toEnable.length > 0) planParts.push(`enable ${toEnable.length}`)
  if (toRemove.length > 0) planParts.push(`remove ${toRemove.length}`)
  if (toDisable.length > 0) planParts.push(`disable ${toDisable.length}`)
  if (planParts.length > 0) {
    sendOutput(`\nPlan: ${planParts.join(', ')} node(s)\n\n`)
  } else {
    sendOutput('\nNo node changes needed\n')
  }

  // 2. Remove extras: nodes not in target snapshot (enabled or disabled)
  for (const [key, currentNode] of currentByKey) {
    if (signal?.aborted) break
    if (isManagerNode(currentNode)) continue
    if (!targetByKey.has(key)) {
      if (!isSafePathComponent(currentNode.dirName)) {
        result.failed.push({ id: currentNode.id, error: 'invalid directory name' })
        continue
      }
      try {
        const nodePath = currentNode.enabled
          ? path.join(customNodesDir, currentNode.dirName)
          : path.join(customNodesDir, '.disabled', currentNode.dirName)
        await fs.promises.rm(nodePath, { recursive: true, force: true })
        result.removed.push(currentNode.id)
        sendOutput(`Removed ${currentNode.id}\n`)
      } catch (err) {
        result.failed.push({ id: currentNode.id, error: `remove failed: ${(err as Error).message}` })
      }
    }
  }

  // 3. Process target nodes
  const targetList = targetSnapshot.customNodes.filter((n) => !isManagerNode(n))
  const nodesNeedingPostInstall: string[] = []

  for (let i = 0; i < targetList.length; i++) {
    if (signal?.aborted) break
    const targetNode = targetList[i]!
    const key = nodeKey(targetNode)
    const currentNode = currentByKey.get(key)
    const percent = 10 + Math.round((i / targetList.length) * 80)
    sendProgress('restore-nodes', { percent, status: `Processing ${targetNode.id}…` })

    if (!currentNode) {
      // Node not present — install or report
      if (targetNode.type === 'cnr') {
        if (!targetNode.version) {
          result.failed.push({ id: targetNode.id, error: 'no version in snapshot' })
          continue
        }
        if (!isSafePathComponent(targetNode.id)) {
          result.failed.push({ id: targetNode.id, error: 'invalid node ID' })
          continue
        }
        try {
          await installCnrNode(targetNode.id, targetNode.version, customNodesDir, sendOutput)
          result.installed.push(targetNode.id)
          nodesNeedingPostInstall.push(path.join(customNodesDir, targetNode.id))
          if (!targetNode.enabled) {
            await disableNode(customNodesDir, targetNode.id)
          }
        } catch (err) {
          result.failed.push({ id: targetNode.id, error: (err as Error).message })
        }
      } else if (targetNode.type === 'git') {
        if (!gitAvailable) {
          result.failed.push({ id: targetNode.id, error: 'git not available' })
          continue
        }
        if (!targetNode.url) {
          result.failed.push({ id: targetNode.id, error: 'no URL in snapshot' })
          continue
        }
        if (!isSafePathComponent(targetNode.dirName)) {
          result.failed.push({ id: targetNode.id, error: 'invalid directory name' })
          continue
        }
        try {
          const dest = path.join(customNodesDir, targetNode.dirName)
          const cloneResult = await gitClone(targetNode.url, dest, sendOutput)
          if (cloneResult !== 0) {
            result.failed.push({ id: targetNode.id, error: `git clone failed (exit ${cloneResult})` })
            continue
          }
          if (targetNode.commit) {
            const checkoutResult = await gitFetchAndCheckout(dest, targetNode.commit, sendOutput)
            if (checkoutResult !== 0) {
              sendOutput(`⚠ git checkout to ${targetNode.commit} failed for ${targetNode.id}\n`)
            }
          }
          result.installed.push(targetNode.id)
          nodesNeedingPostInstall.push(dest)
          if (!targetNode.enabled) {
            await disableNode(customNodesDir, targetNode.dirName)
          }
        } catch (err) {
          result.failed.push({ id: targetNode.id, error: (err as Error).message })
        }
      } else if (targetNode.type === 'file') {
        result.unreportable.push(targetNode.id)
      }
      continue
    }

    // Node exists — handle enable/disable and version changes
    if (!currentNode.enabled && targetNode.enabled) {
      try {
        await enableNode(customNodesDir, currentNode.dirName)
        result.enabled.push(targetNode.id)
        sendOutput(`Enabled ${targetNode.id}\n`)
      } catch (err) {
        result.failed.push({ id: targetNode.id, error: `enable failed: ${(err as Error).message}` })
        continue
      }
    } else if (currentNode.enabled && !targetNode.enabled) {
      try {
        await disableNode(customNodesDir, currentNode.dirName)
        result.disabled.push(targetNode.id)
        sendOutput(`Disabled ${targetNode.id}\n`)
      } catch (err) {
        result.failed.push({ id: targetNode.id, error: `disable failed: ${(err as Error).message}` })
      }
      continue
    }

    // Version/commit changes (only if the node is/will be enabled)
    if (targetNode.enabled || currentNode.enabled) {
      const nodePath = path.join(customNodesDir, currentNode.dirName)

      if (targetNode.type === 'cnr' && targetNode.version && currentNode.version !== targetNode.version) {
        try {
          await switchCnrVersion(targetNode.id, targetNode.version, nodePath, sendOutput)
          result.switched.push(targetNode.id)
          nodesNeedingPostInstall.push(nodePath)
        } catch (err) {
          result.failed.push({ id: targetNode.id, error: (err as Error).message })
        }
      } else if (targetNode.type === 'git' && targetNode.commit && currentNode.commit !== targetNode.commit) {
        if (!gitAvailable) {
          result.failed.push({ id: targetNode.id, error: 'git not available' })
        } else {
          const checkoutResult = await gitFetchAndCheckout(nodePath, targetNode.commit, sendOutput)
          if (checkoutResult === 0) {
            result.switched.push(targetNode.id)
            nodesNeedingPostInstall.push(nodePath)
          } else {
            result.failed.push({ id: targetNode.id, error: `git checkout failed (exit ${checkoutResult})` })
          }
        }
      } else {
        result.skipped.push(targetNode.id)
      }
    } else {
      result.skipped.push(targetNode.id)
    }
  }

  // 4. Run post-install scripts for installed/switched nodes
  if (nodesNeedingPostInstall.length > 0) {
    const uvPath = getUvPath(installPath)
    const pythonPath = getActivePythonPath(installation)

    if (pythonPath && fs.existsSync(uvPath)) {
      sendProgress('restore-nodes', { percent: 92, status: 'Installing node dependencies…' })
      for (const nodePath of nodesNeedingPostInstall) {
        sendOutput(`\nRunning post-install for ${path.basename(nodePath)}…\n`)
        await runPostInstallScripts(nodePath, uvPath, pythonPath, installPath, sendOutput)
      }
    } else {
      sendOutput('⚠ Cannot run post-install scripts: uv or Python environment not found\n')
    }
  }

  sendProgress('restore-nodes', { percent: 100, status: 'Node restore complete' })
  return result
}

// --- Snapshot Tab Data ---

export interface SnapshotDiffSummary {
  nodesAdded: number
  nodesRemoved: number
  nodesChanged: number
  pipsAdded: number
  pipsRemoved: number
  pipsChanged: number
  comfyuiChanged: boolean
}

export interface SnapshotSummary {
  filename: string
  createdAt: string
  trigger: 'boot' | 'restart' | 'manual' | 'pre-update' | 'post-update' | 'post-restore'
  label: string | null
  comfyuiVersion: string
  nodeCount: number
  pipPackageCount: number
  diffVsPrevious?: SnapshotDiffSummary
}

export interface SnapshotDetailData {
  filename: string
  createdAt: string
  trigger: string
  label: string | null
  comfyui: {
    ref: string
    commit: string | null
    releaseTag: string
    variant: string
    displayVersion?: string
  }
  pythonVersion?: string
  updateChannel?: string
  customNodes: ScannedNode[]
  pipPackageCount: number
  pipPackages: Record<string, string>
}

export interface SnapshotDiffData {
  mode: 'previous' | 'current'
  baseLabel: string
  diff: SnapshotDiff
  empty: boolean
}

function summarizeDiff(diff: SnapshotDiff): SnapshotDiffSummary {
  return {
    nodesAdded: diff.nodesAdded.length,
    nodesRemoved: diff.nodesRemoved.length,
    nodesChanged: diff.nodesChanged.length,
    pipsAdded: diff.pipsAdded.length,
    pipsRemoved: diff.pipsRemoved.length,
    pipsChanged: diff.pipsChanged.length,
    comfyuiChanged: diff.comfyuiChanged,
  }
}

export async function getSnapshotListData(installPath: string): Promise<{ snapshots: SnapshotSummary[]; totalCount: number }> {
  const entries = await listSnapshots(installPath)
  const summaries: SnapshotSummary[] = entries.map((entry, i) => {
    const s = entry.snapshot
    const summary: SnapshotSummary = {
      filename: entry.filename,
      createdAt: s.createdAt,
      trigger: s.trigger,
      label: s.label,
      comfyuiVersion: s.comfyui.displayVersion || s.comfyui.ref,
      nodeCount: s.customNodes.length,
      pipPackageCount: Object.keys(s.pipPackages).length,
    }
    // Diff against the next entry (which is the previous snapshot, since sorted newest-first)
    if (i < entries.length - 1) {
      const prev = entries[i + 1]!.snapshot
      const diff = diffSnapshots(prev, s)
      const ds = summarizeDiff(diff)
      // Only include if there are actual changes
      if (ds.comfyuiChanged || ds.nodesAdded || ds.nodesRemoved || ds.nodesChanged ||
          ds.pipsAdded || ds.pipsRemoved || ds.pipsChanged) {
        summary.diffVsPrevious = ds
      }
    }
    return summary
  })
  return { snapshots: summaries, totalCount: entries.length }
}

export async function getSnapshotDetailData(installPath: string, filename: string): Promise<SnapshotDetailData> {
  const snapshot = await loadSnapshot(installPath, filename)
  return {
    filename,
    createdAt: snapshot.createdAt,
    trigger: snapshot.trigger,
    label: snapshot.label,
    comfyui: snapshot.comfyui,
    pythonVersion: snapshot.pythonVersion,
    updateChannel: snapshot.updateChannel,
    customNodes: snapshot.customNodes,
    pipPackageCount: Object.keys(snapshot.pipPackages).length,
    pipPackages: snapshot.pipPackages,
  }
}

export async function getSnapshotDiffVsPrevious(installPath: string, filename: string): Promise<SnapshotDiffData> {
  const entries = await listSnapshots(installPath)
  const idx = entries.findIndex((e) => e.filename === filename)
  if (idx < 0) throw new Error(`Snapshot not found: ${filename}`)
  if (idx >= entries.length - 1) {
    // This is the oldest snapshot — no previous to diff against
    return {
      mode: 'previous',
      baseLabel: '',
      diff: { comfyuiChanged: false, nodesAdded: [], nodesRemoved: [], nodesChanged: [], pipsAdded: [], pipsRemoved: [], pipsChanged: [] },
      empty: true,
    }
  }
  const current = entries[idx]!.snapshot
  const prev = entries[idx + 1]!.snapshot
  const diff = diffSnapshots(prev, current)
  const prevDate = new Date(prev.createdAt).toLocaleString()
  return {
    mode: 'previous',
    baseLabel: prevDate,
    diff,
    empty: !diff.comfyuiChanged && diff.nodesAdded.length === 0 && diff.nodesRemoved.length === 0 &&
           diff.nodesChanged.length === 0 && diff.pipsAdded.length === 0 && diff.pipsRemoved.length === 0 &&
           diff.pipsChanged.length === 0,
  }
}
