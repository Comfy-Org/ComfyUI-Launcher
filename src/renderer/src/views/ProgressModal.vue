<script setup lang="ts">
import { ref, computed, reactive, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import { useSessionStore } from '../stores/sessionStore'
import type {
  ActionResult,
  ProgressData,
  ProgressStep,
  ComfyOutputData,
  Unsubscribe,
  KillResult
} from '../types/ipc'

interface Props {
  installationId: string | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
  'navigate-list': []
  'show-detail': [installationId: string]
  'show-console': [installationId: string]
}>()

const { t } = useI18n()
const modal = useModal()
const sessionStore = useSessionStore()

// --- Per-operation state ---
interface Operation {
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

// Module-level operations state — persists across mount/unmount cycles
const operations = reactive(new Map<string, Operation>())

const currentId = ref<string | null>(null)
const terminalRef = ref<HTMLDivElement | null>(null)

const currentOp = computed(() => {
  const id = currentId.value ?? props.installationId
  if (!id) return null
  return operations.get(id) ?? null
})

const displayId = computed(() => currentId.value ?? props.installationId)

// Auto-scroll terminal
watch(
  () => currentOp.value?.terminalOutput,
  async () => {
    await nextTick()
    if (!terminalRef.value) return
    const el = terminalRef.value
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    if (atBottom) el.scrollTop = el.scrollHeight
  }
)

// Sync currentId with prop
watch(
  () => props.installationId,
  (id) => {
    if (id) currentId.value = id
  },
  { immediate: true }
)

function isShowing(installationId: string): boolean {
  return displayId.value === installationId && props.installationId !== null
}

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

function showOperation(installationId: string): void {
  const op = operations.get(installationId)
  if (!op) return
  currentId.value = installationId
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
  currentId.value = installationId

  sessionStore.startSession(installationId)
  sessionStore.setActiveSession(installationId, title || t('progress.working'))

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
  // Get the reactive proxy so callbacks trigger Vue re-renders
  const rop = operations.get(installationId)!

  // Subscribe to progress events
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

    // Flat mode
    if (!rop.cancelRequested) {
      rop.flatStatus = data.status || data.phase
    }
    if (data.percent !== undefined) {
      rop.flatPercent = data.percent
    }
  })

  // Subscribe to terminal output
  rop.unsubOutput = window.api.onComfyOutput((data: ComfyOutputData) => {
    if (data.installationId !== installationId) return
    rop.terminalOutput += data.text
  })

  // Execute the API call
  apiCall()
    .then((result) => {
      rop.finished = true
      if (result.ok) rop.result = result
      cleanupOperation(installationId)

      if (result.ok) {
        sessionStore.clearActiveSession(installationId)

        // Window-mode launch: auto-close
        if (result.mode === 'window') {
          if (isShowing(installationId)) {
            emit('close')
          }
          return
        }

        if (rop.steps) rop.done = true
      } else if (result.portConflict) {
        sessionStore.clearActiveSession(installationId)
        // Port conflict state is stored in rop.result for template rendering
      } else {
        rop.error = result.message || t('progress.unknownError')
        sessionStore.clearActiveSession(installationId)
      }
    })
    .catch((err: Error) => {
      rop.error = err.message
      rop.finished = true
      cleanupOperation(installationId)
      sessionStore.clearActiveSession(installationId)
    })
}

function handleCancel(): void {
  const id = displayId.value
  if (!id) return
  const op = operations.get(id)
  if (!op) return
  op.cancelRequested = true
  op.flatStatus = t('progress.cancelling')
  window.api.cancelOperation(id)
  window.api.stopComfyUI(id)
}

function handleDone(): void {
  const id = displayId.value
  if (!id) return
  const op = operations.get(id)
  if (!op?.result) return
  emit('close')
  if (op.returnTo === 'detail' || op.result.navigate === 'detail') {
    emit('show-detail', id)
  } else if (op.result.mode === 'console') {
    emit('show-console', id)
  }
}

function handleUseNextPort(nextPort: number): void {
  const id = displayId.value
  if (!id) return
  const op = operations.get(id)
  if (!op) return
  startOperation({
    installationId: id,
    title: op.title,
    apiCall: () => window.api.runAction(id, 'launch', { portOverride: nextPort }),
    returnTo: op.returnTo
  })
}

async function handleKillProcess(port: number): Promise<void> {
  const id = displayId.value
  if (!id) return
  const op = operations.get(id)
  if (!op) return

  const confirmed = await modal.confirm({
    title: t('errors.portConflictKillConfirmTitle'),
    message: t('errors.portConflictKillConfirmMessage'),
    confirmLabel: t('errors.portConflictKill'),
    confirmStyle: 'danger'
  })
  if (!confirmed) return

  const killResult: KillResult = await window.api.killPortProcess(port)
  if (killResult.ok) {
    startOperation({
      installationId: id,
      title: op.title,
      apiCall: op.apiCall || (() => window.api.runAction(id, 'launch')),
      returnTo: op.returnTo
    })
  }
}

function getStepClass(
  op: Operation,
  stepIndex: number
): string {
  if (!op.steps) return 'progress-step'
  const activeIndex = op.activePhase
    ? op.steps.findIndex((s) => s.phase === op.activePhase)
    : -1

  if (op.done || stepIndex < activeIndex) return 'progress-step done'
  if (stepIndex === activeIndex) return 'progress-step active'
  return 'progress-step'
}

