const fs = require("fs");
const path = require("path");

/**
 * Create a cache instance configured with a directory and max file count.
 * @param {string} dir - cache directory path
 * @param {number} max - maximum number of cached files
 */
function createCache(dir, max) {
  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  function getCachePath(filename) {
    ensureDir();
    return path.join(dir, filename);
  }

  function isCached(filename) {
    return fs.existsSync(getCachePath(filename));
  }

  function evict() {
    ensureDir();
    const files = fs.readdirSync(dir)
      .map((name) => {
        const fullPath = path.join(dir, name);
        const stat = fs.statSync(fullPath);
        return { name, fullPath, mtime: stat.mtimeMs, isDir: stat.isDirectory() };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    while (files.length > max) {
      const old = files.pop();
      if (old.isDir) {
        fs.rmSync(old.fullPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(old.fullPath);
      }
    }
  }

  function touch(filename) {
    const p = getCachePath(filename);
    if (fs.existsSync(p)) {
      const now = new Date();
      fs.utimesSync(p, now, now);
    }
  }

  return { getCachePath, isCached, evict, touch };
}

module.exports = { createCache };
