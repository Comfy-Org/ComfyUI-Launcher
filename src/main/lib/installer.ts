import fs from 'fs'
import path from 'path'
import { formatTime } from './util'
import { t } from './i18n'
import type { Cache } from './cache'
import { isDownloadComplete } from './download'
import type { DownloadProgress } from './download'
import type { ExtractProgress } from './extract'

interface InstallerContext {
  sendProgress: (step: string, data: { percent: number; status: string }) => void
  download: (
    url: string,
    dest: string,
    onProgress: ((p: DownloadProgress) => void) | null,
    options?: { signal?: AbortSignal; expectedSize?: number }
  ) => Promise<string>
  cache: Cache
  extract: (
    archivePath: string,
    dest: string,
    onProgress?: ((p: ExtractProgress) => void) | null,
    options?: { signal?: AbortSignal }
  ) => Promise<void>
  signal?: AbortSignal
}

interface DownloadFile {
  url: string
  filename: string
  size: number
}

function isCacheValid(cachePath: string, expectedSize?: number): boolean {
  if (!isDownloadComplete(cachePath)) return false
  if (expectedSize && expectedSize > 0) {
    try {
      return fs.statSync(cachePath).size === expectedSize
    } catch {
      return false
    }
  }
  return true
}

export async function downloadAndExtract(
  url: string,
  dest: string,
  cacheKey: string,
  ctx: InstallerContext,
  expectedSize?: number
): Promise<void> {
  const { sendProgress, download, cache, extract, signal } = ctx
  const filename = url.split('/').pop()!
  const cacheBase = cache.getCachePath(cacheKey)
  fs.mkdirSync(cacheBase, { recursive: true })
  const cachePath = path.join(cacheBase, filename)

  if (isCacheValid(cachePath, expectedSize)) {
    sendProgress('download', { percent: 100, status: t('installer.cachedDownload') })
    cache.touch(cacheKey)
  } else {
    sendProgress('download', { percent: 0, status: t('installer.startingDownload') })
    await download(
      url,
      cachePath,
      (p) => {
        const speed = `${p.speedMBs.toFixed(1)} MB/s`
        const elapsed = formatTime(p.elapsedSecs)
        const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : '—'
        sendProgress('download', {
          percent: p.percent,
          status: t('installer.downloading', {
            progress: `${p.receivedMB} / ${p.totalMB} MB  ·  ${speed}  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
          }),
        })
      },
      { signal, expectedSize }
    )
    cache.touch(cacheKey)
    cache.evict()
  }

  sendProgress('extract', { percent: 0, status: t('installer.extracting', { progress: '' }).trim() })
  await extract(
    cachePath,
    dest,
    (p) => {
      const elapsed = formatTime(p.elapsedSecs)
      const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : '—'
      sendProgress('extract', {
        percent: p.percent,
        status: t('installer.extracting', {
          progress: `${p.percent}%  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
        }),
      })
    },
    { signal }
  )
}

export async function downloadAndExtractMulti(
  files: DownloadFile[],
  dest: string,
  cacheDir: string,
  ctx: InstallerContext
): Promise<void> {
  const { sendProgress, download, cache, extract, signal } = ctx
  const cacheBase = cache.getCachePath(cacheDir)
  fs.mkdirSync(cacheBase, { recursive: true })

  const count = files.length
  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0)
  const totalMB = totalBytes > 0 ? (totalBytes / 1048576).toFixed(0) : null
  let completedBytes = 0
  let allCached = true
  const overallStart = Date.now()

  for (let i = 0; i < count; i++) {
    const file = files[i]!
    const fileCachePath = path.join(cacheBase, file.filename)
    const fileLabel = count > 1 ? ` (${i + 1}/${count})` : ''

    if (isCacheValid(fileCachePath, file.size)) {
      completedBytes += file.size || 0
      const percent =
        totalBytes > 0
          ? Math.round((completedBytes / totalBytes) * 100)
          : Math.round(((i + 1) / count) * 100)
      sendProgress('download', { percent, status: `${t('installer.cachedDownload')}${fileLabel}` })
    } else {
      allCached = false
      const basePercent =
        totalBytes > 0
          ? Math.round((completedBytes / totalBytes) * 100)
          : Math.round((i / count) * 100)
      sendProgress('download', {
        percent: basePercent,
        status: `${t('installer.startingDownload')}${fileLabel}`,
      })
      await download(
        file.url,
        fileCachePath,
        (p) => {
          const speed = `${p.speedMBs.toFixed(1)} MB/s`
          const overallElapsed = (Date.now() - overallStart) / 1000
          const elapsed = formatTime(overallElapsed)
          const receivedTotal = completedBytes + p.receivedBytes
          const overallSpeed = overallElapsed > 0 ? receivedTotal / 1048576 / overallElapsed : 0
          const remainingBytes = totalBytes - receivedTotal
          const eta =
            overallSpeed > 0 && totalBytes > 0
              ? formatTime(remainingBytes / 1048576 / overallSpeed)
              : '—'
          const sizeDisplay = totalMB
            ? `${(receivedTotal / 1048576).toFixed(0)} / ${totalMB} MB`
            : `${p.receivedMB} / ${p.totalMB} MB`
          const percent =
            totalBytes > 0
              ? Math.round((receivedTotal / totalBytes) * 100)
              : Math.round(((i + p.percent / 100) / count) * 100)
          sendProgress('download', {
            percent,
            status: t('installer.downloading', {
              progress: `${fileLabel} ${sizeDisplay}  ·  ${speed}  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
            }),
          })
        },
        { signal, expectedSize: file.size || undefined }
      )
      completedBytes += file.size || 0
    }
  }

  cache.touch(cacheDir)
  if (!allCached) {
    cache.evict()
  }

  const firstFile = files[0]
  const extractFile =
    files.length === 1
      ? firstFile!.filename
      : [...files].sort((a, b) => a.filename.localeCompare(b.filename)).find((f) => /\.001$/.test(f.filename))
            ?.filename ?? firstFile!.filename
  const extractPath = path.join(cacheBase, extractFile)

  sendProgress('extract', { percent: 0, status: t('installer.extracting', { progress: '' }).trim() })
  await extract(
    extractPath,
    dest,
    (p) => {
      const elapsed = formatTime(p.elapsedSecs)
      const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : '—'
      sendProgress('extract', {
        percent: p.percent,
        status: t('installer.extracting', {
          progress: `${p.percent}%  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
        }),
      })
    },
    { signal }
  )
}
