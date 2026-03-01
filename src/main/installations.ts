import path from 'path'
import { dataDir } from './lib/paths'
import { readFileSafeAsync, writeFileSafeAsync } from './lib/safe-file'

export interface InstallationRecord {
  id: string
  name: string
  createdAt: string
  installPath: string
  sourceId: string
  status?: string
  seen?: boolean
  version?: string
  [key: string]: unknown
}

const dataPath = path.join(dataDir(), "installations.json")

// Serialize all load/save operations to prevent concurrent read-modify-write races
let _queue: Promise<void> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = _queue.then(fn)
  _queue = p.then(() => {}, () => {})
  return p
}

async function load(): Promise<InstallationRecord[]> {
  const raw = await readFileSafeAsync(dataPath)
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as InstallationRecord[]
    } catch {}
  }
  return []
}

async function save(installations: InstallationRecord[]): Promise<void> {
  await writeFileSafeAsync(dataPath, JSON.stringify(installations, null, 2), true)
}

export async function list(): Promise<InstallationRecord[]> {
  return load()
}

export function uniqueName(baseName: string, existing: InstallationRecord[], excludeId?: string): string {
  const names = new Set(existing.filter((i) => i.id !== excludeId).map((i) => i.name))
  if (!names.has(baseName)) return baseName
  let suffix = 1
  while (names.has(`${baseName} (${suffix})`)) suffix++
  return `${baseName} (${suffix})`
}

export async function add(installation: Record<string, unknown>): Promise<InstallationRecord> {
  return enqueue(async () => {
    const installations = await load()
    installation.name = uniqueName(installation.name as string, installations)
    const entry = {
      id: `inst-${Date.now()}`,
      createdAt: new Date().toISOString(),
      ...installation,
    } as InstallationRecord
    installations.unshift(entry)
    await save(installations)
    return entry
  })
}

export async function remove(id: string): Promise<void> {
  return enqueue(async () => {
    const installations = (await load()).filter((i) => i.id !== id)
    await save(installations)
  })
}

export async function update(id: string, data: Record<string, unknown>): Promise<InstallationRecord | null> {
  return enqueue(async () => {
    const installations = await load()
    const index = installations.findIndex((i) => i.id === id)
    if (index === -1) return null
    const existing = installations[index]!
    installations[index] = { ...existing, ...data } as InstallationRecord
    await save(installations)
    return installations[index]!
  })
}

export async function get(id: string): Promise<InstallationRecord | null> {
  return (await load()).find((i) => i.id === id) ?? null
}

export async function reorder(orderedIds: string[]): Promise<void> {
  return enqueue(async () => {
    const installations = await load()
    const byId: Record<string, InstallationRecord> = Object.fromEntries(installations.map((i) => [i.id, i]))
    const reordered: InstallationRecord[] = orderedIds
      .map((id) => byId[id])
      .filter((inst): inst is InstallationRecord => inst != null)
    // Append any installations not in the provided list (safety net)
    for (const inst of installations) {
      if (!orderedIds.includes(inst.id)) reordered.push(inst)
    }
    await save(reordered)
  })
}

export async function ensureExists(sourceId: string, data: Record<string, unknown>): Promise<void> {
  return enqueue(async () => {
    const existing = await load()
    if (existing.some((i) => i.sourceId === sourceId)) return
    existing.push({
      id: `inst-${Date.now()}`,
      createdAt: new Date().toISOString(),
      ...data,
    } as InstallationRecord)
    await save(existing)
  })
}

export async function seedDefaults(defaults: Record<string, unknown>[]): Promise<void> {
  return enqueue(async () => {
    const installations = await load()
    if (installations.length > 0) return
    for (const entry of defaults) {
      installations.push({
        id: `inst-${Date.now()}`,
        createdAt: new Date().toISOString(),
        status: "installed",
        ...entry,
      } as InstallationRecord)
    }
    if (installations.length > 0) await save(installations)
  })
}
