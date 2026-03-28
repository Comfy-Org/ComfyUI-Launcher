import fs from 'fs'
import path from 'path'
import * as releaseCache from '../../lib/release-cache'
import { buildChannelCards, buildChannelLabelMap } from '../../lib/channel-cards'
import type { ChannelDef } from '../../lib/channel-cards'
import { formatComfyVersion } from '../../lib/version'
import type { ComfyVersion } from '../../lib/version'
import { truncateNotes } from '../../lib/comfyui-releases'
import { deleteAction, untrackAction, launchAction, openFolderAction } from '../../lib/actions'
import { t } from '../../lib/i18n'
import { buildLaunchSettingsFields } from '../common/launchSettingsFields'
import { getVariantLabel, DEFAULT_LAUNCH_ARGS } from './envPaths'
import type { InstallationRecord } from '../../installations'
import type { StatusTag } from '../../types/sources'

export const COMFYUI_REPO = 'Comfy-Org/ComfyUI'
export const RELEASE_REPO = 'Comfy-Org/ComfyUI-Standalone-Environments'

function getChannelDefs(): ChannelDef[] {
  return [
    { value: 'stable', label: t('standalone.channelStable'), description: t('standalone.channelStableDesc'), recommended: true },
    { value: 'latest', label: t('standalone.channelLatest'), description: t('standalone.channelLatestDesc') },
  ]
}

export function getChannelLabel(channel: string): string {
  const map = buildChannelLabelMap(getChannelDefs())
  return map[channel] || channel
}

export function getListPreview(installation: InstallationRecord): string | null {
  const channel = (installation.updateChannel as string | undefined) || 'stable'
  return getChannelLabel(channel)
}

export function getStatusTag(installation: InstallationRecord): StatusTag | undefined {
  const channel = (installation.updateChannel as string | undefined) || 'stable'
  const info = releaseCache.getEffectiveInfo(COMFYUI_REPO, channel, installation)
  if (info && releaseCache.isUpdateAvailable(installation, channel, info)) {
    return { label: t('standalone.updateAvailableTag', { version: info.releaseName || info.latestTag || '' }), style: 'update' }
  }
  return undefined
}

