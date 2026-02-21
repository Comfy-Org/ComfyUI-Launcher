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

const path = require("path");
const fs = require("fs");
const paths = require("./paths");

const CACHE_FILE = path.join(paths.dataDir(), "release-cache.json");

// In-memory state, loaded once at startup
let _entries = {};
let _loaded = false;

function _ensureLoaded() {
  if (_loaded) return;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    _entries = raw.entries || {};
  } catch {
    _entries = {};
  }
  _loaded = true;
}

function _persist() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = CACHE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, entries: _entries }, null, 2));
    fs.renameSync(tmp, CACHE_FILE);
  } catch {}
}

/**
 * Build a cache key from a remote identity.
 * Today: "github:Comfy-Org/ComfyUI:stable"
 * Future: could include branch/ref overrides per installation.
 */
function makeKey(repo, track) {
  return `github:${repo}:${track}`;
}

/**
 * Get cached release info (synchronous — reads from memory).
 * Returns the entry object or null.
 */
function get(repo, track) {
  _ensureLoaded();
  return _entries[makeKey(repo, track)] || null;
}

/**
 * Store release info and persist to disk.
 */
function set(repo, track, entry) {
  _ensureLoaded();
  _entries[makeKey(repo, track)] = entry;
  _persist();
}

// Single-flight deduplication: key -> Promise
const _inFlight = new Map();

/**
 * Fetch release info, deduplicating concurrent calls for the same key.
 * @param {string} repo - e.g. "Comfy-Org/ComfyUI"
 * @param {string} track - "stable" or "latest"
 * @param {Function} fetchFn - async () => entry (calls the GitHub API)
 * @param {boolean} [force=false] - bypass cache
 * @returns {Promise<object|null>} the release entry
 */
async function getOrFetch(repo, track, fetchFn, force = false) {
  const key = makeKey(repo, track);
  _ensureLoaded();

  if (!force) {
    const cached = _entries[key];
    if (cached) return cached;
  }

  // Single-flight: if another call is already fetching this key, wait for it
  if (_inFlight.has(key)) {
    return _inFlight.get(key);
  }

  const promise = (async () => {
    try {
      const entry = await fetchFn();
      if (entry) {
        _entries[key] = entry;
        _persist();
      }
      return entry;
    } finally {
      _inFlight.delete(key);
    }
  })();

  _inFlight.set(key, promise);
  return promise;
}

/**
 * Build effective update info by merging the shared release cache (remote info)
 * with per-installation state (installedTag).
 */
function getEffectiveInfo(repo, track, installation) {
  const cached = get(repo, track);
  if (!cached) return null;
  const perInstall = installation.updateInfoByTrack && installation.updateInfoByTrack[track];
  const installedTag = perInstall?.installedTag || installation.version || "unknown";
  return { ...cached, installedTag };
}

/**
 * Shared check-update action handler. Fetches the latest release info into the
 * cache and persists the per-installation installedTag.
 * @param {string} repo
 * @param {string} track
 * @param {object} installation
 * @param {Function} update - persists installation fields
 * @returns {Promise<{ok: boolean, navigate?: string, message?: string}>}
 */
async function checkForUpdate(repo, track, installation, update) {
  const { fetchLatestRelease, truncateNotes } = require("./comfyui-releases");
  const entry = await getOrFetch(repo, track, async () => {
    const release = await fetchLatestRelease(track);
    if (!release) return null;
    return {
      checkedAt: Date.now(),
      latestTag: release.tag_name,
      releaseName: release.name || release.tag_name,
      releaseNotes: truncateNotes(release.body, 4000),
      releaseUrl: release.html_url,
      publishedAt: release.published_at,
    };
  }, /* force */ true);
  if (!entry) {
    return { ok: false, message: "Could not fetch releases from GitHub." };
  }
  const existing = installation.updateInfoByTrack || {};
  const prevTrackInfo = existing[track];
  const installedTag = prevTrackInfo?.installedTag || installation.version || "unknown";
  await update({
    updateInfoByTrack: {
      ...existing,
      [track]: { installedTag },
    },
  });
  return { ok: true, navigate: "detail" };
}

module.exports = { get, set, getOrFetch, makeKey, getEffectiveInfo, checkForUpdate };
