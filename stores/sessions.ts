/**
 * Pinia store: Sessions
 *
 * Replaces the following window.Launcher state (renderer/util.js, renderer/sessions.js):
 *   - _runningInstances  (Map)  — util.js:21
 *   - _activeSessions    (Map)  — util.js:51
 *   - _errorInstances    (Map)  — util.js:54
 *   - sessions._sessions (Map)  — sessions.js:8
 *
 * Eliminates manual re-render calls:
 *   - _updateRunningTab()              — util.js:99–112
 *   - list.render()                    — called in 6+ places after state changes
 *   - _refreshRunningViewIfActive()    — util.js:75–80
 *
 * All consuming Vue components react automatically via Vue 3 reactivity.
 */

import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'

// ── Interfaces ──────────────────────────────────────────────────────────────

/** A running ComfyUI process (currently active). */
export interface RunningInstance {
  installationId: string
  port?: number
  url?: string
  mode?: 'console' | 'window'
  installationName: string
}

/** A transient operation in progress (installing, launching, deleting). */
export interface ActiveSession {
  label: string
}

/** A process that crashed unexpectedly. */
export interface ErrorInstance {
  installationName: string
  exitCode: number | null
}

/** Console output buffer for a single installation. */
export interface ConsoleSession {
  output: string
  exited: boolean
}

// ── Store ───────────────────────────────────────────────────────────────────