export function getDetailSections(installation: InstallationRecord): Record<string, unknown>[] {
  const installed = installation.status === 'installed'

  const infoFields: Record<string, unknown>[] = [
    { label: t('common.installMethod'), value: installation.sourceLabel as string },
    { key: 'comfyui-version', label: t('standalone.comfyui'), value: installation.comfyVersion ? formatComfyVersion(installation.comfyVersion as ComfyVersion, 'detail') : (installation.version as string | undefined) || 'unknown' },
    { label: t('common.release'), value: (installation.releaseTag as string | undefined) || '—' },
    { label: t('standalone.variant'), value: (installation.variant as string | undefined) ? getVariantLabel(installation.variant as string) : '—' },
    { label: t('standalone.python'), value: (installation.pythonVersion as string | undefined) || '—' },
    { label: t('common.location'), value: installation.installPath || '—' },
    { label: t('common.installed'), value: new Date(installation.createdAt).toLocaleDateString() },
  ]

  const copiedFrom = installation.copiedFrom as string | undefined
  if (copiedFrom) {
    const copiedFromName = installation.copiedFromName as string | undefined
    const copiedAt = installation.copiedAt as string | undefined
    const copyReason = installation.copyReason as string | undefined
    const reasonLabel = copyReason === 'copy-update' ? t('standalone.lineageCopyUpdate')
      : copyReason === 'release-update' ? t('standalone.lineageReleaseUpdate')
      : t('standalone.lineageCopy')
    const dateStr = copiedAt ? new Date(copiedAt).toLocaleString() : ''
    const nameStr = copiedFromName || copiedFrom
    infoFields.push({
      label: t('standalone.lineage'),
      value: dateStr
        ? `${reasonLabel}: ${nameStr}  ·  ${dateStr}`
        : `${reasonLabel}: ${nameStr}`,
    })
  }

  const sections: Record<string, unknown>[] = [
    {
      tab: 'status',
      title: t('common.installInfo'),
      fields: infoFields,
    },
  ]

  // Snapshot tab — minimal section so the tab appears; SnapshotTab.vue handles rendering
  if (installed && installation.installPath) {
    sections.push({
      tab: 'snapshots',
      title: t('standalone.snapshotHistory'),
    })
  }

  // Updates section
  const hasGit = installed && installation.installPath && fs.existsSync(path.join(installation.installPath, 'ComfyUI', '.git'))
  const channel = (installation.updateChannel as string | undefined) || 'stable'

  // Build per-channel preview info and actions for cards
  const channelDefs = getChannelDefs()
  const baseCards = buildChannelCards(COMFYUI_REPO, channelDefs, installation)

  const channelOptions = baseCards.map((card) => {
    const actions: Record<string, unknown>[] = []
    if (card.data?.updateAvailable && hasGit) {
      const channelInfo = releaseCache.getEffectiveInfo(COMFYUI_REPO, card.value, installation)!
      const cv = installation.comfyVersion as ComfyVersion | undefined
      const installedDisplay = cv ? formatComfyVersion(cv, 'detail') : (channelInfo.installedTag || 'unknown')
      const latestCv = channelInfo.commitSha
        ? { commit: channelInfo.commitSha, baseTag: channelInfo.baseTag, commitsAhead: channelInfo.commitsAhead } as ComfyVersion
        : undefined
      const latestDisplay = latestCv ? formatComfyVersion(latestCv, 'detail') : (channelInfo.releaseName || channelInfo.latestTag || '—')
      const isSwitching = card.value !== channel
      const isDowngrade = card.value === 'stable' && cv ? (cv.commitsAhead === undefined ? !!cv.baseTag : cv.commitsAhead > 0) : false
      const msgKey = isDowngrade ? 'standalone.updateConfirmMessageDowngrade'
        : card.value === 'latest' ? 'standalone.updateConfirmMessageLatest'
        : 'standalone.updateConfirmMessage'
      const notes = truncateNotes(channelInfo.releaseNotes || '', 2000)
      const notesDetails = notes ? [{ label: t('standalone.releaseNotesLabel'), items: [notes] }] : undefined
      const switchPrefix = isSwitching
        ? t('channelCards.switchChannelPrefix', { from: `**${getChannelLabel(channel)}**`, to: `**${card.label}**` })
        : ''
      const boldInstalled = `**${installedDisplay}**`
      const boldLatest = `**${latestDisplay}**`
      const confirmMessage = t(msgKey, {
        installed: boldInstalled,
        latest: boldLatest,
      })
      actions.push({
        id: 'update-comfyui', label: t('standalone.updateNow'), style: 'primary', enabled: installed,
        tooltip: t('tooltips.updateNow'),
        showProgress: true, progressTitle: t('standalone.updatingTitle', { version: latestDisplay }),
        data: isSwitching ? { channel: card.value } : undefined,
        confirm: {
          title: t('standalone.updateConfirmTitle'),
          message: switchPrefix + confirmMessage,
          messageDetails: notesDetails,
        },
      })
      actions.push({
        id: 'copy-update', label: t('standalone.copyAndUpdate'), style: 'default', enabled: installed,
        tooltip: t('tooltips.copyAndUpdate'),
        showProgress: true, progressTitle: t('standalone.copyUpdatingTitle', { version: latestDisplay }),
        cancellable: true,
        data: isSwitching ? { channel: card.value } : undefined,
        prompt: {
          title: t('standalone.copyAndUpdateTitle'),
          message: (isSwitching ? switchPrefix : '') + t('standalone.copyAndUpdateMessage', { installed: boldInstalled, latest: boldLatest }),
          placeholder: t('standalone.copyAndUpdatePlaceholder'),
          defaultValue: `${installation.name} (${latestDisplay})`,
          confirmLabel: t('standalone.copyAndUpdateConfirm'),
          required: true,
          field: 'name',
          messageDetails: notesDetails,
        },
      })
    } else if (card.value !== channel && hasGit) {
      actions.push({
        id: 'switch-channel', label: t('channelCards.switchChannelOnly'), style: 'default', enabled: installed,
        data: { channel: card.value },
      })
    }
    return { ...card, data: card.data ? { ...card.data, actions: actions.length ? actions : undefined } : undefined }
  })

  const updateFields: Record<string, unknown>[] = [
    { id: 'updateChannel', label: t('standalone.updateChannel'), value: channel, editable: true,
      refreshSection: true, onChangeAction: 'check-update', editType: 'channel-cards', options: channelOptions, tooltip: t('tooltips.updateChannel') },
  ]
  const updateActions: Record<string, unknown>[] = [
    { id: 'check-update', label: t('actions.checkForUpdate'), style: 'default', enabled: installed },
  ]
  sections.push({
    tab: 'update',
    title: t('standalone.updates'),
    fields: updateFields,
    actions: updateActions,
  })

  sections.push(
    {
      tab: 'settings',
      title: t('common.launchSettings'),
      fields: buildLaunchSettingsFields(installation, { defaultLaunchArgs: DEFAULT_LAUNCH_ARGS }),
    },
    {
      title: 'Actions',
      pinBottom: true,
      actions: [
        launchAction(installed, !installed ? t('errors.installNotReady') : undefined),
        { id: 'copy', label: t('actions.copyInstallation'), style: 'default', enabled: installed,
          showProgress: true, progressTitle: t('actions.copyingInstallation'), cancellable: true,
          prompt: {
            title: t('actions.copyInstallationTitle'),
            message: t('actions.copyInstallationMessage'),
            defaultValue: `${installation.name} (Copy)`,
            confirmLabel: t('actions.copyInstallationConfirm'),
            required: true,
            field: 'name',
          } },
        openFolderAction(installation.installPath),
        deleteAction(installation),
        untrackAction(),
      ],
    },
  )

  return sections
}
