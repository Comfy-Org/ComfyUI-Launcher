import path from 'path'
import fs from 'fs'
import { detectDesktopInstall, stageDesktopSnapshot } from './desktopDetect'
import {
  sendMigrationSteps, migrateToStandaloneFromSnapshot,
  type MigrationTools, type StandaloneTargetSelection,
} from './standaloneMigration'
import type { InstallationRecord } from '../installations'
import * as i18n from './i18n'

export type { MigrationTools }

export async function performDesktopMigration(
  actionData: Record<string, unknown> | undefined,
  tools: MigrationTools,
  sourceInstallation?: { id: string; name: string },
): Promise<{ entry: InstallationRecord; destPath: string }> {
  const { sendProgress } = tools

  const desktopInfo = detectDesktopInstall()
  if (!desktopInfo) {
    throw new Error(i18n.t('desktop.notFound'))
  }

  const hasPreStaged = !!(actionData?.snapshotPath && typeof actionData.snapshotPath === 'string' && fs.existsSync(actionData.snapshotPath as string))

  sendMigrationSteps(sendProgress, {
    includeScan: !hasPreStaged,
    scanLabel: i18n.t('desktop.scanningDesktop'),
    dataPhaseLabel: i18n.t('desktop.copyingUserData'),
  })

  // Prepare snapshot
  let stagedFile: string
  let ownsStagedFile = false
  if (hasPreStaged) {
    stagedFile = actionData!.snapshotPath as string
  } else {
    sendProgress('scan', { percent: 0, status: i18n.t('desktop.scanningDesktop') })
    sendProgress('scan', { percent: 30, status: i18n.t('desktop.creatingSnapshot') })
    const staged = await stageDesktopSnapshot(desktopInfo)
    stagedFile = staged.stagedFile
    ownsStagedFile = true
    sendProgress('scan', { percent: 100, status: i18n.t('common.done') })
  }

  const target = actionData?.target as StandaloneTargetSelection | undefined

  return migrateToStandaloneFromSnapshot({
    installNameBase: 'ComfyUI (from Legacy Desktop)',
    stagedSnapshot: { path: stagedFile, owned: ownsStagedFile },
    sourcePaths: {
      userDir: path.join(desktopInfo.basePath, 'user'),
      inputDir: path.join(desktopInfo.basePath, 'input'),
      outputDir: path.join(desktopInfo.basePath, 'output'),
      modelsDir: path.join(desktopInfo.basePath, 'models'),
    },
    labels: {
      userData: i18n.t('desktop.copyingUserData'),
      input: i18n.t('desktop.copyingInput'),
      output: i18n.t('desktop.copyingOutput'),
      models: i18n.t('desktop.addingModels'),
    },
    target,
    sourceInstallationId: sourceInstallation?.id,
    sourceInstallationName: sourceInstallation?.name,
  }, tools)
}
