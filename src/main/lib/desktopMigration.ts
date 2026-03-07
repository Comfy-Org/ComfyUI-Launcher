import path from 'path'
import fs from 'fs'
import { detectDesktopInstall, stageDesktopSnapshot } from './desktopDetect'
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
import type { SourcePlugin } from '../types/sources'

const MARKER_FILE = '.comfyui-launcher'

export interface MigrationTools {
  sendProgress: (phase: string, detail: Record<string, unknown>) => void
  sendOutput: (text: string) => void
  signal: AbortSignal
  sourceMap: Record<string, SourcePlugin>
  uniqueName: (baseName: string) => Promise<string>
  ensureDefaultPrimary: (entry: InstallationRecord) => void
}

export async function performDesktopMigration(
  actionData: Record<string, unknown> | undefined,
  tools: MigrationTools
): Promise<{ entry: InstallationRecord; destPath: string }> {
  const { sendProgress, sendOutput, signal, sourceMap, uniqueName, ensureDefaultPrimary } = tools

  const desktopInfo = detectDesktopInstall()
  if (!desktopInfo) {
    throw new Error(i18n.t('desktop.notFound'))
  }

  sendProgress('steps', { steps: [
    ...(!actionData?.snapshotPath ? [{ phase: 'scan', label: i18n.t('desktop.scanningDesktop') }] : []),
    { phase: 'download', label: i18n.t('common.download') },
    { phase: 'extract', label: i18n.t('common.extract') },
    { phase: 'setup', label: i18n.t('standalone.setupEnv') },
    { phase: 'restore-nodes', label: i18n.t('standalone.snapshotRestoreNodesPhase') },
    { phase: 'migrate', label: i18n.t('desktop.copyingUserData') },
  ] })

  // 1. Prepare snapshot (use pre-staged file or scan live)
  let stagedFile: string
  // Track whether we created the staged file so we can clean it up on failure
  let ownsStagedFile = false
  if (actionData?.snapshotPath && typeof actionData.snapshotPath === 'string' && fs.existsSync(actionData.snapshotPath)) {
    stagedFile = actionData.snapshotPath
  } else {
    sendProgress('scan', { percent: 0, status: i18n.t('desktop.scanningDesktop') })
    sendProgress('scan', { percent: 30, status: i18n.t('desktop.creatingSnapshot') })
    const staged = await stageDesktopSnapshot(desktopInfo)
    stagedFile = staged.stagedFile
    ownsStagedFile = true
    sendProgress('scan', { percent: 100, status: i18n.t('common.done') })
  }

  const cleanupStagedFile = (): void => {
    if (ownsStagedFile) fs.promises.unlink(stagedFile).catch(() => {})
  }

  // 2. Auto-detect GPU and pick release/variant
  const standaloneSource = sourceMap['standalone']!
  const releaseOptions = await standaloneSource.getFieldOptions('release', {}, {})
  if (releaseOptions.length === 0) {
    cleanupStagedFile()
    throw new Error('No releases available.')
  }
  const latestRelease = releaseOptions[0]!

  const gpu = await detectGPU()
  const variantOptions = await standaloneSource.getFieldOptions('variant', { release: latestRelease }, { gpu: gpu?.id })
  if (variantOptions.length === 0) {
    cleanupStagedFile()
    throw new Error('No compatible variants found for this platform.')
  }
  const matched = variantOptions.find((v) => v.recommended) || variantOptions[0]!

  const instData = {
    sourceId: 'standalone',
    sourceLabel: standaloneSource.label,
    ...standaloneSource.buildInstallation({ release: latestRelease, variant: matched }),
  }

  // 3. Create new standalone installation
  const baseName = 'ComfyUI (from Desktop)'
  const name = await uniqueName(baseName)
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
    pendingSnapshotRestore: stagedFile,
    ...instData,
    seen: false,
  })
  ensureDefaultPrimary(entry)

  // 4. Install standalone (download + extract + setup env)
  fs.mkdirSync(destPath, { recursive: true })
  fs.writeFileSync(path.join(destPath, MARKER_FILE), entry.id)
  const cache = createCache(settings.get('cacheDir') as string, settings.get('maxCachedFiles') as number)
  const installRecord = { ...instData, installPath: destPath } as unknown as InstallationRecord
  await standaloneSource.install!(installRecord, { sendProgress, download, cache, extract, signal })

  const update = (data: Record<string, unknown>): Promise<void> =>
    installations.update(entry.id, data).then(() => {})
  await standaloneSource.postInstall!(installRecord, { sendProgress, update })

  // 5. Restore snapshot (custom nodes + pip packages)
  const freshInst = await installations.get(entry.id)
  if (freshInst && fs.existsSync(stagedFile)) {
    try {
      const fileContent = await fs.promises.readFile(stagedFile, 'utf-8')
      const importEnvelope = validateExportEnvelope(JSON.parse(fileContent))
      await importSnapshots(freshInst.installPath, importEnvelope)
      const targetSnapshot = importEnvelope.snapshots[0]!

      sendOutput('\n── Restore Nodes ──\n')
      await restoreCustomNodes(freshInst.installPath, freshInst, targetSnapshot, sendProgress, sendOutput, signal)

      if (!signal.aborted && !targetSnapshot.skipPipSync) {
        sendOutput('\n── Restore Packages ──\n')
        await restorePipPackages(freshInst.installPath, freshInst, targetSnapshot,
          (phase, data) => sendProgress(phase === 'restore' ? 'restore-pip' : phase, data),
          sendOutput, signal)
      }

      try {
        const snapFilename = await saveSnapshot(freshInst.installPath, freshInst, 'post-restore')
        const snapshotCount = await getSnapshotCount(freshInst.installPath)
        await update({ lastSnapshot: snapFilename, snapshotCount })
      } catch {}
    } catch (restoreErr) {
      sendOutput(`\n⚠ Snapshot restore failed: ${(restoreErr as Error).message}\nYou can restore manually from the Snapshots tab.\n`)
    } finally {
      cleanupStagedFile()
      await update({ pendingSnapshotRestore: undefined })
    }
  }

  // 6. Copy user data (workflows + settings)
  sendProgress('migrate', { percent: 0, status: i18n.t('desktop.copyingUserData') })
  const srcUserDir = path.join(desktopInfo.basePath, 'user')
  const dstComfyUI = path.join(destPath, 'ComfyUI')
  if (fs.existsSync(srcUserDir)) {
    const dstUserDir = path.join(dstComfyUI, 'user')
    await mergeDirFlat(srcUserDir, dstUserDir, (copied, skipped, fileTotal) => {
      const pct = fileTotal > 0 ? Math.round(((copied + skipped) / fileTotal) * 30) : 30
      sendProgress('migrate', { percent: pct, status: i18n.t('desktop.copyingUserData') })
    })
  }

  // 7. Copy input/output to shared directories
  const srcInput = path.join(desktopInfo.basePath, 'input')
  const dstInput = (settings.get('inputDir') as string | undefined) || settings.defaults.inputDir
  if (fs.existsSync(srcInput)) {
    sendProgress('migrate', { percent: 40, status: i18n.t('desktop.copyingInput') })
    await mergeDirFlat(srcInput, dstInput)
  }

  const srcOutput = path.join(desktopInfo.basePath, 'output')
  const dstOutput = (settings.get('outputDir') as string | undefined) || settings.defaults.outputDir
  if (fs.existsSync(srcOutput)) {
    sendProgress('migrate', { percent: 60, status: i18n.t('desktop.copyingOutput') })
    await mergeDirFlat(srcOutput, dstOutput)
  }

  // 8. Add Desktop's models dir to shared paths (no copy)
  sendProgress('migrate', { percent: 90, status: i18n.t('desktop.addingModels') })
  const desktopModelsDir = path.resolve(path.join(desktopInfo.basePath, 'models'))
  const currentModelsDirs = (settings.get('modelsDirs') as string[] | undefined) || [...settings.defaults.modelsDirs]
  const normalizedCurrent = currentModelsDirs.map((d) => path.resolve(d))
  if (fs.existsSync(desktopModelsDir) && !normalizedCurrent.includes(desktopModelsDir)) {
    currentModelsDirs.push(desktopModelsDir)
    settings.set('modelsDirs', currentModelsDirs)
  }

  sendProgress('migrate', { percent: 100, status: i18n.t('common.done') })
  await installations.update(entry.id, { status: 'installed' })

  return { entry, destPath }
}
