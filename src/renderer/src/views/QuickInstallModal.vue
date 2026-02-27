<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import type { Source, FieldOption, DiskSpaceInfo, PathIssue } from '../types/ipc'

const emit = defineEmits<{
  close: []
  'show-progress': [
    opts: {
      installationId: string
      title: string
      apiCall: () => Promise<unknown>
      cancellable?: boolean
    }
  ]
}>()

const { t } = useI18n()
const modal = useModal()

const source = ref<Source | null>(null)
const detectedGpu = ref('')
const variantOptions = ref<FieldOption[]>([])
const selectedVariant = ref<FieldOption | null>(null)
const releaseSelection = ref<FieldOption | null>(null)
const loading = ref(true)
const installing = ref(false)
const errorMessage = ref('')
const instName = ref('')
const instPath = ref('')
const defaultInstPath = ref('')
const diskSpace = ref<DiskSpaceInfo | null>(null)
const diskSpaceLoading = ref(false)
const pathIssues = ref<PathIssue[]>([])
let diskSpaceTimer: ReturnType<typeof setTimeout> | null = null
let diskSpaceGeneration = 0

/** Map GPU vendor key (from variantId) to a logo image path */
const variantImages: Record<string, string> = {
  nvidia: './images/nvidia-logo.jpg',
  amd: './images/amd-logo.png',
  mps: './images/apple-mps-logo.png',
}

/** Preferred display order for variant cards */
const variantOrder: string[] = ['amd', 'nvidia', 'intel-xpu', 'cpu', 'mps']

function stripVariantPrefix(variantId: string): string {
  return variantId.replace(/^(win|mac|linux)-/, '')
}

function getVariantImage(option: FieldOption): string | null {
  const stripped = stripVariantPrefix((option.data?.variantId as string) ?? option.value)
  for (const key of Object.keys(variantImages)) {
    if (stripped === key || stripped.startsWith(key + '-')) return variantImages[key]!
  }
  return null
}

function sortedVariants(options: FieldOption[]): FieldOption[] {
  return [...options].sort((a, b) => {
    const aKey = stripVariantPrefix((a.data?.variantId as string) ?? a.value)
    const bKey = stripVariantPrefix((b.data?.variantId as string) ?? b.value)
    const aIdx = variantOrder.findIndex((k) => aKey === k || aKey.startsWith(k + '-'))
    const bIdx = variantOrder.findIndex((k) => bKey === k || bKey.startsWith(k + '-'))
    return (aIdx < 0 ? 999 : aIdx) - (bIdx < 0 ? 999 : bIdx)
  })
}

const canInstall = computed(() =>
  !loading.value && !installing.value && selectedVariant.value !== null && pathIssues.value.length === 0
)

function fetchDiskSpace(targetPath: string): void {
  if (diskSpaceTimer) clearTimeout(diskSpaceTimer)
  diskSpaceTimer = setTimeout(async () => {
    if (!targetPath) {
      diskSpace.value = null
      pathIssues.value = []
      return
    }
    const gen = ++diskSpaceGeneration
    diskSpaceLoading.value = true
    try {
      const [space, issues] = await Promise.all([
        window.api.getDiskSpace(targetPath),
        window.api.validateInstallPath(targetPath),
      ])
      if (gen !== diskSpaceGeneration) return
      diskSpace.value = space
      pathIssues.value = issues
    } catch {
      if (gen !== diskSpaceGeneration) return
      diskSpace.value = null
      pathIssues.value = []
    } finally {
      if (gen === diskSpaceGeneration) {
        diskSpaceLoading.value = false
      }
    }
  }, 300)
}

watch(instPath, (newPath) => {
  diskSpace.value = null
  pathIssues.value = []
  fetchDiskSpace(newPath)
})

onUnmounted(() => {
  if (diskSpaceTimer) clearTimeout(diskSpaceTimer)
})

async function handleBrowse(): Promise<void> {
  const chosen = await window.api.browseFolder(instPath.value)
  if (chosen) instPath.value = chosen
}

