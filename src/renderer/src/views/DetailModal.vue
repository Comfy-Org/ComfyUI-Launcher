<script setup lang="ts">
import { ref, computed, watch, nextTick, toRaw, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import { useActionGuard } from '../composables/useActionGuard'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import DetailSectionComponent from '../components/DetailSection.vue'
import SnapshotTab from '../components/SnapshotTab.vue'
import { useInstallationStore } from '../stores/installationStore'
import { emitTelemetryAction, toErrorBucket } from '../lib/telemetry'
import { useMigrateAction } from '../composables/useMigrateAction'
import { REQUIRES_STOPPED } from '../types/ipc'
import { Star, Pin, Pencil } from 'lucide-vue-next'
import TooltipWrap from '../components/TooltipWrap.vue'
import type {
  Installation,
  ActionDef,
  DetailSection,
  FieldOption,
  ActionResult,
  DiskSpaceInfo
} from '../types/ipc'

interface Props {
  installation: Installation | null
  initialTab?: string
  autoAction?: string | null
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'status',
  autoAction: null,
})

const emit = defineEmits<{
  close: []
  'show-progress': [
    opts: {
      installationId: string
      title: string
      apiCall: () => Promise<unknown>
      cancellable?: boolean
      returnTo?: string
    }
  ]
  'navigate-list': []
  'update:installation': [inst: Installation]
}>()

const { t } = useI18n()
const modal = useModal()
const prefs = useLauncherPrefs()
const installationStore = useInstallationStore()
const actionGuard = useActionGuard()
const { confirmMigration } = useMigrateAction()

const isLocal = computed(() => props.installation?.sourceCategory === 'local')
const isDesktop = computed(() => props.installation?.sourceId === 'desktop')
const isCloud = computed(() => props.installation?.sourceCategory === 'cloud')
const isPrimary = computed(() => props.installation ? prefs.isPrimary(props.installation.id) : false)
const isPinned = computed(() => props.installation ? prefs.isPinned(props.installation.id) : false)

async function confirmSetPrimary(): Promise<void> {
  if (!props.installation) return
  const confirmed = await modal.confirm({
    title: t('dashboard.setPrimary'),
    message: t('dashboard.setPrimaryConfirm', { name: props.installation.name }),
    confirmLabel: t('dashboard.setPrimary'),
    confirmStyle: 'primary',
  })
  if (confirmed) {
    await prefs.setPrimary(props.installation.id)
  }
}

const contentRef = ref<HTMLDivElement | null>(null)
const scrollRef = ref<HTMLDivElement | null>(null)
const mouseDownOnOverlay = ref(false)

const sections = ref<DetailSection[]>([])
const sectionsLoading = ref(false)
const installationSize = ref<number | null>(null)
const installationSizeLoading = ref(false)

const tabLabels = computed<Record<string, string>>(() => ({
  status: t('common.tabStatus'),
  update: t('common.tabUpdate'),
  snapshots: t('common.tabSnapshots'),
  settings: t('common.tabSettings'),
}))

const activeTab = ref<string>('status')

const availableTabs = computed(() => {
  const tabIds = new Set<string>()
  for (const s of sections.value) {
    if (s.tab && !s.pinBottom) tabIds.add(s.tab)
  }
  const ORDER = ['status', 'update', 'snapshots', 'settings']
  return [...ORDER.filter((id) => tabIds.has(id)), ...Array.from(tabIds).filter((id) => !ORDER.includes(id))]
})

const hasTabs = computed(() => availableTabs.value.length > 1)

const mainSections = computed(() =>
  sections.value.filter((s) => !s.pinBottom && (!hasTabs.value || s.tab === activeTab.value))
)
const bottomSection = computed(() => sections.value.find((s) => s.pinBottom) ?? null)

