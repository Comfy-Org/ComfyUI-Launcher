const { net } = require("electron");
const path = require("path");
const fs = require("fs");
const paths = require("./paths");

// ETag cache: url -> { etag, data }
// Persisted to disk so cached responses survive app restarts.
// Bounded to MAX_CACHE_SIZE entries; oldest evicted first.
const MAX_CACHE_SIZE = 100;
const CACHE_FILE = path.join(paths.cacheDir(), "fetch-cache.json");

let _cache = new Map();
let _loaded = false;

function _ensureLoaded() {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    if (raw && typeof raw === "object") {
      for (const [url, entry] of Object.entries(raw)) {
        _cache.set(url, entry);
      }
    }
  } catch {}
}

function _persist() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const obj = {};
    for (const [url, entry] of _cache) {
      obj[url] = entry;
    }
    const tmp = CACHE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, CACHE_FILE);
  } catch {}
}

function _cacheSet(url, entry) {
  _cache.delete(url); // refresh insertion order
  _cache.set(url, entry);
  if (_cache.size > MAX_CACHE_SIZE) {
    _cache.delete(_cache.keys().next().value);
  }
  _persist();
}

function fetchJSON(url) {
  _ensureLoaded();
  const cached = _cache.get(url);

  return new Promise((resolve, reject) => {
    // Use cache: "no-cache" so Chromium always revalidates with the server
    // (sends If-None-Match), rather than silently serving from its disk cache.
    // GitHub returns 304 for free (no rate limit cost) when the ETag matches.
    const request = net.request({ url, cache: "no-cache" });
    request.setHeader("User-Agent", "ComfyUI-Launcher");

    if (cached?.etag) {
      request.setHeader("If-None-Match", cached.etag);
    }

    let data = "";
    request.on("response", (response) => {
      response.on("data", (chunk) => (data += chunk.toString()));
      response.on("end", () => {
        if (response.statusCode === 304 && cached) {
          resolve(structuredClone(cached.data));
          return;
        }
        if (response.statusCode !== 200) {
          // On error, fall back to cached data if available
          if (cached) {
            resolve(structuredClone(cached.data));
            return;
          }
          let msg = `HTTP ${response.statusCode}`;
          const resetHeader = response.headers["x-ratelimit-reset"];
          if (response.statusCode === 403 && resetHeader) {
            const resetSecs = Math.max(0, Math.ceil(Number(resetHeader) - Date.now() / 1000));
            const mins = Math.ceil(resetSecs / 60);
            msg += ` (rate limited — resets in ${mins} minute${mins !== 1 ? "s" : ""})`;
          }
          reject(new Error(msg));
          return;
        }
        const parsed = JSON.parse(data);
        const etag = response.headers["etag"];
        if (etag) {
          _cacheSet(url, { etag, data: parsed });
        }
        resolve(parsed);
      });
    });
    request.on("error", (err) => {
      // Network error — fall back to cached data if available
      if (cached) {
        resolve(structuredClone(cached.data));
        return;
      }
      reject(err);
    });
    request.end();
  });
}

module.exports = { fetchJSON };
