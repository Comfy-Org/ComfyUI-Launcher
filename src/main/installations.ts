import path from 'path'
import { dataDir } from './lib/paths'
import { readFileSafeAsync, writeFileSafeAsync } from './lib/safe-file'
import type { ComfyVersion } from './lib/version'
import { machineDataDir, normalizeInstallationScope } from './lib/machine-install'
import type { InstallationScope } from './lib/machine-install'

export interface InstallationRecord {
  id: string
  name: string
  createdAt: string
  installPath: string
  sourceId: string
  scope?: InstallationScope
  status?: string
  seen?: boolean
  comfyVersion?: ComfyVersion
  [key: string]: unknown
}

const USER_DATA_PATH = path.join(dataDir(), "installations.json")
const MACHINE_DATA_PATH = path.join(machineDataDir(), "installations.json")

// Serialize all load/save operations to prevent concurrent read-modify-write races
let _queue: Promise<void> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = _queue.then(fn)
  _queue = p.then(() => {}, () => {})
  return p
}

function pathForScope(scope: InstallationScope): string {
  return scope === 'machine' ? MACHINE_DATA_PATH : USER_DATA_PATH
}

function normalizeEntry(entry: InstallationRecord, fallbackScope: InstallationScope): InstallationRecord {
  return {
    ...entry,
    scope: normalizeInstallationScope(entry.scope ?? fallbackScope),
  }
}

async function loadScope(scope: InstallationScope): Promise<InstallationRecord[]> {
  const raw = await readFileSafeAsync(pathForScope(scope))
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((entry) => normalizeEntry(entry as InstallationRecord, scope))
      }
    } catch {}
  }
  return []
}

async function saveScope(scope: InstallationScope, installations: InstallationRecord[]): Promise<void> {
  await writeFileSafeAsync(pathForScope(scope), JSON.stringify(installations, null, 2), true)
}

async function findScopeForId(id: string): Promise<InstallationScope | null> {
  const userInstallations = await loadScope('user')
  if (userInstallations.some((installation) => installation.id === id)) return 'user'
  const machineInstallations = await loadScope('machine')
  if (machineInstallations.some((installation) => installation.id === id)) return 'machine'
  return null
}

export async function list(scope: InstallationScope | 'all' = 'all'): Promise<InstallationRecord[]> {
  if (scope === 'user' || scope === 'machine') return loadScope(scope)

  const [userInstallations, machineInstallations] = await Promise.all([
    loadScope('user'),
    loadScope('machine'),
  ])
  return [...userInstallations, ...machineInstallations]
}

export function uniqueName(baseName: string, existing: InstallationRecord[], excludeId?: string): string {
  const names = new Set(existing.filter((i) => i.id !== excludeId).map((i) => i.name))
  if (!names.has(baseName)) return baseName
  let suffix = 1
  while (names.has(`${baseName} (${suffix})`)) suffix++
  return `${baseName} (${suffix})`
}

export async function add(
  installation: Record<string, unknown>,
  scope: InstallationScope = normalizeInstallationScope(installation.scope)
): Promise<InstallationRecord> {
  return enqueue(async () => {
    const installations = await loadScope(scope)
    installation.name = uniqueName(installation.name as string, installations)
    const entry = {
      id: scope === 'machine' ? `machine-inst-${Date.now()}` : `inst-${Date.now()}`,
      createdAt: new Date().toISOString(),
      ...installation,
      scope,
    } as InstallationRecord
    installations.unshift(entry)
    await saveScope(scope, installations)
    return entry
  })
}

export async function remove(id: string, scope?: InstallationScope): Promise<void> {
  return enqueue(async () => {
    const resolvedScope = scope ?? await findScopeForId(id)
    if (!resolvedScope) return
    const installations = (await loadScope(resolvedScope)).filter((i) => i.id !== id)
    await saveScope(resolvedScope, installations)
  })
}

export async function update(id: string, data: Record<string, unknown>, scope?: InstallationScope): Promise<InstallationRecord | null> {
  return enqueue(async () => {
    const resolvedScope = scope ?? await findScopeForId(id)
    if (!resolvedScope) return null
    const installations = await loadScope(resolvedScope)
    const index = installations.findIndex((i) => i.id === id)
    if (index === -1) return null
    const existing = installations[index]!
    installations[index] = normalizeEntry({ ...existing, ...data } as InstallationRecord, resolvedScope)
    await saveScope(resolvedScope, installations)
    return installations[index]!
  })
}

export async function get(id: string): Promise<InstallationRecord | null> {
  const userInstallations = await loadScope('user')
  const userMatch = userInstallations.find((i) => i.id === id)
  if (userMatch) return userMatch
  return (await loadScope('machine')).find((i) => i.id === id) ?? null
}

export async function reorder(orderedIds: string[]): Promise<void> {
  return enqueue(async () => {
    const installations = await loadScope('user')
    const byId: Record<string, InstallationRecord> = Object.fromEntries(installations.map((i) => [i.id, i]))
    const reordered: InstallationRecord[] = orderedIds
      .map((id) => byId[id])
      .filter((inst): inst is InstallationRecord => inst != null)
    // Append any installations not in the provided list (safety net)
    for (const inst of installations) {
      if (!orderedIds.includes(inst.id)) reordered.push(inst)
    }
    await saveScope('user', reordered)
  })
}

export async function ensureExists(
  sourceId: string,
  data: Record<string, unknown>,
  scope: InstallationScope = normalizeInstallationScope(data.scope)
): Promise<void> {
  return enqueue(async () => {
    const existing = await loadScope(scope)
    if (existing.some((i) => i.sourceId === sourceId)) return
    existing.push({
      id: scope === 'machine' ? `machine-inst-${Date.now()}` : `inst-${Date.now()}`,
      createdAt: new Date().toISOString(),
      ...data,
      scope,
    } as InstallationRecord)
    await saveScope(scope, existing)
  })
}

export async function seedDefaults(defaults: Record<string, unknown>[]): Promise<void> {
  return enqueue(async () => {
    const installations = await loadScope('user')
    if (installations.length > 0) return
    for (const entry of defaults) {
      installations.push({
        id: `inst-${Date.now()}`,
        createdAt: new Date().toISOString(),
        status: "installed",
        ...entry,
        scope: 'user',
      } as InstallationRecord)
    }
    if (installations.length > 0) await saveScope('user', installations)
  })
}
