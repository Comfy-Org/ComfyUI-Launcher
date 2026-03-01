import fs from 'fs'
import path from 'path'
import { META_SUFFIX } from './download'

export interface Cache {
  getCachePath(folder: string): string
  evict(): void
  touch(folder: string): void
  cleanPartials(maxAgeMs?: number): void
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

  function cleanPartials(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    ensureDir()
    const cutoff = Date.now() - maxAgeMs
    try {
      const folders = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
      for (const folder of folders) {
        const folderPath = path.join(dir, folder.name)
        try {
          const entries = fs.readdirSync(folderPath, { withFileTypes: true })
          for (const entry of entries) {
            if (!entry.isFile()) continue
            if (!entry.name.endsWith(META_SUFFIX)) continue
            const metaFilePath = path.join(folderPath, entry.name)
            try {
              const stat = fs.statSync(metaFilePath)
              if (stat.mtimeMs < cutoff) {
                // Remove both the meta file and the associated incomplete data file
                const dataFilePath = metaFilePath.slice(0, -META_SUFFIX.length)
                try { fs.unlinkSync(dataFilePath) } catch {}
                fs.unlinkSync(metaFilePath)
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  return { getCachePath, evict, touch, cleanPartials }
}
