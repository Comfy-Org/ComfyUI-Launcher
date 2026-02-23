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

interface DownloadOptions {
  signal?: AbortSignal
  _maxRedirects?: number
}

export function download(
  url: string,
  destPath: string,
  onProgress: ((progress: DownloadProgress) => void) | null,
  options?: DownloadOptions | number
): Promise<string> {
  const opts: DownloadOptions = typeof options === 'number' ? { _maxRedirects: options } : options ?? {}
  const { signal, _maxRedirects = 5 } = opts

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Download cancelled'))
      return
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true })

    const request = net.request(url)
    request.setHeader('User-Agent', 'ComfyUI-Launcher')

    let aborted = false
    const onAbort = (): void => {
      aborted = true
      request.abort()
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    const cleanup = (): void => {
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    request.on('response', (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        cleanup()
        if (_maxRedirects <= 0) {
          reject(new Error('Download failed: too many redirects'))
          return
        }
        const rawLocation = response.headers.location
        const loc = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation
        if (!loc) {
          reject(new Error('Download failed: empty redirect location'))
          return
        }
        download(loc, destPath, onProgress, { signal, _maxRedirects: _maxRedirects - 1 }).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        cleanup()
        reject(new Error(`Download failed: HTTP ${response.statusCode}`))
        return
      }

      const rawContentLength = response.headers['content-length']
      const contentLength = Array.isArray(rawContentLength) ? rawContentLength[0] : rawContentLength
      const totalBytes = parseInt(contentLength ?? '0', 10)
      let receivedBytes = 0
      const startTime = Date.now()

      const fileStream = fs.createWriteStream(destPath)

      response.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length
        fileStream.write(chunk)
        if (onProgress) {
          const elapsedSecs = (Date.now() - startTime) / 1000
          const speedMBs = elapsedSecs > 0 ? receivedBytes / 1048576 / elapsedSecs : 0
          const percent = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0
          const remainingBytes = totalBytes - receivedBytes
          const etaSecs =
            speedMBs > 0 && totalBytes > 0 ? remainingBytes / 1048576 / speedMBs : -1
          onProgress({
            percent,
            receivedBytes,
            receivedMB: (receivedBytes / 1048576).toFixed(1),
            totalMB: totalBytes > 0 ? (totalBytes / 1048576).toFixed(1) : '?',
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
          try {
            fs.unlinkSync(destPath)
          } catch {}
          reject(new Error('Download cancelled'))
          return
        }
        fileStream.end(() => resolve(destPath))
      })

      response.on('error', (err: Error) => {
        cleanup()
        fileStream.close()
        try {
          fs.unlinkSync(destPath)
        } catch {}
        if (aborted) {
          reject(new Error('Download cancelled'))
          return
        }
        reject(err)
      })
    })

    request.on('error', (err: Error) => {
      cleanup()
      if (aborted) {
        reject(new Error('Download cancelled'))
        return
      }
      reject(err)
    })
    request.end()
  })
}
