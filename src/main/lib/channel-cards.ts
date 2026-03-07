import * as releaseCache from './release-cache'
import type { InstallationRecord } from '../installations'

export interface ChannelDef {
  value: string
  label: string
  description: string
  recommended?: boolean
}

export interface ChannelCardData {
  installedVersion: string
  latestVersion: string
  lastChecked: string
  updateAvailable: boolean
  actions?: Record<string, unknown>[]
}

export interface ChannelCard extends ChannelDef {
  data?: ChannelCardData
}

/**
 * Build the data portion of channel cards (installed/latest versions, update status).
 * Callers supply their own actions per card after calling this.
 */
export function buildChannelCards(
  repo: string,
  channelDefs: ChannelDef[],
  installation: InstallationRecord,
): ChannelCard[] {
  return channelDefs.map((def) => {
    const info = releaseCache.getEffectiveInfo(repo, def.value, installation)
    return {
      ...def,
      data: info ? {
        installedVersion: (installation.version as string | undefined) || info.installedTag || 'unknown',
        latestVersion: info.releaseName || info.latestTag || '—',
        lastChecked: info.checkedAt ? new Date(info.checkedAt).toLocaleString() : '—',
        updateAvailable: releaseCache.isUpdateAvailable(installation, def.value, info),
      } : undefined,
    }
  })
}

/** Build a label lookup map from channel defs. */
export function buildChannelLabelMap(defs: ChannelDef[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const def of defs) map[def.value] = def.label
  return map
}
