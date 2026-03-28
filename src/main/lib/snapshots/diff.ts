import path from 'path'
import { hasGitDir } from '../git'
import { resolveInstalledVersion } from '../version-resolve'
import type { LatestTagOverride } from '../version-resolve'
import { formatComfyVersion } from '../version'
import type { ComfyVersion } from '../version'
import { nodeKey } from '../nodes'
import { captureState } from './store'
import type { Snapshot, SnapshotDiff, SnapshotDiffSummary } from './types'
import type { InstallationRecord } from '../../installations'

export function formatSnapshotVersion(comfyui: { ref: string; commit: string | null; baseTag?: string; commitsAhead?: number }, style: 'short' | 'detail'): string {
  if (comfyui.commit) {
    return formatComfyVersion({ commit: comfyui.commit, baseTag: comfyui.baseTag, commitsAhead: comfyui.commitsAhead }, style)
  }
  return comfyui.ref
}

/**
 * Resolve the version for a snapshot's commit from local git state, then
 * format for display.  Falls back to stored baseTag/commitsAhead when git
 * is unavailable or the commit is missing from the repo.
 */
/** Subset of Snapshot['comfyui'] needed for version resolution. */
interface VersionResolvable {
  ref: string
  commit: string | null
  baseTag?: string
  commitsAhead?: number
}

export async function resolveSnapshotVersion(
  installPath: string,
  comfyui: VersionResolvable,
  style: 'short' | 'detail',
  options?: { comfyuiDir?: string; latestTagOverride?: LatestTagOverride },
): Promise<string> {
  if (!comfyui.commit) return comfyui.ref
  const snapshotCv: ComfyVersion = {
    commit: comfyui.commit,
    baseTag: comfyui.baseTag,
    commitsAhead: comfyui.commitsAhead,
  }
  const comfyuiDir = options?.comfyuiDir ?? (installPath ? path.join(installPath, 'ComfyUI') : '')
  if (!comfyuiDir || !hasGitDir(comfyuiDir)) {
    return formatComfyVersion(snapshotCv, style)
  }
  try {
    const resolved = await resolveInstalledVersion(comfyuiDir, comfyui.commit, snapshotCv, undefined, options?.latestTagOverride)
    return formatComfyVersion(resolved, style)
  } catch {
    return formatComfyVersion(snapshotCv, style)
  }
}

export function diffSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff {
  const diff: SnapshotDiff = {
    comfyuiChanged: false,
    updateChannelChanged: false,
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
      from: { ref: a.comfyui.ref, commit: a.comfyui.commit, baseTag: a.comfyui.baseTag, commitsAhead: a.comfyui.commitsAhead, formattedVersion: formatSnapshotVersion(a.comfyui, 'detail') },
      to: { ref: b.comfyui.ref, commit: b.comfyui.commit, baseTag: b.comfyui.baseTag, commitsAhead: b.comfyui.commitsAhead, formattedVersion: formatSnapshotVersion(b.comfyui, 'detail') },
    }
  }

  // Update channel
  const aChannel = a.updateChannel || 'stable'
  const bChannel = b.updateChannel || 'stable'
  if (aChannel !== bChannel) {
    diff.updateChannelChanged = true
    diff.updateChannel = { from: aChannel, to: bChannel }
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
  const diff = diffSnapshots(current, target)
  await resolveDiffVersions(installPath, diff)
  return diff
}

/**
 * Post-process a diff to resolve formattedVersion fields from git state.
 * Mutates diff.comfyui in place.
 */
export async function resolveDiffVersions(installPath: string, diff: SnapshotDiff): Promise<void> {
  if (!diff.comfyui) return
  const [fromVersion, toVersion] = await Promise.all([
    resolveSnapshotVersion(installPath, diff.comfyui.from, 'detail'),
    resolveSnapshotVersion(installPath, diff.comfyui.to, 'detail'),
  ])
  diff.comfyui.from.formattedVersion = fromVersion
  diff.comfyui.to.formattedVersion = toVersion
}

export function summarizeDiff(diff: SnapshotDiff): SnapshotDiffSummary {
  return {
    nodesAdded: diff.nodesAdded.length,
    nodesRemoved: diff.nodesRemoved.length,
    nodesChanged: diff.nodesChanged.length,
    pipsAdded: diff.pipsAdded.length,
    pipsRemoved: diff.pipsRemoved.length,
    pipsChanged: diff.pipsChanged.length,
    comfyuiChanged: diff.comfyuiChanged,
    updateChannelChanged: diff.updateChannelChanged,
  }
}
