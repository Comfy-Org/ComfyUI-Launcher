import fs from 'fs'
import path from 'path'
import { fetchJSON } from '../../lib/fetch'
import { parseArgs, extractPort } from '../../lib/util'
import { t } from '../../lib/i18n'
import { launchAction } from '../../lib/actions'
import {
  PLATFORM_PREFIX, DEFAULT_LAUNCH_ARGS,
  getVariantLabel, stripPlatform, getActivePythonPath,
  getVenvDir, recommendVariant,
} from './envPaths'
import { install, postInstall, probeInstallation } from './install'
import { getListPreview, getStatusTag, getDetailSections, RELEASE_REPO } from './updateSections'
import { handleAction } from './actions'
import type { InstallationRecord } from '../../installations'
import type {
  SourcePlugin,
  FieldOption,
  LaunchCommand,
} from '../../types/sources'

export { getVariantLabel } from './envPaths'

// --- GitHub API response types ---

interface GitHubAsset {
  name: string
  browser_download_url: string
  size: number
}

interface GitHubRelease {
  id: number
  tag_name: string
  name: string | null
  assets: GitHubAsset[]
}

interface ManifestEntry {
  id: string
  comfyui_ref: string
  python_version: string
  files?: string[]
}

interface VariantData {
  variantId: string
  manifest: ManifestEntry
  downloadUrl: string
  downloadFiles: { url: string; filename: string; size: number }[]
}

