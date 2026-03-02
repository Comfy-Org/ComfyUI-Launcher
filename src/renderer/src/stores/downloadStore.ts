import { defineStore } from 'pinia'
import { computed, reactive } from 'vue'
import type { ModelDownloadProgress, Unsubscribe } from '../types/ipc'

export const useDownloadStore = defineStore('downloads', () => {
  const downloads = reactive(new Map<string, ModelDownloadProgress>())
  let unsub: Unsubscribe | null = null

  function upsert(progress: ModelDownloadProgress): void {
    downloads.set(progress.url, { ...progress })
  }

  function init(): void {
    if (unsub) return

    // Seed with any in-flight downloads
    window.api.listModelDownloads().then((list) => {
      for (const p of list) upsert(p)
    })

    // Subscribe to live updates
    unsub = window.api.onModelDownloadProgress((p) => upsert(p))
  }

  function dismiss(url: string): void {
    downloads.delete(url)
  }

  const activeDownloads = computed(() => {
    const result: ModelDownloadProgress[] = []
    downloads.forEach((d) => {
      if (d.status === 'pending' || d.status === 'downloading' || d.status === 'paused') {
        result.push(d)
      }
    })
    return result
  })

  const finishedDownloads = computed(() => {
    const result: ModelDownloadProgress[] = []
    downloads.forEach((d) => {
      if (d.status === 'completed' || d.status === 'error' || d.status === 'cancelled') {
        result.push(d)
      }
    })
    return result
  })

  const hasDownloads = computed(() => downloads.size > 0)

  return {
    downloads,
    init,
    upsert,
    dismiss,
    activeDownloads,
    finishedDownloads,
    hasDownloads,
  }
})
