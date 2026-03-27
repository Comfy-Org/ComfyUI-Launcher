import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { downloadAndExtract, downloadAndExtractMulti } from './installer'
import type { Cache } from './cache'
import type { DownloadProgress } from './download'
import type { ExtractProgress } from './extract'

vi.mock('./i18n', () => ({
  t: (key: string) => key,
}))

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'installer-test-'))
}

function makeCache(dir: string): Cache {
  return {
    getCachePath: (folder: string) => path.join(dir, folder),
    evict: vi.fn(),
    touch: vi.fn(),
    cleanPartials: vi.fn(),
  }
}

type SendProgress = (step: string, data: { percent: number; status: string }) => void
type DownloadFn = (
  url: string,
  dest: string,
  onProgress: ((p: DownloadProgress) => void) | null,
  options?: { signal?: AbortSignal; expectedSize?: number }
) => Promise<string>

function makeCtx(overrides: {
  sendProgress?: SendProgress
  download: DownloadFn
  cache: Cache
  extract: (archivePath: string, dest: string) => Promise<void>
  signal?: AbortSignal
}) {
  return {
    sendProgress: overrides.sendProgress ?? vi.fn<SendProgress>(),
    download: overrides.download,
    cache: overrides.cache,
    extract: overrides.extract as (
      archivePath: string,
      dest: string,
      onProgress?: ((p: ExtractProgress) => void) | null,
      options?: { signal?: AbortSignal }
    ) => Promise<void>,
    ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
  }
}

