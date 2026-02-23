import fs from 'fs'
import path from 'path'

interface CollectResult {
  files: string[]
  symlinks: string[]
}

export async function collectFiles(dir: string): Promise<CollectResult> {
  const files: string[] = []
  const symlinks: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    const items = await fs.promises.readdir(current, { withFileTypes: true })
    for (const item of items) {
      const full = path.join(current, item.name)
      if (item.isSymbolicLink()) {
        symlinks.push(path.relative(dir, full))
      } else if (item.isDirectory()) {
        stack.push(full)
      } else {
        files.push(path.relative(dir, full))
      }
    }
  }
  return { files, symlinks }
}

export async function copyDirWithProgress(
  src: string,
  dest: string,
  onProgress: ((copied: number, total: number, elapsedSecs: number, etaSecs: number) => void) | null,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const { files, symlinks } = await collectFiles(src)
  const total = files.length + symlinks.length
  let copied = 0
  const step = Math.max(1, Math.floor(total / 100))
  const concurrency = 50
  const dirPromises = new Map<string, Promise<string | undefined>>()
  const startTime = Date.now()
  const signal = options?.signal

  const ensureDir = (dir: string): Promise<string | undefined> => {
    const existing = dirPromises.get(dir)
    if (existing) return existing
    const p = fs.promises.mkdir(dir, { recursive: true })
    dirPromises.set(dir, p)
    return p
  }

  const reportProgress = (): void => {
    if (onProgress && (copied % step === 0 || copied === total)) {
      const elapsedSecs = (Date.now() - startTime) / 1000
      const etaSecs = copied > 0 ? elapsedSecs * ((total - copied) / copied) : -1
      onProgress(copied, total, elapsedSecs, etaSecs)
    }
  }

  let i = 0
  while (i < files.length) {
    if (signal?.aborted) throw new Error("Cancelled")
    const batch = files.slice(i, i + concurrency)
    await Promise.all(batch.map(async (rel) => {
      const destPath = path.join(dest, rel)
      await ensureDir(path.dirname(destPath))
      await fs.promises.copyFile(path.join(src, rel), destPath)
      copied++
      reportProgress()
    }))
    i += concurrency
  }

  // Recreate symlinks, rewriting absolute targets that point inside src
  for (const rel of symlinks) {
    if (signal?.aborted) throw new Error("Cancelled")
    const srcLink = path.join(src, rel)
    const destLink = path.join(dest, rel)
    await ensureDir(path.dirname(destLink))
    let target = await fs.promises.readlink(srcLink)
    if (path.isAbsolute(target)) {
      const relToSrc = path.relative(src, target)
      if (!relToSrc.startsWith("..") && !path.isAbsolute(relToSrc)) {
        target = path.join(dest, relToSrc)
      }
    }
    try {
      await fs.promises.symlink(target, destLink)
    } catch {}
    copied++
    reportProgress()
  }
}
