<script setup lang="ts">
import { computed, watch, ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useModal } from '../composables/useModal'
import { useLocalInstanceGuard } from '../composables/useLocalInstanceGuard'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { Download, Star, Clock, Cloud, Pin } from 'lucide-vue-next'
import DashboardCard from '../components/DashboardCard.vue'
import ContextMenu from '../components/ContextMenu.vue'
import type { Installation, ListAction } from '../types/ipc'

const props = defineProps<{
  visible: boolean
}>()

const { t } = useI18n()
const installationStore = useInstallationStore()
const sessionStore = useSessionStore()
const modal = useModal()
const localInstanceGuard = useLocalInstanceGuard()
const prefs = useLauncherPrefs()

const emit = defineEmits<{
  'show-quick-install': []
  'show-detail': [inst: Installation]
  'show-console': [installationId: string]
  'show-progress': [opts: {
    installationId: string
    title: string
    apiCall: () => Promise<unknown>
    cancellable?: boolean
  }]

}>()

const { ctxMenu, ctxMenuItems, openCardMenu, handleCtxMenuSelect, closeMenu } =
  useInstallContextMenu((inst) => emit('show-detail', inst))

const localInstalls = computed(() =>
  installationStore.installations.filter((i) => i.sourceCategory === 'local')
)

const primaryInstall = computed(() => {
  if (prefs.primaryInstallId.value) {
    const found = localInstalls.value.find((i) => i.id === prefs.primaryInstallId.value)
    if (found) return found
  }
  // Temporary fallback while the main process reassigns primary
  return localInstalls.value[0] ?? null
})

// --- Latest install ---
const latestInstall = computed(() => {
  const withTimestamp = installationStore.installations.filter(
    (i) => i.sourceCategory !== 'cloud' && typeof i.lastLaunchedAt === 'number'
  )
  if (withTimestamp.length === 0) return null
  return withTimestamp.reduce((a, b) =>
    (a.lastLaunchedAt as number) > (b.lastLaunchedAt as number) ? a : b
  )
})

const showLatestCard = computed(() =>
  latestInstall.value && latestInstall.value.id !== primaryInstall.value?.id
)

// --- Cloud install ---
const cloudInstall = computed(() =>
  installationStore.installations.find((i) => i.sourceCategory === 'cloud') ?? null
)

// --- Pinned installs (exclude cloud, primary, latest) ---
const pinnedInstalls = computed(() => {
  const excludeIds = new Set<string>()
  if (primaryInstall.value) excludeIds.add(primaryInstall.value.id)
  if (showLatestCard.value && latestInstall.value) excludeIds.add(latestInstall.value.id)

  return prefs.pinnedInstallIds.value
    .map((id) => installationStore.installations.find((i) => i.id === id))
    .filter((i): i is Installation => !!i && i.sourceCategory !== 'cloud' && !excludeIds.has(i.id))
})

// --- Actions for cards (separate generation counters) ---
const primaryActions = ref<ListAction[]>([])
const latestActions = ref<ListAction[]>([])
const cloudActions = ref<ListAction[]>([])
const pinnedActionsById = ref<Record<string, ListAction[]>>({})

let primaryGen = 0
let latestGen = 0
let cloudGen = 0
const pinnedGenById = new Map<string, number>()

const sessionDeps = [
  () => sessionStore.runningInstances.size,
  () => sessionStore.activeSessions.size,
  () => sessionStore.errorInstances.size,
]

watch(
  [() => primaryInstall.value?.id, () => props.visible, ...sessionDeps],
  async () => {
    const gen = ++primaryGen
    const id = primaryInstall.value?.id
    if (!id || !props.visible) { primaryActions.value = []; return }
    if (
      !sessionStore.isRunning(id) &&
      !sessionStore.activeSessions.has(id)
    ) {
      const actions = await window.api.getListActions(id)
      if (gen === primaryGen) primaryActions.value = actions
    } else {
      primaryActions.value = []
    }
  },
  { immediate: true }
)

watch(
  [() => latestInstall.value?.id, () => props.visible, ...sessionDeps],
  async () => {
    const gen = ++latestGen
    const id = latestInstall.value?.id
    if (!id || !props.visible || id === primaryInstall.value?.id) { latestActions.value = []; return }
    if (
      !sessionStore.isRunning(id) &&
      !sessionStore.activeSessions.has(id)
    ) {
      const actions = await window.api.getListActions(id)
      if (gen === latestGen) latestActions.value = actions
    } else {
      latestActions.value = []
    }
  },
  { immediate: true }
)