describe('downloadAndExtract', () => {
  it('serialises concurrent downloads to the same cache path', async () => {
    const cacheDir = tmpDir()
    const destA = tmpDir()
    const destB = tmpDir()

    const mockDownload = vi.fn<DownloadFn>(async (_url, dest) => {
      await new Promise((r) => setTimeout(r, 20))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, 'fake-archive-data')
      return dest
    })

    const mockExtract = vi.fn(async () => {})
    const cache = makeCache(cacheDir)
    const sendProgressA = vi.fn<SendProgress>()
    const sendProgressB = vi.fn<SendProgress>()

    const ctxA = makeCtx({ sendProgress: sendProgressA, download: mockDownload, cache, extract: mockExtract })
    const ctxB = makeCtx({ sendProgress: sendProgressB, download: mockDownload, cache, extract: mockExtract })

    // Fire both concurrently with the same cacheKey + URL
    const [resultA, resultB] = await Promise.all([
      downloadAndExtract('https://example.com/env.7z', destA, 'v1_nvidia', ctxA),
      downloadAndExtract('https://example.com/env.7z', destB, 'v1_nvidia', ctxB),
    ])

    expect(resultA).toBeUndefined()
    expect(resultB).toBeUndefined()

    // Only ONE actual download should have occurred; the second caller
    // should have seen a cache hit after the lock was released.
    expect(mockDownload).toHaveBeenCalledTimes(1)

    // Both should have called extract (each extracts to its own dest)
    expect(mockExtract).toHaveBeenCalledTimes(2)

    // The second caller should have shown a waiting status, then a cache hit
    const bDownloadCalls = sendProgressB.mock.calls.filter(
      (args) => args[0] === 'download'
    )
    const bStatuses = bDownloadCalls.map((args) => args[1].status)
    expect(bStatuses).toContain('installer.waitingForDownload')
    expect(bStatuses).toContain('installer.cachedDownload')
  })

  it('does not block downloads to different cache paths', async () => {
    const cacheDir = tmpDir()
    const destA = tmpDir()
    const destB = tmpDir()

    let concurrentCount = 0
    let maxConcurrent = 0

    const mockDownload = vi.fn<DownloadFn>(async (_url, dest) => {
      concurrentCount++
      maxConcurrent = Math.max(maxConcurrent, concurrentCount)
      await new Promise((r) => setTimeout(r, 20))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, 'fake-data')
      concurrentCount--
      return dest
    })

    const mockExtract = vi.fn(async () => {})
    const cache = makeCache(cacheDir)

    // Different cache keys → different lock paths → should run concurrently
    await Promise.all([
      downloadAndExtract('https://example.com/a.7z', destA, 'v1_nvidia', makeCtx({ download: mockDownload, cache, extract: mockExtract })),
      downloadAndExtract('https://example.com/b.7z', destB, 'v2_amd', makeCtx({ download: mockDownload, cache, extract: mockExtract })),
    ])

    expect(mockDownload).toHaveBeenCalledTimes(2)
    // Both downloads should have been in-flight simultaneously
    expect(maxConcurrent).toBe(2)
  })

  it('respects AbortSignal while waiting for the download lock', async () => {
    const cacheDir = tmpDir()
    const destA = tmpDir()
    const destB = tmpDir()

    const abortController = new AbortController()

    const mockDownload = vi.fn<DownloadFn>(async (_url, dest) => {
      // Simulate a slow download; abort the waiting caller mid-wait
      setTimeout(() => abortController.abort(), 10)
      await new Promise((r) => setTimeout(r, 50))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, 'fake-data')
      return dest
    })

    const mockExtract = vi.fn(async () => {})
    const cache = makeCache(cacheDir)

    // A starts first — acquires the lock and begins the slow download
    const ctxA = makeCtx({ download: mockDownload, cache, extract: mockExtract })
    const resultA = downloadAndExtract('https://example.com/env.7z', destA, 'v1_nvidia', ctxA)

    // Yield so A enters withDownloadLock and acquires the lock
    await new Promise((r) => setTimeout(r, 0))

    // B starts second — will wait on the lock, but has an abort signal
    const ctxB = makeCtx({ download: mockDownload, cache, extract: mockExtract, signal: abortController.signal })
    const resultB = downloadAndExtract('https://example.com/env.7z', destB, 'v1_nvidia', ctxB)
    // Suppress unhandled rejection warning — we assert on it below
    resultB.catch(() => {})

    // A should succeed (it holds the lock)
    await expect(resultA).resolves.toBeUndefined()
    // B was waiting for the lock when abort fired — should reject immediately
    await expect(resultB).rejects.toThrow('Download cancelled')
    expect(mockDownload).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when the download is cancelled so the next caller can proceed', async () => {
    const cacheDir = tmpDir()
    const destA = tmpDir()
    const destB = tmpDir()

    const abortA = new AbortController()

    const mockDownload = vi.fn<DownloadFn>(async (_url, dest, _onProgress, opts) => {
      // A will be cancelled after 10ms; B will run to completion
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.writeFileSync(dest, 'fake-data')
          resolve()
        }, 50)
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('Download cancelled'))
        }, { once: true })
      })
      return dest
    })

    const mockExtract = vi.fn(async () => {})
    const cache = makeCache(cacheDir)

    // A starts first, acquires lock
    const ctxA = makeCtx({ download: mockDownload, cache, extract: mockExtract, signal: abortA.signal })
    const resultA = downloadAndExtract('https://example.com/env.7z', destA, 'v1_nvidia', ctxA)
    resultA.catch(() => {})

    // Let A acquire the lock
    await new Promise((r) => setTimeout(r, 0))

    // B starts, waits on the lock
    const ctxB = makeCtx({ download: mockDownload, cache, extract: mockExtract })
    const resultB = downloadAndExtract('https://example.com/env.7z', destB, 'v1_nvidia', ctxB)

    // Cancel A while B is waiting
    setTimeout(() => abortA.abort(), 10)

    // A should fail
    await expect(resultA).rejects.toThrow('Download cancelled')
    // B should succeed — it acquires the lock after A releases it, then downloads
    await expect(resultB).resolves.toBeUndefined()
    // B must have done its own download (A's was cancelled, no cache file)
    expect(mockDownload).toHaveBeenCalledTimes(2)
    expect(mockExtract).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when the download rejects with an unexpected error', async () => {
    const cacheDir = tmpDir()
    const destA = tmpDir()
    const destB = tmpDir()

    let callCount = 0
    const mockDownload = vi.fn<DownloadFn>(async (_url, dest) => {
      callCount++
      if (callCount === 1) {
        // First call fails with a network error
        throw new Error('Network error')
      }
      // Second call succeeds
      await new Promise((r) => setTimeout(r, 10))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, 'fake-data')
      return dest
    })

    const mockExtract = vi.fn(async () => {})
    const cache = makeCache(cacheDir)

    // A starts, acquires lock, download throws
    const resultA = downloadAndExtract(
      'https://example.com/env.7z', destA, 'v1_nvidia',
      makeCtx({ download: mockDownload, cache, extract: mockExtract }),
    )
    resultA.catch(() => {})

    await new Promise((r) => setTimeout(r, 0))

    // B starts, waits on lock
    const resultB = downloadAndExtract(
      'https://example.com/env.7z', destB, 'v1_nvidia',
      makeCtx({ download: mockDownload, cache, extract: mockExtract }),
    )

    await expect(resultA).rejects.toThrow('Network error')
    // B should proceed and succeed — lock was released despite the error
    await expect(resultB).resolves.toBeUndefined()
    expect(mockDownload).toHaveBeenCalledTimes(2)
  })

  it('allows new downloads to the same cache path after all operations finish', async () => {
    const cacheDir = tmpDir()

    const mockDownload = vi.fn<DownloadFn>(async (_url, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, 'data')
      return dest
    })
    const mockExtract = vi.fn(async () => {})
    const cache = makeCache(cacheDir)

    // First download
    await downloadAndExtract('https://example.com/env.7z', tmpDir(), 'v1_nvidia',
      makeCtx({ download: mockDownload, cache, extract: mockExtract }))

    // Second download to same cache key — should work (lock fully released)
    await downloadAndExtract('https://example.com/env.7z', tmpDir(), 'v1_nvidia',
      makeCtx({ download: mockDownload, cache, extract: mockExtract }))

    // First was downloaded, second was a cache hit — no deadlock
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(mockExtract).toHaveBeenCalledTimes(2)
  })
})

describe('downloadAndExtractMulti', () => {
  it('serialises concurrent multi-file downloads to the same cache path', async () => {
    const cacheDir = tmpDir()
    const destA = tmpDir()
    const destB = tmpDir()

    const mockDownload = vi.fn<DownloadFn>(async (_url, dest) => {
      await new Promise((r) => setTimeout(r, 10))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, Buffer.alloc(100))
      return dest
    })

    const mockExtract = vi.fn(async () => {})
    const cache = makeCache(cacheDir)

    const files = [
      { url: 'https://example.com/part.7z.001', filename: 'part.7z.001', size: 100 },
    ]

    await Promise.all([
      downloadAndExtractMulti(files, destA, 'v1_nvidia', makeCtx({ download: mockDownload, cache, extract: mockExtract })),
      downloadAndExtractMulti(files, destB, 'v1_nvidia', makeCtx({ download: mockDownload, cache, extract: mockExtract })),
    ])

    // Only one download — second caller sees cache hit
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(mockExtract).toHaveBeenCalledTimes(2)
  })
})
