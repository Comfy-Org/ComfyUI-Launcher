import { onUnmounted, getCurrentInstance } from 'vue'

type Unsubscribe = () => void

export function useElectronApi() {
  const cleanups: Unsubscribe[] = []

  // Only set up auto-cleanup if called within a component setup context
  if (getCurrentInstance()) {
    onUnmounted(() => {
      for (const fn of cleanups) fn()
      cleanups.length = 0
    })
  }

  /**
   * Subscribe to an IPC event with automatic cleanup on component unmount.
   * Usage: listen(api.onInstanceStarted, (data) => { ... })
   */
  function listen<T>(
    subscribe: (callback: (data: T) => void) => Unsubscribe,
    callback: (data: T) => void
  ): Unsubscribe {
    const unsub = subscribe(callback)
    cleanups.push(unsub)
    return unsub
  }

  /** Manually clean up all registered listeners (for use outside components). */
  function cleanup(): void {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  }

  return {
    api: window.api,
    listen,
    cleanup,
  }
}
