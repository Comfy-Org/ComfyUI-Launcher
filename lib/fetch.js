const { net } = require("electron");

// In-memory ETag cache: url -> { etag, data }
const _cache = new Map();

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    // Use cache: "no-cache" so Chromium always revalidates with the server
    // (sends If-None-Match), rather than silently serving from its disk cache.
    // GitHub returns 304 for free (no rate limit cost) when the ETag matches.
    const request = net.request({ url, cache: "no-cache" });
    request.setHeader("User-Agent", "ComfyUI-Launcher");

    const cached = _cache.get(url);
    if (cached?.etag) {
      request.setHeader("If-None-Match", cached.etag);
    }

    let data = "";
    request.on("response", (response) => {
      response.on("data", (chunk) => (data += chunk.toString()));
      response.on("end", () => {
        if (response.statusCode === 304 && cached) {
          resolve(cached.data);
          return;
        }
        if (response.statusCode !== 200) {
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
          _cache.set(url, { etag, data: parsed });
        }
        resolve(parsed);
      });
    });
    request.on("error", reject);
    request.end();
  });
}

module.exports = { fetchJSON };