export const standalone: SourcePlugin = {
  id: 'standalone',
  get label() { return t('standalone.label') },
  get description() { return t('standalone.desc') },
  category: 'local',

  get fields() {
    return [
      { id: 'release', label: t('common.release'), type: 'select' as const },
      { id: 'variant', label: t('standalone.variant'), type: 'select' as const, renderAs: 'cards' as const },
    ]
  },

  defaultLaunchArgs: DEFAULT_LAUNCH_ARGS,

  get installSteps() {
    return [
      { phase: 'download', label: t('common.download') },
      { phase: 'extract', label: t('common.extract') },
      { phase: 'setup', label: t('standalone.setupEnv') },
      { phase: 'cleanup', label: t('standalone.cleanupEnv') },
      { phase: 'update', label: t('standalone.updateToStable') },
    ]
  },

  getDefaults() {
    return { launchArgs: DEFAULT_LAUNCH_ARGS, launchMode: 'window', portConflict: 'auto' }
  },

  getListPreview,
  getStatusTag,
  getDetailSections,

  buildInstallation(selections: Record<string, FieldOption | undefined>): Record<string, unknown> {
    const vd = selections.variant?.data as VariantData | undefined
    const manifest = vd?.manifest
    const variantId = vd?.variantId || ''
    const isCpu = stripPlatform(variantId) === 'cpu' || stripPlatform(variantId).startsWith('cpu-')
    const isLatest = selections.release?.value === 'latest'
    // For "Latest version", use the underlying release's tag_name
    const releaseData = selections.release?.data as unknown as GitHubRelease | undefined
    const releaseTag = isLatest ? (releaseData?.tag_name || 'unknown') : (selections.release?.value || 'unknown')
    return {
      version: manifest?.comfyui_ref || releaseTag,
      releaseTag,
      variant: variantId,
      downloadUrl: vd?.downloadUrl || '',
      downloadFiles: vd?.downloadFiles || [],
      pythonVersion: manifest?.python_version || '',
      launchArgs: isCpu ? `${DEFAULT_LAUNCH_ARGS} --cpu` : DEFAULT_LAUNCH_ARGS,
      launchMode: 'window',
      browserPartition: 'unique',
      ...(isLatest ? { autoUpdateComfyUI: true } : {}),
    }
  },

  getLaunchCommand(installation: InstallationRecord): LaunchCommand | null {
    const pythonPath = getActivePythonPath(installation)
    if (!pythonPath || !fs.existsSync(pythonPath)) return null
    const mainPy = path.join(installation.installPath, 'ComfyUI', 'main.py')
    if (!fs.existsSync(mainPy)) return null
    const userArgs = ((installation.launchArgs as string | undefined) ?? DEFAULT_LAUNCH_ARGS).trim()
    const parsed = userArgs.length > 0 ? parseArgs(userArgs) : []
    const port = extractPort(parsed)
    return {
      cmd: pythonPath,
      args: ['-s', path.join('ComfyUI', 'main.py'), ...parsed],
      cwd: installation.installPath,
      port,
    }
  },

  getListActions(installation: InstallationRecord): Record<string, unknown>[] {
    const installed = installation.status === 'installed'
    return [
      launchAction(installed, !installed ? t('errors.installNotReady') : undefined),
    ]
  },

  install,
  postInstall,
  probeInstallation,
  handleAction,

  async fixupCopy(srcPath: string, destPath: string): Promise<void> {
    const venvPath = getVenvDir(destPath)
    if (!fs.existsSync(venvPath)) return

    const cfgPath = path.join(venvPath, 'pyvenv.cfg')
    if (fs.existsSync(cfgPath)) {
      let content = await fs.promises.readFile(cfgPath, 'utf-8')
      content = content.replaceAll(srcPath, destPath)
      await fs.promises.writeFile(cfgPath, content, 'utf-8')
    }

    if (process.platform !== 'win32') {
      const binDir = path.join(venvPath, 'bin')
      if (fs.existsSync(binDir)) {
        const entries = await fs.promises.readdir(binDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile()) continue
          const filePath = path.join(binDir, entry.name)
          try {
            let content = await fs.promises.readFile(filePath, 'utf-8')
            if (content.startsWith('#!') && content.includes(srcPath)) {
              content = content.replaceAll(srcPath, destPath)
              await fs.promises.writeFile(filePath, content, 'utf-8')
            }
          } catch {}
        }
      }
    }
  },

  async getFieldOptions(fieldId: string, selections: Record<string, FieldOption | undefined>, context: Record<string, unknown>): Promise<FieldOption[]> {
    if (fieldId === 'release') {
      const [releases, latest] = await Promise.all([
        fetchJSON(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`) as Promise<GitHubRelease[]>,
        (fetchJSON(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`) as Promise<GitHubRelease>).catch(() => null),
      ])
      if (latest && !releases.some((r) => r.id === latest.id)) {
        releases.unshift(latest)
      }
      const filtered = releases.filter((r) => r.assets.some((a) => a.name === 'manifests.json'))
      const options: FieldOption[] = []

      // Synthetic "Latest Stable" entry — uses the newest release but auto-updates ComfyUI after install
      if (filtered.length > 0 && context?.includeLatestStable) {
        options.push({
          value: 'latest',
          label: t('standalone.latestVersion'),
          recommended: true,
          data: filtered[0] as unknown as Record<string, unknown>,
        })
      }

      for (const r of filtered) {
        const name = r.name && r.name !== r.tag_name ? `${r.tag_name}  —  ${r.name}` : r.tag_name
        options.push({ value: r.tag_name, label: name, data: r as unknown as Record<string, unknown> })
      }
      return options
    }

    if (fieldId === 'variant') {
      const release = selections.release?.data as unknown as GitHubRelease | undefined
      if (!release) return []
      const prefix = PLATFORM_PREFIX[process.platform]
      if (!prefix) return []

      const manifestAsset = release.assets.find((a) => a.name === 'manifests.json')
      if (!manifestAsset) return []
      const manifests = await fetchJSON(manifestAsset.browser_download_url) as ManifestEntry[]

      const gpu = context?.gpu as string | undefined
      return manifests
        .filter((m) => m.id.startsWith(prefix))
        .map((m): FieldOption | null => {
          const files = m.files || []
          const assets = files
            .map((f) => release.assets.find((a) => a.name === f))
            .filter((a): a is GitHubAsset => a != null)
          if (assets.length === 0) return null
          const totalBytes = assets.reduce((sum, a) => sum + a.size, 0)
          const sizeMB = (totalBytes / 1048576).toFixed(0)
          const downloadFiles = assets.map((a) => ({ url: a.browser_download_url, filename: a.name, size: a.size }))
          const downloadUrl = downloadFiles.length === 1 ? downloadFiles[0]!.url : ''
          return {
            value: downloadFiles.length > 0 ? m.id : '',
            label: getVariantLabel(m.id),
            description: `ComfyUI ${m.comfyui_ref}  ·  Python ${m.python_version}  ·  ${sizeMB} MB`,
            data: { variantId: m.id, manifest: m, downloadFiles, downloadUrl } as unknown as Record<string, unknown>,
            recommended: recommendVariant(m.id, gpu),
          }
        })
        .filter((item): item is FieldOption => item != null)
    }

    return []
  },
}
