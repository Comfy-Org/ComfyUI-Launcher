import { net } from 'electron'
import fs from 'fs'
import path from 'path'

export interface DownloadProgress {
  percent: number
  receivedBytes: number
  receivedMB: string
  totalMB: string
  speedMBs: number
  elapsedSecs: number
  etaSecs: number
}

/** Sidecar file stored alongside incomplete downloads for resume support. */
export interface DownloadMeta {
  url: string
  expectedSize: number
  etag?: string
  lastModified?: string
}

interface DownloadOptions {
  signal?: AbortSignal
  expectedSize?: number
  _maxRedirects?: number
}

export const META_SUFFIX = '.dl-meta'

export function downloadMetaPath(filePath: string): string {
  return filePath + META_SUFFIX
}

export function isDownloadComplete(filePath: string): boolean {
  return fs.existsSync(filePath) && !fs.existsSync(downloadMetaPath(filePath))
}

function readMeta(metaPath: string): DownloadMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as DownloadMeta
  } catch {
    return null
  }
}

function writeMeta(metaPath: string, meta: DownloadMeta): void {
  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta))
  } catch {}
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

export function download(
  url: string,
  destPath: string,
  onProgress: ((progress: DownloadProgress) => void) | null,
  options?: DownloadOptions | number
): Promise<string> {
  const opts: DownloadOptions = typeof options === 'number' ? { _maxRedirects: options } : options ?? {}
  const { signal, expectedSize, _maxRedirects = 5 } = opts

  const metaPath = downloadMetaPath(destPath)

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Download cancelled'))
      return
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true })

    // Determine if we can resume from a previous incomplete download
    let resumeFrom = 0
    const existingMeta = readMeta(metaPath)
    if (existingMeta && fs.existsSync(destPath)) {
      if (existingMeta.url === url) {
        try {
          resumeFrom = fs.statSync(destPath).size
        } catch {
          resumeFrom = 0
        }
      }
      if (resumeFrom === 0) {
        // URL mismatch or can't stat — start fresh
        try { fs.unlinkSync(destPath) } catch {}
        try { fs.unlinkSync(metaPath) } catch {}
      } else if (existingMeta.expectedSize > 0 && resumeFrom >= existingMeta.expectedSize) {
        // File is already fully downloaded but meta wasn't cleaned up (crash after write, before meta delete)
        try { fs.unlinkSync(metaPath) } catch {}
        resolve(destPath)
        return
      }
    } else if (fs.existsSync(metaPath)) {
      // Stale meta without data file
      try { fs.unlinkSync(metaPath) } catch {}
    }

    const request = net.request(url)
    request.setHeader('User-Agent', 'ComfyUI-Launcher')
    if (resumeFrom > 0 && existingMeta?.etag) {
      request.setHeader('Range', `bytes=${resumeFrom}-`)
      request.setHeader('If-Range', existingMeta.etag)
    }

    let aborted = false
    let settled = false
    const safeResolve = (v: string): void => { if (!settled) { settled = true; resolve(v) } }
    const safeReject = (e: Error): void => { if (!settled) { settled = true; reject(e) } }

    const onAbort = (): void => {
      aborted = true
      request.abort()
      // Keep files + meta on abort so we can resume later
      safeReject(new Error('Download cancelled'))
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    const cleanup = (): void => {
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    request.on('response', (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        cleanup()
        if (_maxRedirects <= 0) {
          safeReject(new Error('Download failed: too many redirects'))
          return
        }
        const rawLocation = response.headers.location
        const loc = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation
        if (!loc) {
          safeReject(new Error('Download failed: empty redirect location'))
          return
        }
        download(loc, destPath, onProgress, { signal, expectedSize, _maxRedirects: _maxRedirects - 1 }).then(safeResolve, safeReject)
        return
      }

      const isResumed = response.statusCode === 206 && resumeFrom > 0
      if (!isResumed && response.statusCode !== 200) {
        cleanup()
        safeReject(new Error(`Download failed: HTTP ${response.statusCode}`))
        return
      }

      // If we requested a range but got 200, server doesn't support resume — start fresh
      let baseBytes = 0
      if (isResumed) {
        baseBytes = resumeFrom
      } else if (resumeFrom > 0) {
        try { fs.unlinkSync(destPath) } catch {}
      }

      const rawContentLength = response.headers['content-length']
      const contentLength = Array.isArray(rawContentLength) ? rawContentLength[0] : rawContentLength
      const chunkTotalBytes = parseInt(contentLength ?? '0', 10)
      const totalBytes = isResumed ? baseBytes + chunkTotalBytes : chunkTotalBytes

      // Compute effective expected size for validation
      // Only use totalBytes if Content-Length was actually present
      const sizeFromHeaders = chunkTotalBytes > 0 ? totalBytes : 0
      const effectiveSize = expectedSize || sizeFromHeaders

      // Fail fast if caller's expectedSize conflicts with server's Content-Length
      if (expectedSize && sizeFromHeaders > 0 && expectedSize !== sizeFromHeaders) {
        cleanup()
        safeReject(new Error(
          `Download size mismatch: expected ${expectedSize} bytes but server reported ${sizeFromHeaders}`
        ))
        return
      }

      // Write meta to mark this download as in-progress (enables resume if interrupted)
      const etag = headerString(response.headers['etag'])
      const lastModified = headerString(response.headers['last-modified'])
      writeMeta(metaPath, { url, expectedSize: effectiveSize, etag, lastModified })

      let receivedBytes = baseBytes
      const startTime = Date.now()

      const fileStream = fs.createWriteStream(destPath, isResumed ? { flags: 'a' } : undefined)
      fileStream.on('error', (err: Error) => {
        cleanup()
        try { fs.unlinkSync(destPath) } catch {}
        try { fs.unlinkSync(metaPath) } catch {}
        safeReject(err)
      })

      response.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length
        fileStream.write(chunk)
        if (onProgress) {
          const elapsedSecs = (Date.now() - startTime) / 1000
          const newBytes = receivedBytes - baseBytes
          const speedMBs = elapsedSecs > 0 ? newBytes / 1048576 / elapsedSecs : 0
          const effectiveTotal = effectiveSize || totalBytes
          const percent = effectiveTotal > 0 ? Math.round((receivedBytes / effectiveTotal) * 100) : 0
          const remainingBytes = effectiveTotal - receivedBytes
          const etaSecs =
            speedMBs > 0 && effectiveTotal > 0 ? remainingBytes / 1048576 / speedMBs : -1
          onProgress({
            percent,
            receivedBytes,
            receivedMB: (receivedBytes / 1048576).toFixed(1),
            totalMB: effectiveTotal > 0 ? (effectiveTotal / 1048576).toFixed(1) : '?',
            speedMBs,
            elapsedSecs,
            etaSecs,
          })
        }
      })

      response.on('end', () => {
        cleanup()
        if (aborted) {
          fileStream.close()
          // Keep files + meta for resume
          safeReject(new Error('Download cancelled'))
          return
        }
        fileStream.end()
        fileStream.on('close', () => {
          // Validate file size if we know the expected size
          if (effectiveSize > 0) {
            try {
              const actualSize = fs.statSync(destPath).size
              if (actualSize !== effectiveSize) {
                // Size mismatch — delete everything, no resume possible
                try { fs.unlinkSync(destPath) } catch {}
                try { fs.unlinkSync(metaPath) } catch {}
                safeReject(new Error(
                  `Download incomplete: expected ${effectiveSize} bytes but got ${actualSize}`
                ))
                return
              }
            } catch (err) {
              try { fs.unlinkSync(destPath) } catch {}
              try { fs.unlinkSync(metaPath) } catch {}
              safeReject(err as Error)
              return
            }
          }

          // Remove meta to mark the download as complete.
          // The data file is already at destPath — no rename needed.
          try { fs.unlinkSync(metaPath) } catch {}
          safeResolve(destPath)
        })
      })

      response.on('error', (err: Error) => {
        cleanup()
        fileStream.close()
        // Keep files + meta on network error for resume
        if (aborted) {
          safeReject(new Error('Download cancelled'))
          return
        }
        safeReject(err)
      })
    })

    request.on('error', (err: Error) => {
      cleanup()
      if (aborted) {
        safeReject(new Error('Download cancelled'))
        return
      }
      safeReject(err)
    })
    request.end()
  })
}
