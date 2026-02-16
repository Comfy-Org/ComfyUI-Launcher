const fs = require("fs");
const path = require("path");

/**
 * Create a cache instance configured with a directory and max folder count.
 * Each cached download is stored in its own subdirectory, which may contain
 * one or more files (e.g. split archives).
 * @param {string} dir - cache directory path
 * @param {number} max - maximum number of cached folders
 */
function createCache(dir, max) {
  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  function getCachePath(folder) {
    ensureDir();
    return path.join(dir, folder);
  }

  function evict() {
    ensureDir();
    const folders = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const fullPath = path.join(dir, d.name);
        const stat = fs.statSync(fullPath);
        return { name: d.name, fullPath, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    while (folders.length > max) {
      const old = folders.pop();
      fs.rmSync(old.fullPath, { recursive: true, force: true });
    }
  }

  function touch(folder) {
    const folderPath = path.join(dir, folder);
    if (fs.existsSync(folderPath)) {
      const now = new Date();
      fs.utimesSync(folderPath, now, now);
    }
  }

  return { getCachePath, evict, touch };
}

module.exports = { createCache };