watch(
  [() => cloudInstall.value?.id, () => props.visible,
    () => sessionStore.runningInstances.size, () => sessionStore.activeSessions.size],
  async () => {
    const gen = ++cloudGen
    const id = cloudInstall.value?.id
    if (!id || !props.visible) { cloudActions.value = []; return }
    if (
      !sessionStore.isRunning(id) &&
      !sessionStore.activeSessions.has(id)
    ) {
      const actions = await window.api.getListActions(id)
      if (gen === cloudGen) cloudActions.value = actions
    } else {
      cloudActions.value = []
    }
  },
  { immediate: true }
)

watch(
  [() => pinnedInstalls.value.map((i) => i.id).join(','), () => props.visible, ...sessionDeps],
  async () => {
    if (!props.visible) { pinnedActionsById.value = {}; return }
    const result: Record<string, ListAction[]> = {}
    for (const inst of pinnedInstalls.value) {
      const gen = (pinnedGenById.get(inst.id) ?? 0) + 1
      pinnedGenById.set(inst.id, gen)
      if (
        !sessionStore.isRunning(inst.id) &&
        !sessionStore.activeSessions.has(inst.id)
      ) {
        const actions = await window.api.getListActions(inst.id)
        if (pinnedGenById.get(inst.id) === gen) result[inst.id] = actions
      } else {
        result[inst.id] = []
      }
    }
    pinnedActionsById.value = result
  },
  { immediate: true }
)

// --- Relative time (reactive) ---
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  nowTimer = setInterval(() => { now.value = Date.now() }, 60_000)
})
onBeforeUnmount(() => {
  if (nowTimer) clearInterval(nowTimer)
})

