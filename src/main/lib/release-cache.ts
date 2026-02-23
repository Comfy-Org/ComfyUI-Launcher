/**
 * Shared release info cache.
 *
 * Stores the latest release metadata (latestTag, releaseName, releaseNotes, etc.)
 * keyed by remote identity (repo + track), so multiple installations pointing at
 * the same upstream share a single check result.
 *
 * The cache is kept in memory for fast synchronous reads (getDetailSections,
 * getStatusTag) and persisted to release-cache.json asynchronously.
 */

import path from 'path'
import fs from 'fs'
import { dataDir } from './paths'
import { fetchLatestRelease, truncateNotes } from './comfyui-releases'

export interface ReleaseCacheEntry {
  checkedAt?: number
  latestTag?: string
  releaseName?: string
  releaseNotes?: string
  releaseUrl?: string
  publishedAt?: string
  installedTag?: string
  [key: string]: unknown
}

const CACHE_FILE = path.join(dataDir(), 'release-cache.json')

// In-memory state, loaded once at startup
let _entries: Record<string, ReleaseCacheEntry> = {}
let _loaded: boolean = false

function _ensureLoaded(): void {
  if (_loaded) return
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
    _entries = (raw.entries as Record<string, ReleaseCacheEntry>) || {}
  } catch {
    _entries = {}
  }
  _loaded = true
}

function _persist(): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    const tmp = CACHE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, entries: _entries }, null, 2))
    fs.renameSync(tmp, CACHE_FILE)
  } catch {
    // ignore persist errors
  }
}

/**
 * Build a cache key from a remote identity.
 * Today: "github:Comfy-Org/ComfyUI:stable"
 * Future: could include branch/ref overrides per installation.
 */
export function makeKey(repo: string, track: string): string {
  return `github:${repo}:${track}`
}

/**
 * Get cached release info (synchronous — reads from memory).
 * Returns the entry object or null.
 */
export function get(repo: string, track: string): ReleaseCacheEntry | null {
  _ensureLoaded()
  return _entries[makeKey(repo, track)] ?? null
}

/**
 * Store release info and persist to disk.
 */
export function set(repo: string, track: string, entry: ReleaseCacheEntry): void {
  _ensureLoaded()
  _entries[makeKey(repo, track)] = entry
  _persist()
}

// Single-flight deduplication: key -> Promise
const _inFlight: Map<string, Promise<ReleaseCacheEntry | null>> = new Map()

// Minimum interval between forced refetches for the same key (in ms).
// Prevents spamming the GitHub API and triggering secondary rate limits.
const MIN_RECHECK_INTERVAL = 10_000

/**
 * Fetch release info, deduplicating concurrent calls for the same key.
 * @param repo - e.g. "Comfy-Org/ComfyUI"
 * @param track - "stable" or "latest"
 * @param fetchFn - async () => entry (calls the GitHub API)
 * @param force - bypass cache
 * @returns the release entry
 */
export async function getOrFetch(
  repo: string,
  track: string,
  fetchFn: () => Promise<ReleaseCacheEntry | null>,
  force: boolean = false
): Promise<ReleaseCacheEntry | null> {
  const key = makeKey(repo, track)
  _ensureLoaded()

  const cached = _entries[key]
  if (!force) {
    if (cached) return cached
  } else if (cached?.checkedAt && Date.now() - cached.checkedAt < MIN_RECHECK_INTERVAL) {
    return cached
  }

  // Single-flight: if another call is already fetching this key, wait for it
  if (_inFlight.has(key)) {
    return _inFlight.get(key)!
  }

  const promise = (async () => {
    try {
      const entry = await fetchFn()
      if (entry) {
        _entries[key] = entry
        _persist()
      }
      return entry
    } finally {
      _inFlight.delete(key)
    }
  })()

  _inFlight.set(key, promise)
  return promise
}

/**
 * Build effective update info by merging the shared release cache (remote info)
 * with per-installation state (installedTag).
 */
export function getEffectiveInfo(
  repo: string,
  track: string,
  installation: Record<string, unknown>
): (ReleaseCacheEntry & { installedTag: string }) | null {
  const cached = get(repo, track)
  if (!cached) return null
  const updateInfoByTrack = installation.updateInfoByTrack as
    | Record<string, Record<string, unknown>>
    | undefined
  const perInstall = updateInfoByTrack?.[track]
  const installedTag =
    (perInstall?.installedTag as string | undefined) ??
    (installation.version as string | undefined) ??
    'unknown'
  return { ...cached, installedTag }
}

/**
 * Shared check-update action handler. Fetches the latest release info into the
 * cache and persists the per-installation installedTag.
 */
export async function checkForUpdate(
  repo: string,
  track: string,
  installation: Record<string, unknown>,
  update: (data: Record<string, unknown>) => Promise<void>
): Promise<{ ok: boolean; navigate?: string; message?: string }> {
  const entry = await getOrFetch(
    repo,
    track,
    async () => {
      const release = await fetchLatestRelease(track)
      if (!release) return null
      return {
        checkedAt: Date.now(),
        latestTag: release.tag_name as string,
        releaseName: (release.name as string) || (release.tag_name as string),
        releaseNotes: truncateNotes(release.body as string, 4000),
        releaseUrl: release.html_url as string,
        publishedAt: release.published_at as string,
      }
    },
    /* force */ true
  )
  if (!entry) {
    return { ok: false, message: 'Could not fetch releases from GitHub.' }
  }
  const existing = (installation.updateInfoByTrack as Record<string, Record<string, unknown>>) || {}
  const prevTrackInfo = existing[track]
  const installedTag =
    (prevTrackInfo?.installedTag as string | undefined) ??
    (installation.version as string | undefined) ??
    'unknown'
  await update({
    updateInfoByTrack: {
      ...existing,
      [track]: { installedTag },
    },
  })
  return { ok: true, navigate: 'detail' }
}

/**
 * Determine if an update is available for the given track, using local data only.
 * Handles cross-track switches (e.g. last update was on "latest" but viewing "stable").
 */
export function isUpdateAvailable(
  installation: Record<string, unknown>,
  track: string,
  info: ReleaseCacheEntry | null
): boolean {
  if (!info || !info.latestTag) return false
  // Cross-track: last update was on a different track, so this track's installedTag is stale
  const lastRollback = installation.lastRollback as
    | Record<string, unknown>
    | undefined
  const lastUpdateTrack = lastRollback?.track as string | undefined
  if (lastUpdateTrack && lastUpdateTrack !== track) return true
  // Installed version string shows commits ahead of the stable tag (e.g. "v0.14.2 + 21 commits")
  const version = (installation.version as string) || ''
  if (track === 'stable' && version.includes(info.latestTag + ' +')) return true
  // Raw tag/sha mismatch
  if (info.installedTag && info.installedTag !== info.latestTag) return true
  return false
}