function resetInstPath(): void {
  instPath.value = defaultInstPath.value
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`
  return `${(bytes / 1048576).toFixed(0)} MB`
}

/** Deep-strip Vue reactive proxies for safe IPC serialization */
function rawSelections(): Record<string, FieldOption> {
  const result: Record<string, FieldOption> = {}
  if (releaseSelection.value) {
    result.release = JSON.parse(JSON.stringify(toRaw(releaseSelection.value))) as FieldOption
  }
  if (selectedVariant.value) {
    result.variant = JSON.parse(JSON.stringify(toRaw(selectedVariant.value))) as FieldOption
  }
  return result
}

let installDirPromise: Promise<string> | null = null

onMounted(() => {
  installDirPromise = window.api.getDefaultInstallDir().catch(() => '')
})

async function open(): Promise<void> {
  loading.value = true
  installing.value = false
  errorMessage.value = ''
  variantOptions.value = []
  selectedVariant.value = null
  releaseSelection.value = null
  source.value = null
  instName.value = ''
  diskSpace.value = null
  diskSpaceLoading.value = false
  pathIssues.value = []

  detectedGpu.value = t('newInstall.detectingGpu')

  try {
    const [sources, gpu, defaultDir, hw] = await Promise.all([
      window.api.getSources(),
      window.api.detectGPU().catch(() => null),
      installDirPromise ?? window.api.getDefaultInstallDir().catch(() => ''),
      window.api.validateHardware(),
    ])

    if (!hw.supported) {
      await modal.alert({
        title: t('newInstall.unsupportedHardwareTitle'),
        message: hw.error || '',
      })
      emit('close')
      return
    }

    defaultInstPath.value = defaultDir ?? ''
    instPath.value = defaultInstPath.value

    if (gpu) {
      detectedGpu.value = t('newInstall.detectedGpu', { label: gpu.label })
    } else {
      detectedGpu.value = t('newInstall.noGpuDetected')
    }

    const standalone = sources.find((s) => s.id === 'standalone')
    if (!standalone) {
      errorMessage.value = t('newInstall.noOptions')
      loading.value = false
      return
    }
    source.value = standalone

    // Load releases and auto-select latest
    const releases = await window.api.getFieldOptions('standalone', 'release', {})
    if (releases.length === 0) {
      errorMessage.value = t('newInstall.noOptions')
      loading.value = false
      return
    }
    releaseSelection.value = releases[0]!

    // Load variants for the selected release
    const variants = await window.api.getFieldOptions(
      'standalone',
      'variant',
      { release: JSON.parse(JSON.stringify(toRaw(releaseSelection.value))) as FieldOption }
    )
    variantOptions.value = variants

    // Auto-select recommended variant
    const recommended = variants.find((v) => v.recommended)
    selectedVariant.value = recommended ?? variants[0] ?? null

    loading.value = false
  } catch (err: unknown) {
    errorMessage.value = (err as Error).message || String(err)
    loading.value = false
  }
}

function selectVariant(option: FieldOption): void {
  selectedVariant.value = option
}

async function handleInstall(): Promise<void> {
  if (!source.value || !selectedVariant.value) return
  installing.value = true

  try {
    // Warn if NVIDIA driver is too old for the bundled PyTorch
    const variantId = selectedVariant.value.data?.variantId as string | undefined
    if (variantId && stripVariantPrefix(variantId).startsWith('nvidia')) {
      const driverCheck = await window.api.checkNvidiaDriver()
      if (driverCheck && !driverCheck.supported) {
        const ok = await modal.confirm({
          title: t('newInstall.nvidiaDriverWarningTitle'),
          message: t('newInstall.nvidiaDriverWarning', {
            driverVersion: driverCheck.driverVersion,
            minimumVersion: driverCheck.minimumVersion,
          }),
          confirmLabel: t('newInstall.nvidiaDriverContinue'),
          confirmStyle: 'primary',
        })
        if (!ok) { installing.value = false; return }
      }
    }

    // Validate install path
    if (instPath.value) {
      try {
        const issues = await window.api.validateInstallPath(instPath.value)
        for (const issue of issues) {
          if (issue === 'insideAppBundle') {
            await modal.alert({
              title: t('pathValidation.insideAppBundleTitle'),
              message: t('pathValidation.insideAppBundleMessage'),
            })
            installing.value = false
            return
          }
          if (issue === 'oneDrive') {
            await modal.alert({
              title: t('pathValidation.oneDriveTitle'),
              message: t('pathValidation.oneDriveMessage'),
            })
            installing.value = false
            return
          }
          if (issue === 'insideSharedDir') {
            await modal.alert({
              title: t('pathValidation.insideSharedDirTitle'),
              message: t('pathValidation.insideSharedDirMessage'),
            })
            installing.value = false
            return
          }
          if (issue === 'insideExistingInstall') {
            await modal.alert({
              title: t('pathValidation.insideExistingInstallTitle'),
              message: t('pathValidation.insideExistingInstallMessage'),
            })
            installing.value = false
            return
          }
        }
      } catch {
        // If validation fails, proceed anyway
      }
    }

    // Check disk space
    if (instPath.value) {
      try {
        const space = await window.api.getDiskSpace(instPath.value)
        const downloadFiles = selectedVariant.value.data?.downloadFiles as
          Array<{ size: number }> | undefined
        const downloadBytes = downloadFiles
          ? downloadFiles.reduce((sum, f) => sum + f.size, 0)
          : 0
        const estimatedRequired = downloadBytes > 0 ? downloadBytes * 2 : 0

        if (estimatedRequired > 0 && space.free < estimatedRequired) {
          const ok = await modal.confirm({
            title: t('diskSpace.warningTitle'),
            message: t('diskSpace.warningMessage', {
              free: formatBytes(space.free),
              required: formatBytes(estimatedRequired),
            }),
            confirmLabel: t('diskSpace.continueAnyway'),
            confirmStyle: 'primary',
          })
          if (!ok) { installing.value = false; return }
        } else if (space.free < 1073741824) {
          const ok = await modal.confirm({
            title: t('diskSpace.warningTitle'),
            message: t('diskSpace.warningMessageGeneric', {
              free: formatBytes(space.free),
            }),
            confirmLabel: t('diskSpace.continueAnyway'),
            confirmStyle: 'primary',
          })
          if (!ok) { installing.value = false; return }
        }
      } catch {
        // If disk space check fails, proceed anyway
      }
    }

    const instData = await window.api.buildInstallation('standalone', rawSelections())
    const baseName = instName.value.trim() || 'ComfyUI'
    const name = await window.api.getUniqueName(baseName)

    const result = await window.api.addInstallation({
      name,
      installPath: instPath.value,
      ...instData
    })

    if (!result.ok) {
      await modal.alert({
        title: t('errors.cannotAdd'),
        message: result.message || ''
      })
      installing.value = false
      return
    }

    emit('close')
    if (result.entry) {
      emit('show-progress', {
        installationId: result.entry.id,
        title: `${t('newInstall.installing')} — ${name}`,
        apiCall: () => window.api.installInstance(result.entry!.id)
      })
    }
  } catch (err: unknown) {
    await modal.alert({
      title: t('errors.installFailed'),
      message: (err as Error).message || String(err)
    })
    installing.value = false
  }
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

defineExpose({ open })
</script>

<template>
  <div
    class="view-modal active"
    @mousedown="handleOverlayMouseDown"
    @click="handleOverlayClick"
  >
    <div class="view-modal-content quick-install-modal">
      <div class="view-modal-header">
        <div class="view-modal-title">{{ $t('quickInstall.title') }}</div>
        <button class="view-modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="view-modal-body">
        <div class="view-scroll">
          <div v-if="loading" class="wizard-loading">
            {{ $t('newInstall.loading') }}
          </div>

          <div v-else-if="errorMessage" class="wizard-loading">
            {{ errorMessage }}
          </div>

          <template v-else>
            <p class="quick-install-desc">{{ $t('quickInstall.desc') }}</p>

            <div class="detected-hardware">{{ detectedGpu }}</div>

            <div class="field">
              <label>{{ $t('quickInstall.selectVariant') }}</label>
              <div class="variant-cards">
                <div
                  v-for="opt in sortedVariants(variantOptions)"
                  :key="opt.value"
                  :class="['variant-card', {
                    selected: selectedVariant?.value === opt.value,
                    recommended: opt.recommended
                  }]"
                  @click="selectVariant(opt)"
                >
                  <div class="variant-card-icon">
                    <img
                      v-if="getVariantImage(opt)"
                      :src="getVariantImage(opt)!"
                      :alt="opt.label"
                      draggable="false"
                    />
                    <span v-else class="variant-card-icon-text">{{ opt.label }}</span>
                  </div>
                  <div class="variant-card-label">{{ opt.label }}</div>
                  <div v-if="opt.recommended" class="variant-card-badge">
                    {{ $t('newInstall.recommended') }}
                  </div>
                  <div v-if="opt.description" class="variant-card-desc">
                    {{ opt.description }}
                  </div>
                </div>
              </div>
            </div>

            <div class="field">
              <label for="qi-name">{{ $t('common.name') }}</label>
              <input
                id="qi-name"
                v-model="instName"
                type="text"
                :placeholder="$t('common.namePlaceholder')"
              />
            </div>

            <div class="field">
              <label for="qi-path">{{ $t('newInstall.installLocation') }}</label>
              <div class="path-input">
                <input
                  id="qi-path"
                  v-model="instPath"
                  type="text"
                />
                <button @click="handleBrowse">{{ $t('common.browse') }}</button>
                <button
                  v-if="instPath !== defaultInstPath"
                  @click="resetInstPath"
                >{{ $t('common.resetDefault') }}</button>
              </div>
              <div v-if="pathIssues.includes('insideAppBundle')" class="field-error">
                {{ $t('pathValidation.insideAppBundleMessage') }}
              </div>
              <div v-else-if="pathIssues.includes('oneDrive')" class="field-error">
                {{ $t('pathValidation.oneDriveMessage') }}
              </div>
              <div v-else-if="pathIssues.includes('insideSharedDir')" class="field-error">
                {{ $t('pathValidation.insideSharedDirMessage') }}
              </div>
              <div v-else-if="pathIssues.includes('insideExistingInstall')" class="field-error">
                {{ $t('pathValidation.insideExistingInstallMessage') }}
              </div>
              <div class="disk-space-info">
                <template v-if="diskSpaceLoading">
                  {{ $t('diskSpace.checking') }}
                </template>
                <template v-else-if="diskSpace">
                  {{ $t('diskSpace.free', { size: formatBytes(diskSpace.free) }) }}
                </template>
              </div>
            </div>
          </template>
        </div>

        <div class="wizard-footer">
          <div class="wizard-back-placeholder"></div>
          <div></div>
          <button
            class="primary quick-install-btn"
            :disabled="!canInstall"
            @click="handleInstall"
          >
            {{ installing ? $t('newInstall.installing') : $t('quickInstall.confirmInstall') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
