import path from 'path'
import fs from 'fs'
import { detectGPU } from './gpu'
import { mergeDirFlat } from './migrate'
import { download } from './download'
import { createCache } from './cache'
import { extractNested as extract } from './extract'
import { defaultInstallDir } from './paths'
import {
  validateExportEnvelope, importSnapshots,
  saveSnapshot, getSnapshotCount, restoreCustomNodes, restorePipPackages,
} from './snapshots'
import * as installations from '../installations'
import type { InstallationRecord } from '../installations'
import * as settings from '../settings'
import * as i18n from './i18n'
import type { SourcePlugin, FieldOption } from '../types/sources'

const MARKER_FILE = '.comfyui-desktop-2'

export interface MigrationTools {
  sendProgress: (phase: string, detail: Record<string, unknown>) => void
  sendOutput: (text: string) => void
  signal: AbortSignal
  sourceMap: Record<string, SourcePlugin>
  uniqueName: (baseName: string) => Promise<string>
  ensureDefaultPrimary: (entry: InstallationRecord) => void
}

export interface SharedMigrationInput {
  installNameBase: string
  stagedSnapshot: {
    path: string
    owned: boolean
  }
  sourcePaths: {
    userDir?: string
    inputDir?: string
    outputDir?: string
    modelsDir?: string
  }
  labels: {
    userData: string
    input: string
    output: string
    models: string
  }
  target?: StandaloneTargetSelection
}

export type StandaloneTargetSelection =
  | { mode: 'auto' }
  | { mode: 'selected'; release: FieldOption; variant: FieldOption }

/**
 * Emit the standard migration step list for the progress UI.
 */
export function sendMigrationSteps(
  sendProgress: MigrationTools['sendProgress'],
  opts: { includeScan: boolean; scanLabel: string; dataPhaseLabel: string },
): void {
  sendProgress('steps', { steps: [
    ...(opts.includeScan ? [{ phase: 'scan', label: opts.scanLabel }] : []),
    { phase: 'download', label: i18n.t('common.download') },
    { phase: 'extract', label: i18n.t('common.extract') },
    { phase: 'setup', label: i18n.t('standalone.setupEnv') },
    { phase: 'restore-nodes', label: i18n.t('standalone.snapshotRestoreNodesPhase') },
    { phase: 'migrate', label: opts.dataPhaseLabel },
  ] })
}

/**
 * Resolve the standalone release + variant, either from explicit selection
 * or by auto-detecting the GPU.
 */
async function resolveStandaloneInstallData(
  target: StandaloneTargetSelection | undefined,
  sourceMap: Record<string, SourcePlugin>,
  cleanupOnError: () => void,
): Promise<{ instData: Record<string, unknown>; standaloneSource: SourcePlugin }> {
  const standaloneSource = sourceMap['standalone']!

  let release: FieldOption
  let variant: FieldOption

  if (target?.mode === 'selected') {
    release = target.release
    variant = target.variant
  } else {
    const releaseOptions = await standaloneSource.getFieldOptions('release', {}, {})
    if (releaseOptions.length === 0) {
      cleanupOnError()
      throw new Error('No releases available.')
    }
    release = releaseOptions[0]!

    const gpu = await detectGPU()
    const variantOptions = await standaloneSource.getFieldOptions('variant', { release }, { gpu: gpu?.id })
    if (variantOptions.length === 0) {
      cleanupOnError()
      throw new Error('No compatible variants found for this platform.')
    }
    variant = variantOptions.find((v) => v.recommended) || variantOptions[0]!
  }

  const instData = {
    sourceId: 'standalone',
    sourceLabel: standaloneSource.label,
    ...standaloneSource.buildInstallation({ release, variant }),
  }

  return { instData, standaloneSource }
}

/**
 * Restore a snapshot (custom nodes + pip packages) into a freshly installed
 * standalone installation.
 */