function timeAgo(timestamp: number): string {
  const diff = now.value - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// --- Launch handling ---
async function handleLaunch(inst: Installation, actions: ListAction[]): Promise<void> {
  const action = actions.find((a) => a.style === 'primary') ?? actions[0] ?? null
  if (!inst || !action) return

  if (action.enabled === false && action.disabledMessage) {
    await modal.alert({ title: action.label, message: action.disabledMessage })
    return
  }

  if (action.confirm) {
    const confirmed = await modal.confirm({
      title: action.confirm.title || 'Confirm',
      message: action.confirm.message || 'Are you sure?',
      confirmLabel: action.label,
      confirmStyle: action.style || 'danger',
    })
    if (!confirmed) return
  }

  if (action.id === 'launch') {
    const canLaunch = await localInstanceGuard.checkBeforeLaunch(inst.id)
    if (!canLaunch) return
  }

  if (action.showProgress) {
    emit('show-progress', {
      installationId: inst.id,
      title: `${action.progressTitle || action.label} — ${inst.name}`,
      apiCall: () => window.api.runAction(inst.id, action.id),
      cancellable: !!action.cancellable,
    })
    return
  }

  const result = await window.api.runAction(inst.id, action.id)
  if (result.message) {
    await modal.alert({ title: action.label, message: result.message })
  }
}

// --- Change primary ---
async function changePrimary(): Promise<void> {
  const items = localInstalls.value.map((i) => ({
    value: i.id,
    label: i.name,
    description: [i.sourceLabel, i.version].filter(Boolean).join(' · '),
  }))
  if (items.length === 0) return
  const selected = await modal.select({
    title: t('dashboard.setPrimary'),
    items,
  })
  if (selected) {
    await prefs.setPrimary(selected)
  }
}

</script>

<template>
  <div class="view active">
    <div class="view-scroll">
      <!-- Welcome state: no local installations -->
      <div v-if="!primaryInstall" class="dashboard-welcome">
        <div class="dashboard-welcome-icon">
          <Download :size="48" />
        </div>
        <h1 class="dashboard-welcome-title">{{ $t('dashboard.welcome') }}</h1>
        <p class="dashboard-welcome-desc">{{ $t('dashboard.welcomeDesc') }}</p>
        <button class="primary dashboard-cta-btn" @click="emit('show-quick-install')">
          <Download :size="18" />
          {{ $t('dashboard.installComfyUI') }}
        </button>
      </div>

      <!-- Quick Launch section -->
      <div v-if="primaryInstall" class="dashboard-section">
        <div class="dashboard-section-label">{{ $t('dashboard.quickLaunch') }}</div>
        <div class="dashboard-quick-launch">
          <!-- Latest card -->
          <div v-if="showLatestCard && latestInstall" class="dashboard-card" @contextmenu.prevent="openCardMenu($event, latestInstall!)">
            <div class="dashboard-card-badge">
              <Clock :size="14" />
              {{ $t('dashboard.recent') }}
            </div>
            <DashboardCard
              :installation="latestInstall"
              :actions="latestActions"
              @launch="handleLaunch"
              @show-detail="(inst) => emit('show-detail', inst)"
              @show-console="(id) => emit('show-console', id)"
              @show-progress="(opts) => emit('show-progress', opts)"
            >
              <template #detail>
                <div v-if="typeof latestInstall.lastLaunchedAt === 'number'" class="dashboard-card-detail">
                  {{ $t('dashboard.launchedAgo', { time: timeAgo(latestInstall.lastLaunchedAt as number) }) }}
                </div>
              </template>
            </DashboardCard>
          </div>

          <!-- Primary card -->
          <div class="dashboard-card" @contextmenu.prevent="openCardMenu($event, primaryInstall!)">
            <div class="dashboard-card-badge dashboard-card-badge-primary">
              <Star :size="14" />
              {{ $t('dashboard.primary') }}
              <button class="dashboard-change-btn" @click="changePrimary">{{ $t('dashboard.changePrimary') }}</button>
            </div>
            <DashboardCard
              :installation="primaryInstall"
              :actions="primaryActions"
              @launch="handleLaunch"
              @show-detail="(inst) => emit('show-detail', inst)"
              @show-console="(id) => emit('show-console', id)"
              @show-progress="(opts) => emit('show-progress', opts)"
            >
              <template #detail>
                <div v-if="typeof primaryInstall.lastLaunchedAt === 'number'" class="dashboard-card-detail">
                  {{ $t('dashboard.launchedAgo', { time: timeAgo(primaryInstall.lastLaunchedAt as number) }) }}
                </div>
                <div v-else class="dashboard-card-detail">
                  {{ $t('dashboard.neverLaunched') }}
                </div>
              </template>
            </DashboardCard>
          </div>

        </div>
      </div>

      <!-- Pinned section -->
      <div v-if="pinnedInstalls.length > 0" class="dashboard-section">
        <div class="dashboard-section-label">
          <Pin :size="14" style="vertical-align: -2px; margin-right: 4px;" />
          {{ $t('dashboard.pinned') }}
        </div>
        <div class="dashboard-quick-launch">
          <div
            v-for="pinned in pinnedInstalls"
            :key="pinned.id"
            class="dashboard-card"
            @contextmenu.prevent="openCardMenu($event, pinned)"
          >
            <DashboardCard
              :installation="pinned"
              :actions="pinnedActionsById[pinned.id] ?? []"
              @launch="handleLaunch"
              @show-detail="(inst) => emit('show-detail', inst)"
              @show-console="(id) => emit('show-console', id)"
              @show-progress="(opts) => emit('show-progress', opts)"
            >
              <template #detail>
                <div v-if="typeof pinned.lastLaunchedAt === 'number'" class="dashboard-card-detail">
                  {{ $t('dashboard.launchedAgo', { time: timeAgo(pinned.lastLaunchedAt as number) }) }}
                </div>
              </template>
            </DashboardCard>
          </div>
        </div>
      </div>

      <!-- Cloud section -->
      <div v-if="cloudInstall" class="dashboard-section">
        <div class="dashboard-section-label">
          <Cloud :size="14" style="vertical-align: -2px; margin-right: 4px;" />
          {{ $t('dashboard.cloudSection') }}
        </div>
        <div class="dashboard-cloud-card" @contextmenu.prevent="openCardMenu($event, cloudInstall!)">
          <DashboardCard
            :installation="cloudInstall"
            :actions="cloudActions"
            @launch="handleLaunch"
            @show-detail="(inst) => emit('show-detail', inst)"
            @show-console="(id) => emit('show-console', id)"
            @show-progress="(opts) => emit('show-progress', opts)"
          />
        </div>
      </div>

    </div>

    <!-- Context menu -->
    <ContextMenu
      :open="ctxMenu.open"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenuItems"
      @close="closeMenu"
      @select="handleCtxMenuSelect"
    />
  </div>
</template>