export const useSessionsStore = defineStore('sessions', () => {
  // ── State ───────────────────────────────────────────────────────────────
  // Vue 3's reactive() tracks Map get/set/delete/has/size automatically.

  /** Active ComfyUI processes — replaces window.Launcher._runningInstances */
  const runningInstances = reactive(new Map<string, RunningInstance>())

  /** Transient operations — replaces window.Launcher._activeSessions */
  const activeSessions = reactive(new Map<string, ActiveSession>())

  /** Crashed processes — replaces window.Launcher._errorInstances */
  const errorInstances = reactive(new Map<string, ErrorInstance>())

  /** Console output buffers — replaces window.Launcher.sessions._sessions */
  const consoleSessions = reactive(new Map<string, ConsoleSession>())

  /** Which installation the console view is displaying */
  const consoleViewInstallationId = ref<string | null>(null)

  // ── Getters ─────────────────────────────────────────────────────────────

  /**
   * Total count for sidebar badge.
   * Replaces: _updateRunningTab() reading _activeSessions.size + _runningInstances.size
   * (util.js:102)
   */
  const activeCount = computed(() => activeSessions.size + runningInstances.size)

  /** Whether the sidebar should show an error indicator (util.js:110) */
  const hasErrors = computed(() => errorInstances.size > 0)

  /** Check if a specific installation is running (replaces isInstanceRunning, util.js:46–48) */
  function isRunning(installationId: string): boolean {
    return runningInstances.has(installationId)
  }

  /** Get active session info (replaces getActiveSessionForInstallation, util.js:82–84) */
  function getActiveSession(installationId: string): ActiveSession | null {
    return activeSessions.get(installationId) ?? null
  }

  /** Check if console view is showing a specific installation (replaces isConsoleViewActive, util.js:94–97) */
  function isConsoleViewActive(installationId: string): boolean {
    return consoleViewInstallationId.value === installationId
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  /**
   * Set an active session for an installation.
   * Replaces: window.Launcher.setActiveSession (util.js:56–63)
   *
   * BEFORE (3 manual re-render calls):
   *   window.Launcher._activeSessions.set(installationId, { label });
   *   window.Launcher._errorInstances.delete(installationId);
   *   window.Launcher._updateRunningTab();
   *   window.Launcher._refreshRunningViewIfActive();
   *   window.Launcher.list.render();
   *
   * AFTER (just state mutations — reactivity handles the rest):
   */
  function setActiveSession(installationId: string, label: string) {
    activeSessions.set(installationId, { label: label || '' })
    errorInstances.delete(installationId)
  }

  /**
   * Clear an active session.
   * Replaces: window.Launcher.clearActiveSession (util.js:65–72)
   *
   * Note: The original intentionally does NOT call list.render().
   * With Pinia, the list component simply re-renders because activeSessions changed.
   */
  function clearActiveSession(installationId?: string) {
    if (installationId) {
      activeSessions.delete(installationId)
    } else {
      activeSessions.clear()
    }
  }

  /**
   * Dismiss an error instance.
   * Replaces: window.Launcher.clearErrorInstance (util.js:86–92)
   */
  function clearErrorInstance(installationId: string) {
    errorInstances.delete(installationId)
    consoleSessions.delete(installationId)
  }

  /**
   * Start a new console session buffer.
   * Replaces: window.Launcher.sessions.start (sessions.js:58–59)
   */
  function startConsoleSession(installationId: string) {
    consoleSessions.set(installationId, { output: '', exited: false })
  }

  /**
   * Append text to a console session buffer.
   * Replaces: window.Launcher.sessions.appendOutput (sessions.js:74–77)
   */
  function appendConsoleOutput(installationId: string, text: string) {
    let session = consoleSessions.get(installationId)
    if (!session) {
      session = { output: '', exited: false }
      consoleSessions.set(installationId, session)
    }
    session.output += text
  }

  /**
   * Initialize IPC listeners for running instance lifecycle.
   * Replaces: window.Launcher.initRunningInstances (util.js:23–43)
   *           window.Launcher.sessions.init (sessions.js:10–47)
   *
   * Call once during app startup. Listeners update reactive state;
   * Vue components re-render automatically — no manual re-render calls.
   */
  async function initListeners() {
    // Seed initial state from main process
    const instances: RunningInstance[] = await window.api.getRunningInstances()
    instances.forEach((inst) => {
      runningInstances.set(inst.installationId, inst)
    })

    // Instance lifecycle events
    window.api.onInstanceStarted((data: RunningInstance) => {
      runningInstances.set(data.installationId, data)
      // ← In the old code, this also called:
      //   _updateRunningTab(), list.render(), _refreshRunningViewIfActive()
      // With Pinia, all three views update automatically.
    })

    window.api.onInstanceStopped((data: { installationId: string }) => {
      runningInstances.delete(data.installationId)
    })

    // Console output streaming
    window.api.onComfyOutput((data: { installationId: string; text: string }) => {
      appendConsoleOutput(data.installationId, data.text)
    })

    // Process exit handling
    window.api.onComfyExited((data: {
      installationId: string
      installationName: string
      crashed: boolean
      exitCode?: number
    }) => {
      const session = consoleSessions.get(data.installationId)
      if (session) {
        session.exited = true
        const exitMsg = data.crashed
          ? `Process crashed (exit code: ${data.exitCode ?? 'unknown'})`
          : 'Process exited'
        session.output += `\n\n--- ${exitMsg} ---\n`
      }

      if (data.crashed) {
        errorInstances.set(data.installationId, {
          installationName: data.installationName,
          exitCode: data.exitCode ?? null,
        })
        // ← Old code manually called: _updateRunningTab(), list.render(),
        //   _refreshRunningViewIfActive() (sessions.js:38–41)
        // With Pinia, all views update automatically.
      }
    })
  }

  // ── Public API ──────────────────────────────────────────────────────────

  return {
    // State
    runningInstances,
    activeSessions,
    errorInstances,
    consoleSessions,
    consoleViewInstallationId,

    // Getters
    activeCount,
    hasErrors,

    // Methods (getter-style)
    isRunning,
    getActiveSession,
    isConsoleViewActive,

    // Actions
    setActiveSession,
    clearActiveSession,
    clearErrorInstance,
    startConsoleSession,
    appendConsoleOutput,
    initListeners,
  }
})