async function restoreSnapshotIntoInstallation(
  entry: InstallationRecord,
  stagedFile: string,
  ownsStagedFile: boolean,
  tools: MigrationTools,
  update: (data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const { sendProgress, sendOutput, signal } = tools
  const freshInst = await installations.get(entry.id)
  if (!freshInst || !fs.existsSync(stagedFile)) return

  try {
    const fileContent = await fs.promises.readFile(stagedFile, 'utf-8')
    const importEnvelope = validateExportEnvelope(JSON.parse(fileContent))
    await importSnapshots(freshInst.installPath, importEnvelope)
    const targetSnapshot = importEnvelope.snapshots[0]!
    const pypiMirror = settings.get('pypiMirror')

    sendOutput('\n── Restore Nodes ──\n')
    await restoreCustomNodes(freshInst.installPath, freshInst, targetSnapshot, sendProgress, sendOutput, signal, pypiMirror)

    if (!signal.aborted && !targetSnapshot.skipPipSync) {
      sendOutput('\n── Restore Packages ──\n')
      await restorePipPackages(freshInst.installPath, freshInst, targetSnapshot,
        (phase, data) => sendProgress(phase === 'restore' ? 'restore-pip' : phase, data),
        sendOutput, signal, pypiMirror)
    }

    try {
      const snapFilename = await saveSnapshot(freshInst.installPath, freshInst, 'post-restore')
      const snapshotCount = await getSnapshotCount(freshInst.installPath)
      await update({ lastSnapshot: snapFilename, snapshotCount })
    } catch {}
  } catch (restoreErr) {
    sendOutput(`\n⚠ Snapshot restore failed: ${(restoreErr as Error).message}\nYou can restore manually from the Snapshots tab.\n`)
  } finally {
    if (ownsStagedFile) fs.promises.unlink(stagedFile).catch(() => {})
    await update({ pendingSnapshotRestore: undefined })
  }
}

/**
 * Copy user data, input, output and add models to shared paths.
 */
async function copyMigrationData(
  sourcePaths: SharedMigrationInput['sourcePaths'],
  destComfyUIDir: string,
  labels: SharedMigrationInput['labels'],
  sendProgress: MigrationTools['sendProgress'],
): Promise<void> {
  // User data
  if (sourcePaths.userDir && fs.existsSync(sourcePaths.userDir)) {
    sendProgress('migrate', { percent: 0, status: labels.userData })
    const dstUserDir = path.join(destComfyUIDir, 'user')
    await mergeDirFlat(sourcePaths.userDir, dstUserDir, (copied, skipped, fileTotal) => {
      const pct = fileTotal > 0 ? Math.round(((copied + skipped) / fileTotal) * 30) : 30
      sendProgress('migrate', { percent: pct, status: labels.userData })
    })
  }

  // Input
  if (sourcePaths.inputDir && fs.existsSync(sourcePaths.inputDir)) {
    const dstInput = (settings.get('inputDir') as string | undefined) || settings.defaults.inputDir
    sendProgress('migrate', { percent: 40, status: labels.input })
    await mergeDirFlat(sourcePaths.inputDir, dstInput)
  }

  // Output
  if (sourcePaths.outputDir && fs.existsSync(sourcePaths.outputDir)) {
    const dstOutput = (settings.get('outputDir') as string | undefined) || settings.defaults.outputDir
    sendProgress('migrate', { percent: 60, status: labels.output })
    await mergeDirFlat(sourcePaths.outputDir, dstOutput)
  }

  // Models — add to shared paths, no copy
  if (sourcePaths.modelsDir) {
    sendProgress('migrate', { percent: 90, status: labels.models })
    const resolved = path.resolve(sourcePaths.modelsDir)
    const currentModelsDirs = (settings.get('modelsDirs') as string[] | undefined) || [...settings.defaults.modelsDirs]
    const normalizedCurrent = currentModelsDirs.map((d) => path.resolve(d))
    if (fs.existsSync(resolved) && !normalizedCurrent.includes(resolved)) {
      currentModelsDirs.push(resolved)
      settings.set('modelsDirs', currentModelsDirs)
    }
  }

  sendProgress('migrate', { percent: 100, status: i18n.t('common.done') })
}

/**
 * Shared migration flow: create a new standalone installation from a staged
 * snapshot, restore it, and copy user data from the source.
 */
export async function migrateToStandaloneFromSnapshot(
  input: SharedMigrationInput,
  tools: MigrationTools,
): Promise<{ entry: InstallationRecord; destPath: string }> {
  const { sendProgress, signal, uniqueName, ensureDefaultPrimary } = tools
  const { stagedSnapshot, sourcePaths, labels, target } = input

  const cleanupStagedFile = (): void => {
    if (stagedSnapshot.owned) fs.promises.unlink(stagedSnapshot.path).catch(() => {})
  }

  // 1. Resolve release/variant
  const { instData, standaloneSource } = await resolveStandaloneInstallData(target, tools.sourceMap, cleanupStagedFile)

  // 2. Create new standalone installation record
  const name = await uniqueName(input.installNameBase)
  const dirName = name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'ComfyUI'
  const installDir = defaultInstallDir()
  let destPath = path.join(installDir, dirName)
  let suffix = 1
  while (fs.existsSync(destPath)) {
    destPath = path.join(installDir, `${dirName} (${suffix})`)
    suffix++
  }

  const entry = await installations.add({
    name,
    installPath: destPath,
    pendingSnapshotRestore: stagedSnapshot.path,
    ...instData,
    status: 'installing',
    seen: false,
  })
  ensureDefaultPrimary(entry)

  // 3. Install standalone (download + extract + setup env)
  fs.mkdirSync(destPath, { recursive: true })
  fs.writeFileSync(path.join(destPath, MARKER_FILE), entry.id)
  const cache = createCache(settings.get('cacheDir') as string, settings.get('maxCachedFiles') as number)
  const installRecord = { ...instData, installPath: destPath } as unknown as InstallationRecord
  await standaloneSource.install!(installRecord, { sendProgress, download, cache, extract, signal })

  const update = (data: Record<string, unknown>): Promise<void> =>
    installations.update(entry.id, data).then(() => {})
  await standaloneSource.postInstall!(installRecord, { sendProgress, update })

  // 4. Restore snapshot (custom nodes + pip packages)
  await restoreSnapshotIntoInstallation(entry, stagedSnapshot.path, stagedSnapshot.owned, tools, update)

  // 5. Copy user data, input, output, models
  const dstComfyUI = path.join(destPath, 'ComfyUI')
  await copyMigrationData(sourcePaths, dstComfyUI, labels, sendProgress)

  await installations.update(entry.id, { status: 'installed' })

  return { entry, destPath }
}
