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
}

export const useSessionStore = defineStore('session', () => {
  const runningInstances = reactive(new Map<string, RunningInstance>())
  const activeSessions = reactive(new Map<string, ActiveSession>())
  const errorInstances = reactive(new Map<string, ErrorInstance>())
  const sessions = reactive(new Map<string, SessionBuffer>())

  const runningTabCount = computed(() => activeSessions.size + runningInstances.size)
  const hasErrors = computed(() => errorInstances.size > 0)

  // Track IPC unsubscribe functions for cleanup
  const cleanups: (() => void)[] = []

  function isRunning(installationId: string): boolean {
    return runningInstances.has(installationId)
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
    session.output += text
  }

  /** Initialize IPC listeners. Call once from App.vue. */
  async function init(): Promise<void> {
    const instances = await window.api.getRunningInstances()
    for (const inst of instances) {
      runningInstances.set(inst.installationId, inst)
    }

    cleanups.push(
      window.api.onInstanceStarted((data: RunningInstance) => {
        runningInstances.set(data.installationId, data)
      }),
      window.api.onInstanceStopped((data: { installationId: string }) => {
        runningInstances.delete(data.installationId)
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
    activeSessions,
    errorInstances,
    sessions,
    runningTabCount,
    hasErrors,
    isRunning,
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