function getStepIndicator(
  op: Operation,
  stepIndex: number
): string {
  if (!op.steps) return String(stepIndex + 1)
  const activeIndex = op.activePhase
    ? op.steps.findIndex((s) => s.phase === op.activePhase)
    : -1

  if (op.done || stepIndex < activeIndex) return '✓'
  return String(stepIndex + 1)
}

function isStepDetailVisible(
  op: Operation,
  stepIndex: number
): boolean {
  if (!op.steps) return false
  const activeIndex = op.activePhase
    ? op.steps.findIndex((s) => s.phase === op.activePhase)
    : -1
  return stepIndex === activeIndex && !op.done
}

function getStepStatus(op: Operation, step: ProgressStep): string {
  if (op.error && op.activePhase === step.phase) {
    return t('progress.error', { message: op.error })
  }
  if (op.cancelRequested) return t('progress.cancelling')
  return op.lastStatus[step.phase] || step.phase
}

function getStepSummary(op: Operation, step: ProgressStep, stepIndex: number): string | null {
  if (!op.steps) return null
  const activeIndex = op.activePhase
    ? op.steps.findIndex((s) => s.phase === op.activePhase)
    : -1
  if ((op.done || stepIndex < activeIndex) && op.lastStatus[step.phase]) {
    return op.lastStatus[step.phase] ?? null
  }
  return null
}

function handleOverlayMouseDown(event: MouseEvent): void {
  mouseDownOnOverlay.value = event.target === (event.currentTarget as HTMLElement)
}

const mouseDownOnOverlay = ref(false)

function handleOverlayClick(event: MouseEvent): void {
  if (mouseDownOnOverlay.value && event.target === (event.currentTarget as HTMLElement)) {
    emit('close')
  }
  mouseDownOnOverlay.value = false
}

defineExpose({ startOperation, showOperation, getProgressInfo, operations })
</script>

<template>
  <div
    v-if="installationId && currentOp"
    class="view-modal active"
    @mousedown="handleOverlayMouseDown"
    @click="handleOverlayClick"
  >
    <div class="view-modal-content">
      <div class="view-modal-header">
        <div class="view-modal-title">{{ currentOp.title }}</div>
        <button class="view-modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="view-modal-body">
        <!-- Stepped progress -->
        <template v-if="currentOp.steps">
          <div class="progress-steps">
            <div
              v-for="(step, i) in currentOp.steps"
              :key="step.phase"
              :class="getStepClass(currentOp, i)"
              :data-phase="step.phase"
            >
              <div class="progress-step-header">
                <span class="progress-step-indicator">
                  {{ getStepIndicator(currentOp, i) }}
                </span>
                <span class="progress-step-label">{{ step.label }}</span>
              </div>
              <div
                v-if="isStepDetailVisible(currentOp, i)"
                class="progress-step-detail"
              >
                <div class="progress-step-status">
                  {{ getStepStatus(currentOp, step) }}
                </div>
                <div
                  v-if="!(currentOp.error && currentOp.activePhase === step.phase)"
                  class="progress-bar-track"
                >
                  <div
                    class="progress-bar-fill"
                    :class="{ indeterminate: currentOp.activePercent < 0 }"
                    :style="{
                      width: currentOp.activePercent >= 0
                        ? `${currentOp.activePercent}%`
                        : '100%'
                    }"
                  ></div>
                </div>
              </div>
              <div
                v-if="getStepSummary(currentOp, step, i)"
                class="progress-step-summary"
              >
                {{ getStepSummary(currentOp, step, i) }}
              </div>
            </div>
          </div>
        </template>

        <!-- Flat progress -->
        <template v-else>
          <div class="progress-status">
            {{
              currentOp.error
                ? $t('progress.error', { message: currentOp.error })
                : currentOp.flatStatus
            }}
          </div>
          <div class="progress-bar-track">
            <div
              class="progress-bar-fill"
              :class="{ indeterminate: currentOp.flatPercent < 0 }"
              :style="{
                width: currentOp.flatPercent >= 0
                  ? `${currentOp.flatPercent}%`
                  : '100%'
              }"
            ></div>
          </div>
        </template>

        <!-- Port conflict actions -->
        <div
          v-if="
            currentOp.finished &&
            currentOp.result?.portConflict &&
            !currentOp.result.ok
          "
          class="progress-conflict-actions"
        >
          <button
            v-if="currentOp.result.portConflict.nextPort"
            class="primary"
            @click="handleUseNextPort(currentOp.result.portConflict.nextPort!)"
          >
            {{
              $t('errors.portConflictUsePort', {
                port: currentOp.result.portConflict.nextPort
              })
            }}
          </button>
          <button
            v-if="currentOp.result.portConflict.isComfy"
            class="danger"
            @click="handleKillProcess(currentOp.result.portConflict.port)"
          >
            {{ $t('errors.portConflictKill') }}
          </button>
        </div>

        <!-- Terminal output -->
        <div
          v-if="currentOp.terminalOutput"
          class="terminal-output"
          ref="terminalRef"
          id="progress-terminal"
        >{{ currentOp.terminalOutput }}</div>

        <!-- Cancel / Done buttons -->
        <div class="view-bottom">
          <button
            v-if="currentOp.finished && currentOp.result?.ok"
            class="primary"
            @click="handleDone"
          >
            {{ $t('common.done') }}
          </button>
          <button
            v-else-if="!currentOp.finished"
            class="danger"
            :disabled="currentOp.cancelRequested"
            @click="handleCancel"
          >
            {{
              currentOp.cancelRequested
                ? $t('progress.cancelling')
                : $t('common.cancel')
            }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
