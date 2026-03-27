import {
  fs,
  installations, settings, i18n,
  openPath, autoAssignPrimary,
} from '../shared'
import type { ActionContext, ActionResult } from './types'

export async function handleRemove({ installationId }: ActionContext): Promise<ActionResult> {
  await installations.remove(installationId)
  await autoAssignPrimary(installationId)
  const pinned = (settings.get('pinnedInstallIds') as string[] | undefined) ?? []
  if (pinned.includes(installationId)) {
    settings.set('pinnedInstallIds', pinned.filter((id) => id !== installationId))
  }
  return { ok: true, navigate: 'list' }
}

export async function handleSetPrimaryInstall({ installationId, inst }: ActionContext): Promise<ActionResult> {
  if (inst.sourceId === 'desktop') {
    return { ok: false, message: 'Desktop installations cannot be set as primary.' }
  }
  settings.set('primaryInstallId', installationId)
  return { ok: true }
}

export function handlePinInstall({ installationId }: ActionContext): ActionResult {
  const pinned = (settings.get('pinnedInstallIds') as string[] | undefined) ?? []
  if (!pinned.includes(installationId)) {
    settings.set('pinnedInstallIds', [...pinned, installationId])
  }
  return { ok: true }
}

export function handleUnpinInstall({ installationId }: ActionContext): ActionResult {
  const pinned = (settings.get('pinnedInstallIds') as string[] | undefined) ?? []
  settings.set('pinnedInstallIds', pinned.filter((id) => id !== installationId))
  return { ok: true }
}

export async function handleOpenFolder({ inst }: ActionContext): Promise<ActionResult> {
  if (inst.installPath) {
    if (fs.existsSync(inst.installPath)) {
      const err = await openPath(inst.installPath)
      if (err) return { ok: false, message: i18n.t('errors.cannotOpenDir', { error: err }) }
    } else {
      return { ok: false, message: i18n.t('errors.dirNotExist', { path: inst.installPath }) }
    }
  }
  return { ok: true }
}
