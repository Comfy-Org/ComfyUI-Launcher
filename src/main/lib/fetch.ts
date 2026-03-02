import { net } from 'electron'
import path from 'path'
import fs from 'fs'
import { cacheDir } from './paths'
import { writeFileSafe } from './safe-file'

interface CacheEntry {
  etag: string
  data: unknown
}

// ETag cache: url -> { etag, data }
// Persisted to disk so cached responses survive app restarts.
// Bounded to MAX_CACHE_SIZE entries; oldest evicted first.
const MAX_CACHE_SIZE = 100
const CACHE_FILE = path.join(cacheDir(), "fetch-cache.json")

const _cache: Map<string, CacheEntry> = new Map()
let _loaded = false

function _ensureLoaded(): void {
  if (_loaded) return
  _loaded = true
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"))
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [url, entry] of Object.entries(raw as Record<string, unknown>)) {
        if (
          entry &&
          typeof entry === "object" &&
          "etag" in entry &&
          typeof (entry as CacheEntry).etag === "string" &&
          "data" in entry
        ) {
          _cache.set(url, entry as CacheEntry)
        }
      }
    }
  } catch {
    // ignore — cache file may not exist yet
  }
}

function _persist(): void {
  try {
    const obj: Record<string, CacheEntry> = {}
    for (const [url, entry] of _cache) {
      obj[url] = entry
    }
    writeFileSafe(CACHE_FILE, JSON.stringify(obj))
  } catch {
    // ignore — best-effort persistence
  }
}

function _cacheSet(url: string, entry: CacheEntry): void {
  _cache.delete(url) // refresh insertion order
  _cache.set(url, entry)
  if (_cache.size > MAX_CACHE_SIZE) {
    const oldest = _cache.keys().next().value
    if (oldest !== undefined) {
      _cache.delete(oldest)
    }
  }
  _persist()
}

function _headerString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

export function fetchJSON(url: string): Promise<unknown> {
  _ensureLoaded()
  const cached = _cache.get(url)

  return new Promise((resolve, reject) => {
    // Use cache: "no-cache" so Chromium always revalidates with the server
    // (sends If-None-Match), rather than silently serving from its disk cache.
    // GitHub returns 304 for free (no rate limit cost) when the ETag matches.
    const request = net.request({ url, cache: "no-cache" })
    request.setHeader("User-Agent", "ComfyUI-Launcher")

    if (cached?.etag) {
      request.setHeader("If-None-Match", cached.etag)
    }

    let data = ""
    request.on("response", (response) => {
      response.on("data", (chunk) => (data += chunk.toString()))
      response.on("end", () => {
        if (response.statusCode === 304 && cached) {
          resolve(structuredClone(cached.data))
          return
        }
        if (response.statusCode !== 200) {
          // On error, fall back to cached data if available
          if (cached) {
            resolve(structuredClone(cached.data))
            return
          }
          let msg = `HTTP ${response.statusCode}`
          if (response.statusCode === 403 || response.statusCode === 429) {
            const resetHeader = _headerString(response.headers["x-ratelimit-reset"])
            const retryAfter = _headerString(response.headers["retry-after"])
            let resetSecs: number | undefined
            if (resetHeader) {
              resetSecs = Math.max(0, Math.ceil(Number(resetHeader) - Date.now() / 1000))
            } else if (retryAfter) {
              resetSecs = Math.max(0, Math.ceil(Number(retryAfter)))
            }
            if (resetSecs != null) {
              const mins = Math.ceil(resetSecs / 60)
              msg += ` (rate limited — resets in ${mins} minute${mins !== 1 ? "s" : ""})`
            } else {
              msg += " (rate limited)"
            }
          }
          reject(new Error(msg))
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          if (cached) {
            resolve(structuredClone(cached.data))
            return
          }
          reject(new Error(`Invalid JSON response from ${url}`))
          return
        }
        const etag = _headerString(response.headers["etag"])
        if (etag) {
          _cacheSet(url, { etag, data: parsed })
        }
        resolve(parsed)
      })
    })
    request.on("error", (err) => {
      // Network error — fall back to cached data if available
      if (cached) {
        resolve(structuredClone(cached.data))
        return
      }
      reject(err)
    })
    request.end()
  })
}
