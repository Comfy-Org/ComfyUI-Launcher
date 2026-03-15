import * as releaseCache from './release-cache'
import { formatComfyVersion } from './version'
import type { ComfyVersion } from './version'
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
  const cv = installation.comfyVersion as ComfyVersion | undefined
  return channelDefs.map((def) => {
    const info = releaseCache.getEffectiveInfo(repo, def.value, installation)
    // When the latest release commit matches the installed commit, reuse
    // the git-resolved version (which is cherry-pick–aware) instead of the
    // raw GitHub API comparison data.
    const latestCv = info?.commitSha
      ? (cv && cv.commit === info.commitSha && cv.baseTag
        ? cv
        : { commit: info.commitSha, baseTag: info.baseTag, commitsAhead: info.commitsAhead } as ComfyVersion)
      : undefined
    return {
      ...def,
      data: info ? {
        installedVersion: cv ? formatComfyVersion(cv, 'detail') : (info.installedTag || 'unknown'),
        latestVersion: latestCv ? formatComfyVersion(latestCv, 'detail') : (info.releaseName || info.latestTag || '—'),
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
