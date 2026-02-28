import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from './sessionStore'
import type {
  ActionResult,
  ProgressData,
  ProgressStep,
  ComfyOutputData,
  Unsubscribe,
} from '../types/ipc'

export interface Operation {
  title: string
  returnTo?: string
  steps: ProgressStep[] | null
  activePhase: string | null
  activePercent: number
  lastStatus: Record<string, string>
  flatStatus: string
  flatPercent: number
  terminalOutput: string
  done: boolean
  error: string | null
  finished: boolean
  cancelRequested: boolean
  result: ActionResult | null
  unsubProgress: Unsubscribe | null
  unsubOutput: Unsubscribe | null
  apiCall: (() => Promise<ActionResult>) | null
}

export const useProgressStore = defineStore('progress', () => {
  const { t } = useI18n()
  const sessionStore = useSessionStore()

  const operations = reactive(new Map<string, Operation>())

  function cleanupOperation(installationId: string): void {
    const op = operations.get(installationId)
    if (!op) return
    if (op.unsubProgress) op.unsubProgress()
    if (op.unsubOutput) op.unsubOutput()
    op.unsubProgress = null
    op.unsubOutput = null
  }

  function getProgressInfo(
    installationId: string
  ): { status: string; percent: number } | null {
    const op = operations.get(installationId)
    if (!op || op.finished) return null
    if (op.steps && op.activePhase) {
      const status = op.lastStatus[op.activePhase] || op.activePhase
      return { status, percent: op.activePercent }
    }
    return { status: op.flatStatus || op.title, percent: op.flatPercent }
  }

  function startOperation(opts: {
    installationId: string
    title: string
    apiCall: () => Promise<ActionResult>
    cancellable?: boolean
    returnTo?: string
  }): void {
    const { installationId, title, apiCall, returnTo } = opts

    cleanupOperation(installationId)

    sessionStore.startSession(installationId)
    const sessionLabel = title.split(' — ')[0] || t('progress.working')
    sessionStore.setActiveSession(installationId, sessionLabel)

    const op: Operation = {
      title: title || t('progress.working'),
      returnTo,
      steps: null,
      activePhase: null,
      activePercent: -1,
      lastStatus: {},
      flatStatus: t('progress.starting'),
      flatPercent: -1,
      terminalOutput: '',
      done: false,
      error: null,
      finished: false,
      cancelRequested: false,
      result: null,
      unsubProgress: null,
      unsubOutput: null,
      apiCall
    }
    operations.set(installationId, op)
    const rop = operations.get(installationId)!

    rop.unsubProgress = window.api.onInstallProgress((data: ProgressData) => {
      if (data.installationId !== installationId) return

      if (data.phase === 'steps' && data.steps) {
        rop.steps = data.steps
        rop.activePhase = null
        rop.activePercent = -1
        return
      }

      if (data.phase === 'done' && rop.steps) {
        rop.done = true
        return
      }

      if (rop.steps) {
        const stepIndex = rop.steps.findIndex((s) => s.phase === data.phase)
        if (stepIndex === -1) return
        rop.activePhase = data.phase
        rop.lastStatus[data.phase] = data.status || data.phase
        rop.activePercent = data.percent ?? -1
        return
      }

      if (!rop.cancelRequested) {
        rop.flatStatus = data.status || data.phase
      }
      if (data.percent !== undefined) {
        rop.flatPercent = data.percent
      }
    })

    rop.unsubOutput = window.api.onComfyOutput((data: ComfyOutputData) => {
      if (data.installationId !== installationId) return
      rop.terminalOutput += data.text
    })

    const cleanupRop = (): void => {
      if (rop.unsubProgress) rop.unsubProgress()
      if (rop.unsubOutput) rop.unsubOutput()
      rop.unsubProgress = null
      rop.unsubOutput = null
    }

    let p: Promise<ActionResult>
    try {
      p = apiCall()
    } catch (err) {
      rop.error = (err as Error).message || t('progress.unknownError')
      rop.finished = true
      cleanupRop()
      sessionStore.clearActiveSession(installationId)
      sessionStore.errorInstances.set(installationId, {
        installationName: rop.title,
        message: rop.error,
      })
      return
    }

    p
      .then((result) => {
        rop.finished = true
        if (result.ok) rop.result = result
        cleanupRop()

        if (result.ok) {
          sessionStore.clearActiveSession(installationId)
          if (rop.steps) rop.done = true
        } else if (result.portConflict) {
          sessionStore.clearActiveSession(installationId)
        } else {
          rop.error = result.message || t('progress.unknownError')
          sessionStore.clearActiveSession(installationId)
          sessionStore.errorInstances.set(installationId, {
            installationName: rop.title,
            message: rop.error,
          })
        }
      })
      .catch((err: Error) => {
        rop.error = err.message
        rop.finished = true
        cleanupRop()
        sessionStore.clearActiveSession(installationId)
        sessionStore.errorInstances.set(installationId, {
          installationName: rop.title,
          message: rop.error,
        })
      })
  }

  function cancelOperation(installationId: string): void {
    const op = operations.get(installationId)
    if (!op) return
    op.cancelRequested = true
    op.flatStatus = t('progress.cancelling')
    window.api.cancelOperation(installationId)
    window.api.stopComfyUI(installationId)
  }

  return {
    operations,
    getProgressInfo,
    startOperation,
    cleanupOperation,
    cancelOperation,
  }
})
