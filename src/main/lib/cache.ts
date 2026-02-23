import fs from 'fs'
import path from 'path'

export interface Cache {
  getCachePath(folder: string): string
  evict(): void
  touch(folder: string): void
}

export function createCache(dir: string, max: number): Cache {
  function ensureDir(): void {
    fs.mkdirSync(dir, { recursive: true })
  }

  function getCachePath(folder: string): string {
    ensureDir()
    return path.join(dir, folder)
  }

  function evict(): void {
    ensureDir()
    const folders = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const fullPath = path.join(dir, d.name)
        const stat = fs.statSync(fullPath)
        return { name: d.name, fullPath, mtime: stat.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime) // newest first

    while (folders.length > max) {
      const old = folders.pop()
      if (old) {
        fs.rmSync(old.fullPath, { recursive: true, force: true })
      }
    }
  }

  function touch(folder: string): void {
    const folderPath = path.join(dir, folder)
    if (fs.existsSync(folderPath)) {
      const now = new Date()
      fs.utimesSync(folderPath, now, now)
    }
  }

  return { getCachePath, evict, touch }
}
