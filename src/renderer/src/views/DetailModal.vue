<script setup lang="ts">
import { ref, computed, watch, nextTick, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import DetailSectionComponent from '../components/DetailSection.vue'
import { Star, Pin } from 'lucide-vue-next'
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
}

const props = defineProps<Props>()

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

const isLocal = computed(() => props.installation?.sourceCategory === 'local')
const isCloud = computed(() => props.installation?.sourceCategory === 'cloud')
const isPrimary = computed(() => props.installation ? prefs.isPrimary(props.installation.id) : false)
const isPinned = computed(() => props.installation ? prefs.isPinned(props.installation.id) : false)

const contentRef = ref<HTMLDivElement | null>(null)
const scrollRef = ref<HTMLDivElement | null>(null)
const mouseDownOnOverlay = ref(false)

const sections = ref<DetailSection[]>([])

const tabLabels = computed<Record<string, string>>(() => ({
  status: t('common.tabStatus'),
  update: t('common.tabUpdate'),
  settings: t('common.tabSettings'),
}))

const activeTab = ref<string>('status')

const availableTabs = computed(() => {
  const tabIds = new Set<string>()
  for (const s of sections.value) {
    if (s.tab && !s.pinBottom) tabIds.add(s.tab)
  }
  const ORDER = ['status', 'update', 'settings']
  return [...ORDER.filter((id) => tabIds.has(id)), ...Array.from(tabIds).filter((id) => !ORDER.includes(id))]
})

const hasTabs = computed(() => availableTabs.value.length > 1)

const mainSections = computed(() =>
  sections.value.filter((s) => !s.pinBottom && (!hasTabs.value || s.tab === activeTab.value))
)
const bottomSection = computed(() => sections.value.find((s) => s.pinBottom) ?? null)

const previousInstId = ref<string | null>(null)

watch(
  () => props.installation,
  async (inst) => {
    if (!inst) {
      sections.value = []
      previousInstId.value = null
      return
    }
    if (!inst.seen) {
      window.api.updateInstallation(inst.id, { seen: true })
    }
    const isNewInstallation = inst.id !== previousInstId.value
    previousInstId.value = inst.id
    sections.value = await window.api.getDetailSections(inst.id)
    if (isNewInstallation) {
      activeTab.value = 'status'
      await nextTick()
      if (scrollRef.value) scrollRef.value.scrollTop = 0
    }
  },
  { immediate: true }
)

async function handleTitleBlur(event: FocusEvent): Promise<void> {
  if (!props.installation) return
  const el = event.target as HTMLElement
  const newName = el.textContent?.trim() ?? ''
  if (newName && newName !== props.installation.name) {
    const result = await window.api.updateInstallation(props.installation.id, { name: newName })
    if (result && !(result as ActionResult).ok && (result as ActionResult).ok !== undefined) {
      el.textContent = props.installation.name
      await modal.alert({
        title: props.installation.name,
        message: (result as ActionResult).message || ''
      })
    } else {
      emit('update:installation', { ...props.installation, name: newName })
    }
  } else {
    el.textContent = props.installation.name
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
      required: mutableAction.prompt.required
    })
    if (!value) return
    mutableAction = {
      ...mutableAction,
      data: { ...mutableAction.data, [mutableAction.prompt.field]: value }
    }
  }

  // confirm chain
  if (mutableAction.confirm) {
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
      if (space.free < 1073741824) {
        const freeStr = `${(space.free / 1048576).toFixed(0)} MB`
        const ok = await modal.confirm({
          title: t('diskSpace.warningTitle'),
          message: t('diskSpace.warningMessageGeneric', { free: freeStr }),
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
    const result = await window.api.runAction(
      props.installation.id,
      mutableAction.id,
      mutableAction.data ? toRaw(mutableAction.data) : undefined
    )
    if (result.navigate === 'list') {
      emit('close')
      emit('navigate-list')
    } else if (result.navigate === 'detail') {
      await refreshAllSections()
    } else if (result.message) {
      await modal.alert({ title: mutableAction.label, message: result.message })
    }
  } finally {
    if (btn) {
      btn.disabled = false
      btn.classList.remove('loading')
      if (savedLabel !== undefined) btn.textContent = savedLabel
    }
  }
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
          contenteditable
          spellcheck="false"
          @blur="handleTitleBlur"
          @keydown.enter.prevent="($event.target as HTMLElement).blur()"
        >
          {{ installation.name }}
        </div>
        <div class="detail-header-actions">
          <button
            v-if="isLocal"
            class="detail-header-btn"
            :class="{ active: isPrimary }"
            :disabled="isPrimary"
            :title="$t('dashboard.setPrimary')"
            @click="prefs.setPrimary(installation!.id)"
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
        </div>

        <!-- Bottom pinned actions -->
        <div v-if="bottomSection" id="detail-bottom-actions">
          <div class="detail-actions">
            <button
              v-for="a in bottomSection.actions"
              :key="a.id"
              :class="[
                a.style,
                { 'looks-disabled': a.enabled === false && a.disabledMessage }
              ]"
              :disabled="a.enabled === false && !a.disabledMessage"
              @click="handleActionClick(a, $event)"
            >
              {{ a.label }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
