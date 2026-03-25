import path from 'path'
import fs from 'fs'
import os from 'os'
import { pipFreezeDirect } from './desktopDetect'
import { findComfyUIDir } from './migrate'
import { scanCustomNodes } from './nodes'
import { buildExportEnvelope } from './snapshots'
import {
  sendMigrationSteps, migrateToStandaloneFromSnapshot,
} from './standaloneMigration'
import type { MigrationTools, StandaloneTargetSelection } from './standaloneMigration'
import type { Snapshot, SnapshotExportEnvelope } from './snapshots'
import type { InstallationRecord } from '../installations'
import * as i18n from './i18n'

/**
 * Find a Python executable in a portable install.
 * Portable installs have python_embeded/ at the portable root.
 */
function findPortablePython(installPath: string): string | null {
  const direct = path.join(installPath, 'python_embeded', 'python.exe')
  if (fs.existsSync(direct)) return direct

  try {
    const entries = fs.readdirSync(installPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidate = path.join(installPath, entry.name, 'python_embeded', 'python.exe')
        if (fs.existsSync(candidate)) return candidate
      }
    }
  } catch {}
  return null
}

/**
 * Find a Python executable in a git clone install.
 * Git clone installs may have .venv/ or venv/ at the install root.
 */
function findGitPython(installPath: string): string | null {
  const venvNames = ['.venv', 'venv', '.env', 'env']
  for (const venv of venvNames) {
    if (process.platform === 'win32') {
      const candidate = path.join(installPath, venv, 'Scripts', 'python.exe')
      if (fs.existsSync(candidate)) return candidate
    } else {
      const candidate = path.join(installPath, venv, 'bin', 'python3')
      if (fs.existsSync(candidate)) return candidate
      const candidate2 = path.join(installPath, venv, 'bin', 'python')
      if (fs.existsSync(candidate2)) return candidate2
    }
  }
  return null
}

function findPythonForSource(installPath: string, sourceId: string): string | null {
  if (sourceId === 'portable') return findPortablePython(installPath)
  if (sourceId === 'git') return findGitPython(installPath)
  return null
}

/**
 * Capture a snapshot from a local (portable or git) installation.
 */
export async function captureLocalSnapshot(
  installPath: string,
  sourceId: string,
  skipPipSync: boolean = true,
): Promise<Snapshot> {
  const comfyUIDir = findComfyUIDir(installPath)
  if (!comfyUIDir) {
    throw new Error(i18n.t('migrate.noComfyUIDir'))
  }

  const customNodes = await scanCustomNodes(comfyUIDir)

  let pipPackages: Record<string, string> = {}
  const pythonPath = findPythonForSource(installPath, sourceId)
  if (pythonPath) {
    try {
      pipPackages = await pipFreezeDirect(pythonPath)
    } catch {
      // Python env may not be accessible — nodes will get deps during restore
    }
  }

  const sourceLabel = sourceId === 'portable' ? 'Portable' : 'Git Clone'

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    trigger: 'manual',
    label: `${sourceLabel} migration`,
    comfyui: {
      ref: sourceLabel,
      commit: null,
      releaseTag: '',
      variant: '',
    },
    customNodes,
    pipPackages,
    skipPipSync,
  }
}

/**
 * Capture a local snapshot and stage it to a temp file.
 */
export async function stageLocalSnapshot(
  installPath: string,
  sourceId: string,
  installationName: string,
  skipPipSync: boolean = true,
): Promise<{ envelope: SnapshotExportEnvelope; stagedFile: string }> {
  const snapshot = await captureLocalSnapshot(installPath, sourceId, skipPipSync)
  const envelope = buildExportEnvelope(`${installationName} Migration`, [
    { filename: `${sourceId}-migration.json`, snapshot },
  ])

  const stagingDir = path.join(os.tmpdir(), 'comfyui-desktop-2-snapshots')
  await fs.promises.mkdir(stagingDir, { recursive: true })
  const stagedFile = path.join(stagingDir, `${sourceId}-migrate-${Date.now()}.json`)
  await fs.promises.writeFile(stagedFile, JSON.stringify(envelope, null, 2))

  return { envelope, stagedFile }
}

/**
 * Perform a full migration from a portable or git clone install to a new
 * standalone install.
 */
export async function performLocalMigration(
  sourceInstallation: InstallationRecord,
  actionData: Record<string, unknown> | undefined,
  tools: MigrationTools,
): Promise<{ entry: InstallationRecord; destPath: string }> {
  const { sendProgress } = tools

  const sourceId = sourceInstallation.sourceId as string
  const comfyUIDir = findComfyUIDir(sourceInstallation.installPath)
  if (!comfyUIDir) {
    throw new Error(i18n.t('migrate.noComfyUIDir'))
  }

  const sourceLabel = sourceId === 'portable' ? 'Portable' : 'Git Clone'
  const hasPreStaged = !!(actionData?.snapshotPath && typeof actionData.snapshotPath === 'string' && fs.existsSync(actionData.snapshotPath as string))

  sendMigrationSteps(sendProgress, {
    includeScan: !hasPreStaged,
    scanLabel: i18n.t('migrate.scanning'),
    dataPhaseLabel: i18n.t('migrate.migrateDataPhase'),
  })

  // Prepare snapshot
  const skipPipSync = !(actionData?.enablePipSync as boolean | undefined)
  let stagedFile: string
  let ownsStagedFile = false
  if (hasPreStaged) {
    stagedFile = actionData!.snapshotPath as string
  } else {
    sendProgress('scan', { percent: 0, status: i18n.t('migrate.scanning') })
    sendProgress('scan', { percent: 30, status: i18n.t('migrate.creatingSnapshot') })
    const staged = await stageLocalSnapshot(
      sourceInstallation.installPath,
      sourceId,
      sourceInstallation.name,
      skipPipSync,
    )
    stagedFile = staged.stagedFile
    ownsStagedFile = true
    sendProgress('scan', { percent: 100, status: i18n.t('common.done') })
  }

  const target = actionData?.target as StandaloneTargetSelection | undefined

  return migrateToStandaloneFromSnapshot({
    installNameBase: `ComfyUI (from ${sourceLabel})`,
    stagedSnapshot: { path: stagedFile, owned: ownsStagedFile },
    sourcePaths: {
      userDir: path.join(comfyUIDir, 'user'),
      inputDir: path.join(comfyUIDir, 'input'),
      outputDir: path.join(comfyUIDir, 'output'),
      modelsDir: path.join(comfyUIDir, 'models'),
    },
    labels: {
      userData: i18n.t('migrate.mergingUserData'),
      input: i18n.t('migrate.mergingInput'),
      output: i18n.t('migrate.mergingOutput'),
      models: i18n.t('migrate.addingModels'),
    },
    target,
    sourceInstallationId: sourceInstallation.id,
    sourceInstallationName: sourceInstallation.name,
  }, tools)
}