const previousInstId = ref<string | null>(null)
const autoActionRun = ref(false)
let sizeGeneration = 0

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`
  return `${(bytes / 1048576).toFixed(0)} MB`
}

async function fetchInstallationSize(installationId: string): Promise<void> {
  const gen = ++sizeGeneration
  installationSize.value = null
  installationSizeLoading.value = true
  try {
    const result = await window.api.getInstallationSize(installationId)
    if (gen !== sizeGeneration) return
    installationSize.value = result.sizeBytes
  } catch {
    if (gen !== sizeGeneration) return
    installationSize.value = null
  } finally {
    if (gen === sizeGeneration) installationSizeLoading.value = false
  }
}

watch(
  () => props.installation,
  async (inst) => {
    if (!inst) {
      sections.value = []
      sectionsLoading.value = false
      previousInstId.value = null
      installationSize.value = null
      installationSizeLoading.value = false
      return
    }
    if (!inst.seen) {
      window.api.updateInstallation(inst.id, { seen: true })
    }
    const isNewInstallation = inst.id !== previousInstId.value
    previousInstId.value = inst.id
    if (isNewInstallation) autoActionRun.value = false
    if (isNewInstallation) sectionsLoading.value = true
    try {
      sections.value = await window.api.getDetailSections(inst.id)
    } finally {
      sectionsLoading.value = false
    }
    if (isNewInstallation) {
      const tabExists = sections.value.some((s) => s.tab === props.initialTab)
      activeTab.value = tabExists ? props.initialTab : 'status'
      await nextTick()
      if (scrollRef.value) scrollRef.value.scrollTop = 0
      if (inst.installPath) {
        fetchInstallationSize(inst.id)
      } else {
        sizeGeneration++
        installationSize.value = null
        installationSizeLoading.value = false
        window.api.cancelInstallationSize()
      }

      // Auto-trigger an action if requested (e.g. from migrate pill click)
      if (props.autoAction && !autoActionRun.value) {
        autoActionRun.value = true
        const actionId = props.autoAction
        for (const section of sections.value) {
          const action = section.actions?.find((a: ActionDef) => a.id === actionId)
          if (action) {
            await nextTick()
            runAction(action, null)
            break
          }
        }
      }
    }
  },
  { immediate: true }
)

function getTitleTextNode(el: HTMLElement): Text {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) return node as Text
  }
  const text = document.createTextNode('')
  el.prepend(text)
  return text
}

function handleTitleSelectAll(event: KeyboardEvent): void {
  event.preventDefault()
  const el = event.currentTarget as HTMLElement
  const textNode = getTitleTextNode(el)
  const range = document.createRange()
  range.selectNodeContents(textNode)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function handleTitlePaste(event: ClipboardEvent): void {
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') ?? ''
  document.execCommand('insertText', false, text)
}

async function handleTitleBlur(event: FocusEvent): Promise<void> {
  if (!props.installation) return
  const el = event.target as HTMLElement
  const textNode = getTitleTextNode(el)
  const newName = textNode.textContent?.trim() ?? ''
  if (newName && newName !== props.installation.name) {
    const result = await window.api.updateInstallation(props.installation.id, { name: newName })
    if (result && !(result as ActionResult).ok && (result as ActionResult).ok !== undefined) {
      textNode.textContent = ` ${props.installation.name}`
      await modal.alert({
        title: props.installation.name,
        message: (result as ActionResult).message || ''
      })
    } else {
      emit('update:installation', { ...props.installation, name: newName })
    }
  } else {
    textNode.textContent = ` ${props.installation.name}`
  }
}

async function refreshSection(sectionTitle: string): Promise<void> {
  if (!props.installation) return
  const fresh = await window.api.getDetailSections(props.installation.id)
  const updated = fresh.find((s) => s.title === sectionTitle)
  if (!updated) return
  const idx = sections.value.findIndex((s) => s.title === sectionTitle)
  if (idx >= 0) {
    sections.value.splice(idx, 1, updated)
  }
}

async function refreshAllSections(): Promise<void> {
  if (!props.installation) return
  const all = await window.api.getInstallations()
  const fresh = all.find((i) => i.id === props.installation!.id)
  if (fresh) emit('update:installation', fresh)
  sections.value = await window.api.getDetailSections(props.installation.id)
}

function handleActionClick(action: ActionDef, event: MouseEvent): void {
  if (action.enabled === false && action.disabledMessage) {
    modal.alert({ title: action.label, message: action.disabledMessage })
    return
  }
  runAction(action, event.target as HTMLButtonElement)
}

async function runAction(action: ActionDef, btn: HTMLButtonElement | null): Promise<void> {
  if (!props.installation) return
  const telemetryContext = {
    source_category: props.installation.sourceCategory || 'unknown',
    ui_surface: 'detail',
  }

  // Pre-flight: check if the installation is busy or running
  // Skip for migrate-to-standalone — the useMigrateAction composable handles its own guard
  if (action.id !== 'migrate-to-standalone' && REQUIRES_STOPPED.has(action.id)) {
    if (!await actionGuard.checkBeforeAction(props.installation.id, action.label)) return
  }

  let mutableAction = { ...action }

  // fieldSelects chain
  if (mutableAction.fieldSelects) {
    const selections: Record<string, FieldOption> = {}
    for (const fs of mutableAction.fieldSelects) {
      let items: FieldOption[]
      try {
        items = await window.api.getFieldOptions(fs.sourceId, fs.fieldId, selections)
      } catch (err: unknown) {
        await modal.alert({
          title: mutableAction.label,
          message: (err as Error).message || String(err)
        })
        return
      }
      if (!items || items.length === 0) {
        await modal.alert({
          title: mutableAction.label,
          message: fs.emptyMessage || t('common.noItems')
        })
        return
      }
      const selectItems = items.map((item) => ({
        value: item.value,
        label: (item.recommended ? '★ ' : '') + item.label,
        description: item.description
      }))
      const selected = await modal.select({
        title: fs.title || mutableAction.label,
        message: fs.message || '',
        items: selectItems
      })
      if (!selected) return
      const selectedItem = items.find((i) => i.value === selected)
      if (selectedItem) selections[fs.fieldId] = selectedItem
      mutableAction = {
        ...mutableAction,
        data: { ...mutableAction.data, [fs.field]: selectedItem }
      }
    }
  }

  // select chain
  if (mutableAction.select) {
    let items: { value: string; label: string; description?: string }[] | undefined
    if (mutableAction.select.source === 'installations') {
      let all = await window.api.getInstallations()
      if (mutableAction.select.excludeSelf && props.installation) {
        all = all.filter((i) => i.id !== props.installation!.id)
      }
      if (mutableAction.select.filters) {
        for (const [key, value] of Object.entries(mutableAction.select.filters)) {
          all = all.filter(
            (i) => (i as Record<string, unknown>)[key] === value
          )
        }
      }
      items = all.map((i) => ({ value: i.id, label: i.name, description: i.sourceLabel }))
    }
    if (!items || items.length === 0) {
      await modal.alert({
        title: mutableAction.label,
        message: mutableAction.select.emptyMessage || t('common.noItems')
      })
      return
    }
    const selected = await modal.select({
      title: mutableAction.select.title || mutableAction.label,
      message: mutableAction.select.message || '',
      items
    })
    if (!selected) return
    mutableAction = {
      ...mutableAction,
      data: { ...mutableAction.data, [mutableAction.select.field]: selected }
    }
  }

  // prompt chain
  if (mutableAction.prompt) {
    const value = await modal.prompt({
      title: mutableAction.prompt.title || mutableAction.label,
      message: mutableAction.prompt.message || '',
      placeholder: mutableAction.prompt.placeholder,
      defaultValue: mutableAction.prompt.defaultValue,
      confirmLabel: mutableAction.prompt.confirmLabel || mutableAction.label,
      required: mutableAction.prompt.required,
      messageDetails: mutableAction.prompt.messageDetails,
    })
    if (!value) return
    mutableAction = {
      ...mutableAction,
      data: { ...mutableAction.data, [mutableAction.prompt.field]: value }
    }
  }

  // Migration preview — delegates to useMigrateAction composable
  if (mutableAction.id === 'migrate-to-standalone') {
    const migrateResult = await confirmMigration(props.installation, mutableAction.confirm)
    if (!migrateResult) return

    mutableAction = {
      ...mutableAction,
      data: {
        ...mutableAction.data,
        ...migrateResult,
      },
    }
  }

  // confirm chain — skip for migrate-to-standalone since it handles its own confirmation above
  if (mutableAction.confirm && mutableAction.id !== 'migrate-to-standalone') {
    if (mutableAction.confirm.options) {
      const result = await modal.confirmWithOptions({
        title: mutableAction.confirm.title || 'Confirm',
        message: mutableAction.confirm.message || 'Are you sure?',
        options: mutableAction.confirm.options,
        confirmLabel: mutableAction.confirm.confirmLabel || mutableAction.label,
        confirmStyle: mutableAction.style || 'danger'
      })
      if (!result) return
      mutableAction = { ...mutableAction, data: { ...mutableAction.data, ...result } }
    } else {
      const confirmed = await modal.confirm({
        title: mutableAction.confirm.title || 'Confirm',
        message: mutableAction.confirm.message || 'Are you sure?',
        messageDetails: mutableAction.confirm.messageDetails,
        confirmLabel: mutableAction.label,
        confirmStyle: mutableAction.style || 'danger'
      })
      if (!confirmed) return
    }
  }

  // Disk space check for actions that write significant data
  const diskCheckActions = new Set(['copy', 'copy-update', 'release-update'])
  if (diskCheckActions.has(mutableAction.id) && props.installation?.installPath) {
    try {
      const space: DiskSpaceInfo = await window.api.getDiskSpace(props.installation.installPath)
      let estimatedRequired = 0
      if (mutableAction.id === 'copy' || mutableAction.id === 'copy-update') {
        if (installationSizeLoading.value) {
          // Size still calculating — fetch it now before proceeding
          try {
            const result = await window.api.getInstallationSize(props.installation.id)
            estimatedRequired = result.sizeBytes
          } catch {
            // Fall through to generic check
          }
        } else {
          estimatedRequired = installationSize.value ?? 0
        }
      }
      // Add 10% buffer for filesystem overhead (block alignment, journal, etc.)
      const threshold = estimatedRequired > 0 ? Math.ceil(estimatedRequired * 1.1) : 1073741824
      if (space.free < threshold) {
        const freeStr = formatBytes(space.free)
        const message = estimatedRequired > 0
          ? t('diskSpace.warningMessage', { free: freeStr, required: formatBytes(estimatedRequired) })
          : t('diskSpace.warningMessageGeneric', { free: freeStr })
        const ok = await modal.confirm({
          title: t('diskSpace.warningTitle'),
          message,
          confirmLabel: t('diskSpace.continueAnyway'),
          confirmStyle: 'primary',
        })
        if (!ok) return
      }
    } catch {
      // If disk space check fails, proceed anyway
    }
  }

  // showProgress
  if (mutableAction.showProgress) {
    const instId = props.installation.id
    const instName = props.installation.name
    const rawTitle = (mutableAction.progressTitle || mutableAction.label).replace(
      /\{(\w+)\}/g,
      (_, k: string) =>
        String((mutableAction.data as Record<string, unknown>)?.[k] ?? k)
    )
    const title = `${rawTitle} — ${instName}`
    emitTelemetryAction('launcher.action.invoked', { action_id: mutableAction.id, ...telemetryContext })
    emit('show-progress', {
      installationId: instId,
      title,
      apiCall: () => window.api.runAction(instId, mutableAction.id, mutableAction.data ? toRaw(mutableAction.data) : undefined),
      cancellable: !!mutableAction.cancellable,
      returnTo: 'detail'
    })
    return
  }

  // Inline action with loading state
  let savedLabel: string | undefined
  if (btn) {
    savedLabel = btn.textContent || ''
    btn.disabled = true
    btn.classList.add('loading')
  }
  try {
    emitTelemetryAction('launcher.action.invoked', { action_id: mutableAction.id, ...telemetryContext })
    const result = await window.api.runAction(
      props.installation.id,
      mutableAction.id,
      mutableAction.data ? toRaw(mutableAction.data) : undefined
    )
    // Fallback: backend detected running instance (race condition)
    if (result.running && props.installation) {
      await actionGuard.checkBeforeAction(props.installation.id, mutableAction.label)
      return
    }
    const resultValue = result.cancelled ? 'cancelled' : (result.ok === false ? 'failed' : 'ok')
    emitTelemetryAction('launcher.action.result', { action_id: mutableAction.id, result: resultValue, ...telemetryContext })
    if (result.navigate === 'list') {
      emit('close')
      emit('navigate-list')
    } else if (result.navigate === 'detail') {
      await refreshAllSections()
    } else if (result.message) {
      await modal.alert({ title: mutableAction.label, message: result.message })
    }
  } catch (error: unknown) {
    emitTelemetryAction('launcher.action.result', {
      action_id: mutableAction.id,
      result: 'failed',
      error_bucket: toErrorBucket(error),
      ...telemetryContext,
    })
    throw error
  } finally {
    if (btn) {
      btn.disabled = false
      btn.classList.remove('loading')
      if (savedLabel !== undefined) btn.textContent = savedLabel
    }
  }
}

function navigateToInstallation(installationId: string): void {
  const inst = installationStore.getById(installationId)
  if (inst) emit('update:installation', inst)
}

function handleOverlayMouseDown(event: MouseEvent): void {
  mouseDownOnOverlay.value = event.target === contentRef.value?.parentElement
}

function handleOverlayClick(event: MouseEvent): void {
  if (mouseDownOnOverlay.value && event.target === contentRef.value?.parentElement) {
    emit('close')
  }
  mouseDownOnOverlay.value = false
}

function handleEscapeKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.installation) {
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleEscapeKey)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleEscapeKey)
})
</script>

<template>
  <div
    v-if="installation"
    class="view-modal active"
    @mousedown="handleOverlayMouseDown"
    @click="handleOverlayClick"
  >
    <div ref="contentRef" class="view-modal-content">
      <div class="view-modal-header">
        <div
          class="view-modal-title"
          role="textbox"
          :aria-label="$t('detail.editName', 'Edit installation name')"
          contenteditable
          spellcheck="false"
          @blur="handleTitleBlur"
          @keydown.enter.prevent="($event.target as HTMLElement).blur()"
          @keydown.ctrl.a.prevent="handleTitleSelectAll"
          @paste="handleTitlePaste"
        >
          {{ installation.name }}<Pencil :size="14" class="edit-name-hint" contenteditable="false" />
        </div>
        <div class="detail-header-actions">
          <button
            v-if="isLocal && !isDesktop"
            class="detail-header-btn"
            :class="{ active: isPrimary }"
            :disabled="isPrimary"
            :title="$t('dashboard.setPrimary')"
            @click="confirmSetPrimary"
          >
            <Star :size="16" />
          </button>
          <button
            v-if="!isCloud"
            class="detail-header-btn"
            :class="{ active: isPinned }"
            :title="isPinned ? $t('dashboard.unpinFromDashboard') : $t('dashboard.pinToDashboard')"
            @click="isPinned ? prefs.unpinInstall(installation!.id) : prefs.pinInstall(installation!.id)"
          >
            <Pin :size="16" />
          </button>
        </div>
        <button class="view-modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="view-modal-body">
        <div v-if="hasTabs" class="detail-tabs">
          <button
            v-for="tabId in availableTabs"
            :key="tabId"
            class="detail-tab"
            :class="{ active: activeTab === tabId }"
            @click="activeTab = tabId"
          >
            {{ tabLabels[tabId] ?? tabId }}
          </button>
        </div>
        <div ref="scrollRef" class="view-scroll">
          <div v-if="sectionsLoading" class="modal-loading with-spinner">{{ $t('common.loading') }}</div>
          <SnapshotTab
            v-else-if="activeTab === 'snapshots'"
            :installation-id="installation.id"
            @run-action="runAction"
            @refresh-all="refreshAllSections"
            @navigate-installation="navigateToInstallation"
          />
          <template v-else>
            <DetailSectionComponent
              v-for="section in mainSections"
              :key="section.title ?? 'untitled'"
              :installation-id="installation.id"
              :title="section.title"
              :description="section.description"
              :collapsed="section.collapsed"
              :items="section.items"
              :fields="section.fields"
              :actions="section.actions"
              @run-action="runAction"
              @refresh="refreshSection"
              @refresh-all="refreshAllSections"
            />
            <div v-if="activeTab === 'status' && (installationSizeLoading || installationSize !== null)" class="detail-section">
              <div class="detail-section-body">
                <div class="detail-fields">
                  <div>
                    <div class="detail-field-label">{{ $t('diskSpace.sizeLabel') }}</div>
                    <div class="detail-field-value">
                      {{ installationSizeLoading ? $t('diskSpace.calculatingSize') : (installationSize !== null ? formatBytes(installationSize) : $t('diskSpace.sizeUnavailable')) }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- Bottom pinned actions -->
        <div v-if="bottomSection" id="detail-bottom-actions">
          <div class="detail-actions">
            <TooltipWrap
              v-for="a in bottomSection.actions"
              :key="a.id"
              :text="a.tooltip"
            >
              <button
                :class="[
                  a.style,
                  { 'looks-disabled': a.enabled === false && a.disabledMessage }
                ]"
                :disabled="a.enabled === false && !a.disabledMessage"
                @click="handleActionClick(a, $event)"
              >
                {{ a.label }}
              </button>
            </TooltipWrap>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
