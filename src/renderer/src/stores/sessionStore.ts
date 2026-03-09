import { defineStore } from 'pinia'
import { reactive, computed } from 'vue'
import type { RunningInstance, ComfyOutputData, ComfyExitedData } from '../types/ipc'

interface SessionBuffer {
  output: string
  exited: boolean
}

interface ActiveSession {
  label: string
}

interface ErrorInstance {
  installationName: string
  exitCode?: number | string
  message?: string
}

export const useSessionStore = defineStore('session', () => {
  const runningInstances = reactive(new Map<string, RunningInstance>())
  const launchingInstances = reactive(new Map<string, { installationName: string }>())
  const activeSessions = reactive(new Map<string, ActiveSession>())
  const errorInstances = reactive(new Map<string, ErrorInstance>())
  const stoppingInstances = reactive(new Set<string>())
  const sessions = reactive(new Map<string, SessionBuffer>())

  const runningTabCount = computed(() => activeSessions.size + runningInstances.size)
  const hasErrors = computed(() => errorInstances.size > 0)

  // Track IPC unsubscribe functions for cleanup
  const cleanups: (() => void)[] = []

  function isRunning(installationId: string): boolean {
    return runningInstances.has(installationId)
  }

  function isLaunching(installationId: string): boolean {
    return launchingInstances.has(installationId)
  }

  function isStopping(installationId: string): boolean {
    return stoppingInstances.has(installationId)
  }

  function setActiveSession(installationId: string, label: string): void {
    activeSessions.set(installationId, { label: label || '' })
    errorInstances.delete(installationId)
  }

  function clearActiveSession(installationId?: string): void {
    if (installationId) {
      activeSessions.delete(installationId)
    } else {
      activeSessions.clear()
    }
  }

  function clearErrorInstance(installationId: string): void {
    errorInstances.delete(installationId)
    sessions.delete(installationId)
  }

  // Session buffer methods
  function startSession(installationId: string): void {
    sessions.set(installationId, { output: '', exited: false })
  }

  function getSession(installationId: string): SessionBuffer | undefined {
    return sessions.get(installationId)
  }

  function hasSession(installationId: string): boolean {
    return sessions.has(installationId)
  }

  function clearSession(installationId: string): void {
    sessions.delete(installationId)
  }

  function appendOutput(installationId: string, text: string): void {
    let session = sessions.get(installationId)
    if (!session) {
      session = { output: '', exited: false }
      sessions.set(installationId, session)
    }

    // Handle carriage returns (\r) used by tqdm-style progress bars.
    // A \r means "return to the start of the current line", so text after
    // a \r should replace everything after the last \n in the output.
    // Split on bare \r (not followed by \n) to handle tqdm-style progress bars.
    // Windows CRLF (\r\n) must be preserved as a normal newline.
    const parts = text.split(/\r(?!\n)/)
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]!
      if (i === 0) {
        // First segment: always append (no preceding \r)
        session.output += segment
      } else if (segment.length > 0) {
        // After a bare \r: overwrite from the last newline
        const lastNewline = session.output.lastIndexOf('\n')
        session.output = session.output.slice(0, lastNewline + 1) + segment
      }
    }
  }

  /** Initialize IPC listeners. Call once from App.vue. */
  async function init(): Promise<void> {
    dispose()
    const instances = await window.api.getRunningInstances()
    for (const inst of instances) {
      runningInstances.set(inst.installationId, inst)
    }

    cleanups.push(
      window.api.onInstanceLaunching((data: { installationId: string; installationName: string }) => {
        launchingInstances.set(data.installationId, { installationName: data.installationName })
      }),
      window.api.onInstanceLaunchFailed((data: { installationId: string }) => {
        launchingInstances.delete(data.installationId)
      }),
      window.api.onInstanceStarted((data: RunningInstance) => {
        launchingInstances.delete(data.installationId)
        runningInstances.set(data.installationId, data)
      }),
      window.api.onInstanceStopped((data: { installationId: string }) => {
        runningInstances.delete(data.installationId)
        stoppingInstances.delete(data.installationId)
      }),
      window.api.onInstanceStopping((data: { installationId: string }) => {
        stoppingInstances.add(data.installationId)
      }),
      window.api.onComfyOutput((data: ComfyOutputData) => {
        appendOutput(data.installationId, data.text)
      }),
      window.api.onComfyExited((data: ComfyExitedData) => {
        const session = sessions.get(data.installationId)
        if (session) {
          session.exited = true
          const msg = data.crashed
            ? `Process crashed (exit code ${data.exitCode ?? 'unknown'})`
            : 'Process exited'
          session.output += `\n\n--- ${msg} ---\n`
        }
        if (data.crashed) {
          errorInstances.set(data.installationId, {
            installationName: data.installationName,
            exitCode: data.exitCode,
          })
        }
      })
    )
  }

  function dispose(): void {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  }

  return {
    runningInstances,
    launchingInstances,
    activeSessions,
    errorInstances,
    sessions,
    runningTabCount,
    hasErrors,
    isRunning,
    isLaunching,
    stoppingInstances,
    isStopping,
    setActiveSession,
    clearActiveSession,
    clearErrorInstance,
    startSession,
    getSession,
    hasSession,
    clearSession,
    appendOutput,
    init,
    dispose,
  }
})
