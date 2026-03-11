import { toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'
import { useActionGuard } from './useActionGuard'
import { findBestVariant } from '../lib/variants'
import type { Installation, FieldOption } from '../types/ipc'

export interface MigrateActionResult {
  snapshotPath?: string
  enablePipSync: boolean
  target?: {
    mode: 'selected'
    release: FieldOption
    variant: FieldOption
  }
  [key: string]: unknown
}

interface MigrateConfirmOptions {
  title?: string
  message?: string
  confirmLabel?: string
}

/**
 * Composable that encapsulates the full migration confirmation flow:
 * action guard → preview → confirm with variant/device selection → return data.
 *
 * Used by both MigrationBanner (Dashboard) and DetailModal (Installs → Manage)
 * to ensure a single code path for all migration entry points.
 */
export function useMigrateAction() {
  const { t } = useI18n()
  const modal = useModal()
  const actionGuard = useActionGuard()

  /**
   * Run the migration confirmation flow for an installation.
   * Returns the data payload to pass to `runAction`, or `null` if cancelled.
   */
  async function confirmMigration(
    installation: Installation,
    confirm?: MigrateConfirmOptions,
  ): Promise<MigrateActionResult | null> {
    // Pre-flight: check if the installation is busy or running
    if (!await actionGuard.checkBeforeAction(installation.id, t('migrate.migrateToStandalone'))) {
      return null
    }

    const isDesktop = installation.sourceId === 'desktop'
    const migrateItems = isDesktop
      ? [
          t('desktop.copyUserData'),
          t('desktop.copyInput'),
          t('desktop.copyOutput'),
          t('desktop.addModels'),
        ]
      : [
          t('migrate.mergeUserData'),
          t('migrate.mergeInput'),
          t('migrate.mergeOutput'),
          t('migrate.addModels'),
        ]

    // Show the modal immediately with a loading indicator
    const confirmPromise = modal.confirm({
      title: confirm?.title || t('migrate.migrateToStandaloneConfirmTitle'),
      message: confirm?.message || '',
      loading: true,
      confirmLabel: confirm?.confirmLabel || t('migrate.migrateToStandaloneConfirm'),
      confirmStyle: 'primary',
    })

    // Fetch the preview in the background
    let previewResult: Awaited<ReturnType<typeof window.api.previewDesktopMigration>>
    try {
      previewResult = isDesktop
        ? await window.api.previewDesktopMigration()
        : await window.api.previewLocalMigration(installation.id)
    } catch (err) {
      modal.close(false)
      await modal.alert({
        title: t('migrate.migrateToStandalone'),
        message: (err as Error)?.message ?? String(err),
      })
      return null
    }
    if (!previewResult.ok) {
      modal.close(false)
      if (previewResult.message) {
        await modal.alert({ title: t('migrate.migrateToStandalone'), message: previewResult.message })
      }
      return null
    }

    // Update the modal with the loaded preview data + start loading variant options
    modal.updateConfirm({
      loading: false,
      snapshotPreview: previewResult.preview?.newestSnapshot,
      variantLoading: true,
      messageDetails: [{
        label: t('migrate.migrationWill'),
        items: migrateItems,
      }],
      checkboxes: isDesktop ? [] : [
        { id: 'enablePipSync', label: t('migrate.enablePipSync'), checked: false },
      ],
    })

    // Fetch release + variant options for device selection
    let migrateRelease: FieldOption | null = null
    try {
      const releaseOptions = await window.api.getFieldOptions('standalone', 'release', {})
      migrateRelease = releaseOptions[0] || null
      if (migrateRelease) {
        const variantOptions = await window.api.getFieldOptions('standalone', 'variant', { release: toRaw(migrateRelease) })
        const snapshotVariantId = previewResult.preview?.newestSnapshot.comfyui.variant || ''
        const defaultVariant = findBestVariant(variantOptions, snapshotVariantId)

        modal.updateConfirm({
          variantCards: variantOptions,
          selectedVariant: defaultVariant,
          variantLoading: false,
        })
      } else {
        modal.updateConfirm({ variantLoading: false })
      }
    } catch {
      modal.updateConfirm({ variantLoading: false })
    }

    const confirmed = await confirmPromise
    if (!confirmed) return null
    const checkboxValues = modal.getLastCheckboxValues()

    const selectedVariant = modal.state.selectedVariant
    const result: MigrateActionResult = {
      snapshotPath: previewResult.snapshotPath,
      enablePipSync: !!checkboxValues.enablePipSync,
    }
    if (selectedVariant && migrateRelease) {
      result.target = {
        mode: 'selected',
        release: toRaw(migrateRelease),
        variant: toRaw(selectedVariant),
      }
    }

    return result
  }

  return { confirmMigration }
}
