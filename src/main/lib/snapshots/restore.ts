import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { readGitHead, isGitAvailable, gitClone, gitCheckoutCommit, gitFetchAndCheckout } from '../git'
import { rewriteCloneUrl } from '../github-mirror'
import { scanCustomNodes, nodeKey } from '../nodes'
import { pipFreeze, runUvPip as sharedRunUvPip, installFilteredRequirements, getPipIndexArgs, type PipMirrorConfig } from '../pip'
import { installCnrNode, switchCnrVersion, isSafePathComponent } from '../cnr'
import { killProcTree } from '../process'
import { formatComfyVersion } from '../version'
import { getUvPath, getActivePythonPath, getVenvDir } from '../pythonEnv'
import type { Snapshot, RestoreResult, NodeRestoreResult } from './types'
import type { ScannedNode } from '../nodes'
import type { InstallationRecord } from '../../installations'
import type { ComfyVersion } from '../version'
import * as settings from '../../settings'

// --- Pip Restore ---

/**
 * Protected packages that should not be modified during snapshot restore.
 * Matches Manager's skip list plus core tooling.
 *
 * TODO: Expand by detecting packages from the PyTorch index URL rather than
 * hardcoded names. This would automatically cover new CUDA packages without
 * maintaining a list. Also consider computing transitive dependencies of
 * protected packages to avoid breaking their dep chains.
 */
const PROTECTED_EXACT = new Set(['pip', 'setuptools', 'wheel', 'uv'])
const PROTECTED_PREFIXES = ['torch', 'nvidia', 'triton', 'cuda']

function isProtectedPackage(name: string): boolean {
  const lower = name.toLowerCase()
  if (PROTECTED_EXACT.has(lower)) return true
  return PROTECTED_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(prefix + '-') || lower.startsWith(prefix + '_'))
}

/** Normalize a package name for dist-info directory matching (PEP 503). */
function normalizeDistInfoName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '_')
}

function findSitePackagesDir(envRoot: string): string | null {
  if (process.platform === 'win32') {
    return path.join(envRoot, 'Lib', 'site-packages')
  }
  const libDir = path.join(envRoot, 'lib')
  try {
    const pyDir = fs.readdirSync(libDir).find((d) => d.startsWith('python'))
    if (pyDir) return path.join(libDir, pyDir, 'site-packages')
  } catch {}
  return null
}

/** Find a package's dist-info directory in site-packages. */
function findDistInfoDir(sitePackages: string, packageName: string): string | null {
  const normalized = normalizeDistInfoName(packageName)
  try {
    for (const entry of fs.readdirSync(sitePackages)) {
      if (!entry.endsWith('.dist-info')) continue
      // dist-info format: {normalized_name}-{version}.dist-info
      // Normalized name uses _ not -, so first '-' separates name from version
      const stem = entry.slice(0, -'.dist-info'.length)
      const dashIdx = stem.indexOf('-')
      if (dashIdx < 0) continue
      const dirName = stem.slice(0, dashIdx)
      if (normalizeDistInfoName(dirName) === normalized) {
        return entry
      }
    }
  } catch {}
  return null
}

/**
 * Find all directories/files in site-packages belonging to a package.
 * Uses the RECORD file from dist-info to identify top-level entries.
 */
function findPackageEntries(sitePackages: string, packageName: string): string[] {
  const entries: string[] = []
  const distInfo = findDistInfoDir(sitePackages, packageName)
  if (!distInfo) return entries

  entries.push(distInfo)

  const recordPath = path.join(sitePackages, distInfo, 'RECORD')
  try {
    const content = fs.readFileSync(recordPath, 'utf-8')
    const topLevels = new Set<string>()
    for (const line of content.split('\n')) {
      const filePath = line.split(',')[0]?.trim()
      if (!filePath || filePath.startsWith('..') || filePath === '') continue
      const topLevel = filePath.replace(/\\/g, '/').split('/')[0]!
      if (topLevel && topLevel !== distInfo) {
        topLevels.add(topLevel)
      }
    }
    for (const tl of topLevels) {
      if (fs.existsSync(path.join(sitePackages, tl))) {
        entries.push(tl)
      }
    }
  } catch {
    // Fallback: look for common name patterns
    const normalized = normalizeDistInfoName(packageName)
    for (const suffix of ['', '.py', '.libs', '.data']) {
      const candidate = normalized + suffix
      if (fs.existsSync(path.join(sitePackages, candidate)) && !entries.includes(candidate)) {
        entries.push(candidate)
      }
    }
  }

  return entries
}

/**
 * Create a targeted backup of specific packages from site-packages.
 * Only backs up directories/files that belong to the listed packages.
 */
async function createTargetedBackup(sitePackages: string, packageNames: string[]): Promise<string> {
  const backupDir = path.join(path.dirname(sitePackages), `.restore-backup-${Date.now()}`)
  await fs.promises.mkdir(backupDir, { recursive: true })

  const failures: string[] = []
  for (const pkg of packageNames) {
    const pkgEntries = findPackageEntries(sitePackages, pkg)
    for (const entry of pkgEntries) {
      const src = path.join(sitePackages, entry)
      const dst = path.join(backupDir, entry)
      try {
        const stat = await fs.promises.stat(src)
        if (stat.isDirectory()) {
          await fs.promises.cp(src, dst, { recursive: true })
        } else {
          await fs.promises.mkdir(path.dirname(dst), { recursive: true })
          await fs.promises.copyFile(src, dst)
        }
      } catch (err) {
        failures.push(`${entry}: ${(err as Error).message}`)
      }
    }
  }

  if (failures.length > 0) {
    // Clean up incomplete backup
    await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {})
    throw new Error(`Backup failed for ${failures.length} entry(s): ${failures.join('; ')}`)
  }

  return backupDir
}

/** Restore backed-up package files to site-packages. */
async function restoreFromBackup(backupDir: string, sitePackages: string): Promise<void> {
  try {
    const entries = await fs.promises.readdir(backupDir)
    for (const entry of entries) {
      const src = path.join(backupDir, entry)
      const dst = path.join(sitePackages, entry)
      await fs.promises.rm(dst, { recursive: true, force: true }).catch(() => {})
      const stat = await fs.promises.stat(src)
      if (stat.isDirectory()) {
        await fs.promises.cp(src, dst, { recursive: true })
      } else {
        await fs.promises.copyFile(src, dst)
      }
    }
  } catch (err) {
    console.error('Failed to restore from backup:', (err as Error).message)
  }
}

// Re-export shared runUvPip under local name for existing call sites
const runUvPip = sharedRunUvPip

/**
 * Restore the ComfyUI version to match a target snapshot.
 * Compares the current HEAD against the snapshot's commit and checks out
 * the target commit if they differ.
 */
export async function restoreComfyUIVersion(
  installPath: string,
  targetSnapshot: Snapshot,
  sendOutput: (text: string) => void,
  signal?: AbortSignal
): Promise<{ changed: boolean; commit: string | null; error?: string }> {
  const comfyuiDir = path.join(installPath, 'ComfyUI')
  const targetCommit = targetSnapshot.comfyui.commit
  if (!targetCommit) {
    return { changed: false, commit: null }
  }
  if (!/^[a-f0-9]{7,40}$/.test(targetCommit)) {
    return { changed: false, commit: null, error: 'Invalid commit hash in snapshot' }
  }

  const currentHead = readGitHead(comfyuiDir)
  if (currentHead && (currentHead.startsWith(targetCommit) || targetCommit.startsWith(currentHead))) {
    return { changed: false, commit: currentHead }
  }

  const gitDir = path.join(comfyuiDir, '.git')
  if (!fs.existsSync(gitDir)) {
    const msg = 'ComfyUI .git directory not found — cannot restore version'
    sendOutput(`⚠ ${msg}\n`)
    return { changed: false, commit: currentHead, error: msg }
  }

  sendOutput(`Checking out ComfyUI commit ${targetCommit.slice(0, 7)}…\n`)
  const gitResult = await gitFetchAndCheckout(comfyuiDir, targetCommit, sendOutput, signal)
  if (gitResult.exitCode !== 0) {
    const detail = (gitResult.stderr || gitResult.stdout).trim().split('\n').slice(-20).join('\n')
    const msg = detail
      ? `git checkout failed with exit code ${gitResult.exitCode}:\n${detail}`
      : `git checkout failed with exit code ${gitResult.exitCode}`
    sendOutput(`⚠ ${msg}\n`)
    return { changed: false, commit: currentHead, error: msg }
  }

  const newHead = readGitHead(comfyuiDir)
  return { changed: true, commit: newHead }
}

/**
 * Build the installation state update to apply after a snapshot restore.
 * Always updates updateChannel and lastRollback so the release cache sees
 * accurate channel state. When the ComfyUI version was successfully restored,
 * also updates version and updateInfoByChannel to match the snapshot.
 * When the version restore failed, uses the current installed state so that
 * the next update check correctly detects a version mismatch.
 */
export function buildPostRestoreState(
  targetSnapshot: Snapshot,
  comfyResult: { changed: boolean; commit: string | null; error?: string },
  existingUpdateInfo: Record<string, Record<string, unknown>> | undefined,
  currentComfyVersion?: ComfyVersion
): Record<string, unknown> {
  const targetChannel = targetSnapshot.updateChannel || 'stable'
  const headCommit = comfyResult.commit || targetSnapshot.comfyui.commit

  let restoredComfyVersion: ComfyVersion | undefined
  if (comfyResult.error) {
    restoredComfyVersion = currentComfyVersion
  } else if (headCommit) {
    restoredComfyVersion = {
      commit: headCommit,
      baseTag: targetSnapshot.comfyui.baseTag,
      commitsAhead: targetSnapshot.comfyui.commitsAhead,
    }
  } else {
    restoredComfyVersion = currentComfyVersion
  }

  const installedTag = restoredComfyVersion
    ? formatComfyVersion(restoredComfyVersion, 'short')
    : 'unknown'

  const state: Record<string, unknown> = {
    updateChannel: targetChannel,
    ...(restoredComfyVersion ? { comfyVersion: restoredComfyVersion } : {}),
    lastRollback: {
      preUpdateHead: null,
      postUpdateHead: headCommit,
      backupBranch: null,
      channel: targetChannel,
      updatedAt: Date.now(),
    },
    updateInfoByChannel: {
      ...(existingUpdateInfo || {}),
      [targetChannel]: { installedTag },
    },
  }

  return state
}

/**
 * Restore pip packages to match a target snapshot.
 * Creates a targeted backup of affected packages before making changes.
 * On failure, reverts from backup.
 */
export async function restorePipPackages(
  installPath: string,
  installation: InstallationRecord,
  targetSnapshot: Snapshot,
  sendProgress: (phase: string, data: Record<string, unknown>) => void,
  sendOutput: (text: string) => void,
  signal?: AbortSignal,
  mirrors?: PipMirrorConfig
): Promise<RestoreResult> {
  const result: RestoreResult = {
    installed: [], removed: [], changed: [],
    protectedSkipped: [], failed: [], errors: [],
  }

  const uvPath = getUvPath(installPath)
  const pythonPath = getActivePythonPath(installation)
  if (!pythonPath || !fs.existsSync(uvPath)) {
    throw new Error('Python environment or uv not found')
  }

  // 1. Capture current pip state
  sendProgress('restore', { percent: 5, status: 'Analyzing current environment…' })
  sendOutput('\nAnalyzing pip packages…\n')
  const currentPips = await pipFreeze(uvPath, pythonPath)
  const targetPips = targetSnapshot.pipPackages
  const currentCount = Object.keys(currentPips).length
  const targetCount = Object.keys(targetPips).length
  sendOutput(`Found ${currentCount} current package(s), target snapshot has ${targetCount}\n`)

  // 2. Compute what needs to change
  const toInstall: Array<{ name: string; version: string }> = []
  const toRemove: string[] = []

  for (const [name, version] of Object.entries(targetPips)) {
    if (isProtectedPackage(name)) {
      if (!(name in currentPips) || currentPips[name] !== version) {
        result.protectedSkipped.push(name)
      }
      continue
    }
    // Skip non-standard versions (editable installs, direct references)
    if (version.startsWith('-e ') || version.includes('://')) continue

    if (!(name in currentPips)) {
      toInstall.push({ name, version })
    } else if (currentPips[name] !== version) {
      result.changed.push({ name, from: currentPips[name]!, to: version })
      toInstall.push({ name, version })
    }
  }

  for (const name of Object.keys(currentPips)) {
    if (!(name in targetPips)) {
      if (isProtectedPackage(name)) {
        result.protectedSkipped.push(name)
      } else {
        toRemove.push(name)
      }
    }
  }

  // Identify truly new packages (not in the current env) upfront so we can
  // uninstall them on revert even if a bulk install was killed mid-way and
  // result.installed was never populated.
  const newPkgNames = toInstall
    .filter((p) => !result.changed.some((c) => c.name === p.name))
    .map((p) => p.name)

  // Print the plan
  const newPkgs = newPkgNames
  const pipPlanParts: string[] = []
  if (newPkgs.length > 0) pipPlanParts.push(`install ${newPkgs.length}`)
  if (result.changed.length > 0) pipPlanParts.push(`change ${result.changed.length}`)
  if (toRemove.length > 0) pipPlanParts.push(`remove ${toRemove.length}`)
  if (result.protectedSkipped.length > 0) pipPlanParts.push(`${result.protectedSkipped.length} protected (skipped)`)
  if (pipPlanParts.length > 0) {
    sendOutput(`\nPlan: ${pipPlanParts.join(', ')} package(s)\n\n`)
  } else {
    sendOutput('\nNo package changes needed\n')
  }

  if (toInstall.length === 0 && toRemove.length === 0) {
    return result
  }

  // 3. Create targeted backup of packages that will be modified or removed
  sendProgress('restore', { percent: 10, status: 'Creating backup of affected packages…' })
  let envDir = getVenvDir(installPath)
  let sitePackages = findSitePackagesDir(envDir)
  if (!sitePackages) {
    // Fallback: legacy envs/default/ layout (pre-migration)
    envDir = path.join(installPath, 'envs', 'default')
    sitePackages = findSitePackagesDir(envDir)
  }
  if (!sitePackages) {
    throw new Error('Could not locate site-packages directory')
  }

  const packagesToBackup = [
    ...toInstall.filter((p) => p.name in currentPips).map((p) => p.name),
    ...toRemove,
  ]

  let backupDir: string | null = null
  if (packagesToBackup.length > 0) {
    backupDir = await createTargetedBackup(sitePackages, packagesToBackup)
  }

  try {
    // 4. Install missing + upgrade/downgrade changed packages
    if (toInstall.length > 0 && !signal?.aborted) {
      const totalOps = toInstall.length + toRemove.length
      sendProgress('restore', { percent: 20, status: `Installing ${toInstall.length} package(s)…` })

      const specs = toInstall.map((p) => `${p.name}==${p.version}`)
      const indexArgs = getPipIndexArgs(mirrors?.pypiMirror, mirrors?.useChineseMirrors)

      // Try bulk install first
      sendOutput(`\nInstalling ${specs.length} package(s)…\n`)
      const bulkResult = await runUvPip(uvPath, ['pip', 'install', ...specs, '--python', pythonPath, ...indexArgs], installPath, sendOutput, signal)

      if (bulkResult !== 0) {
        sendOutput('\n⚠ Bulk install failed, falling back to one-by-one with --no-deps\n\n')

        for (let i = 0; i < specs.length; i++) {
          if (signal?.aborted) break
          const spec = specs[i]!
          const name = toInstall[i]!.name
          const percent = 20 + Math.round((i / totalOps) * 50)
          sendProgress('restore', { percent, status: `Installing ${name}…` })

          const singleResult = await runUvPip(
            uvPath, ['pip', 'install', spec, '--no-deps', '--python', pythonPath, ...indexArgs], installPath, sendOutput, signal
          )

          if (singleResult !== 0) {
            result.failed.push(name)
            result.errors.push(`Failed to install ${spec}`)
          } else if (!result.changed.some((c) => c.name === name)) {
            result.installed.push(name)
          }
        }
      } else {
        for (const p of toInstall) {
          if (!result.changed.some((c) => c.name === p.name)) {
            result.installed.push(p.name)
          }
        }
      }
    }

    // 5. Remove extra packages (present in current but absent from snapshot)
    if (toRemove.length > 0 && !signal?.aborted) {
      sendProgress('restore', { percent: 75, status: `Removing ${toRemove.length} extra package(s)…` })
      sendOutput(`\nRemoving ${toRemove.length} extra package(s)…\n`)

      const removeResult = await runUvPip(
        uvPath, ['pip', 'uninstall', ...toRemove, '--python', pythonPath], installPath, sendOutput, signal
      )

      if (removeResult === 0) {
        result.removed.push(...toRemove)
      } else {
        for (const name of toRemove) {
          const singleResult = await runUvPip(
            uvPath, ['pip', 'uninstall', name, '--python', pythonPath], installPath, sendOutput, signal
          )
          if (singleResult === 0) {
            result.removed.push(name)
          } else {
            result.failed.push(name)
            result.errors.push(`Failed to remove ${name}`)
          }
        }
      }
    }

    // 6. If aborted or there were failures, revert the entire operation
    if (signal?.aborted || result.failed.length > 0) {
      const reason = signal?.aborted ? 'cancelled' : 'failures'
      sendProgress('restore', { percent: 90, status: `Reverting due to ${reason}…` })
      sendOutput(`\n⚠ Restore ${reason}. Reverting…\n`)

      if (backupDir) {
        await restoreFromBackup(backupDir, sitePackages)
      }

      // Uninstall any packages that were new (not in the pre-restore env).
      // Use the pre-computed newPkgNames rather than result.installed, because
      // a killed bulk install may have partially installed packages without
      // populating result.installed.
      if (newPkgNames.length > 0) {
        await runUvPip(
          uvPath, ['pip', 'uninstall', ...newPkgNames, '--python', pythonPath], installPath, sendOutput
        ).catch(() => {})
      }

      result.installed = []
      result.removed = []
      result.changed = []
      result.errors.push(`Restore reverted to pre-restore state due to ${reason}`)
    }
  } catch (err) {
    // Catastrophic failure — revert
    if (backupDir) {
      sendOutput(`\n⚠ Restore failed: ${(err as Error).message}\nReverting from backup…\n`)
      await restoreFromBackup(backupDir, sitePackages)
    }
    throw err
  } finally {
    if (backupDir) {
      await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return result
}

// --- Custom Node Restore ---

function isManagerNode(node: ScannedNode): boolean {
  return node.id.toLowerCase().includes('comfyui-manager')
}

async function disableNode(customNodesDir: string, dirName: string): Promise<void> {
  const src = path.join(customNodesDir, dirName)
  const disabledDir = path.join(customNodesDir, '.disabled')
  await fs.promises.mkdir(disabledDir, { recursive: true })
  const dst = path.join(disabledDir, dirName)
  await fs.promises.rm(dst, { recursive: true, force: true }).catch(() => {})
  await fs.promises.rename(src, dst)
}

async function enableNode(customNodesDir: string, dirName: string): Promise<void> {
  const src = path.join(customNodesDir, '.disabled', dirName)
  const dst = path.join(customNodesDir, dirName)
  await fs.promises.rm(dst, { recursive: true, force: true }).catch(() => {})
  await fs.promises.rename(src, dst)
}

async function runPostInstallScripts(
  nodePath: string,
  uvPath: string,
  pythonPath: string,
  installPath: string,
  sendOutput: (text: string) => void,
  signal?: AbortSignal,
  mirrors?: PipMirrorConfig
): Promise<void> {
  const reqPath = path.join(nodePath, 'requirements.txt')
  if (fs.existsSync(reqPath)) {
    try {
      await installFilteredRequirements(reqPath, uvPath, pythonPath, installPath, `.restore-reqs-${path.basename(nodePath)}.txt`, sendOutput, signal, mirrors)
    } catch (err) {
      sendOutput(`⚠ requirements.txt failed for ${path.basename(nodePath)}: ${(err as Error).message}\n`)
    }
  }

  const installScript = path.join(nodePath, 'install.py')
  if (fs.existsSync(installScript)) {
    try {
      await new Promise<void>((resolve) => {
        const proc = spawn(pythonPath, ['-s', installScript], {
          cwd: nodePath,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })

        const onAbort = () => {
          killProcTree(proc)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()

        proc.stdout.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
        proc.stderr.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
        proc.on('error', (err) => {
          signal?.removeEventListener('abort', onAbort)
          sendOutput(`⚠ install.py error: ${err.message}\n`)
          resolve()
        })
        proc.on('exit', () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    } catch (err) {
      sendOutput(`⚠ install.py failed for ${path.basename(nodePath)}: ${(err as Error).message}\n`)
    }
  }
}

export async function restoreCustomNodes(
  installPath: string,
  installation: InstallationRecord,
  targetSnapshot: Snapshot,
  sendProgress: (phase: string, data: Record<string, unknown>) => void,
  sendOutput: (text: string) => void,
  signal?: AbortSignal,
  mirrors?: PipMirrorConfig
): Promise<NodeRestoreResult> {
  const result: NodeRestoreResult = {
    installed: [], switched: [], enabled: [], disabled: [],
    removed: [], skipped: [], failed: [], unreportable: [],
  }

  const comfyuiDir = path.join(installPath, 'ComfyUI')
  const customNodesDir = path.join(comfyuiDir, 'custom_nodes')

  // 1. Scan current custom nodes
  sendProgress('restore-nodes', { percent: 5, status: 'Scanning custom nodes…' })
  sendOutput('Scanning current custom nodes…\n')
  const currentNodes = await scanCustomNodes(comfyuiDir)
  const currentByKey = new Map(currentNodes.map((n) => [nodeKey(n), n]))
  const targetByKey = new Map(targetSnapshot.customNodes.map((n) => [nodeKey(n), n]))
  sendOutput(`Found ${currentNodes.length} current node(s), target snapshot has ${targetSnapshot.customNodes.length}\n`)

  // Check git availability for git node operations
  const needsGit = targetSnapshot.customNodes.some((n) =>
    n.type === 'git' && (
      !currentByKey.has(nodeKey(n)) ||
      currentByKey.get(nodeKey(n))?.commit !== n.commit
    )
  )
  const gitAvailable = needsGit ? await isGitAvailable() : false
  if (needsGit && !gitAvailable) {
    sendOutput('⚠ git is not available in PATH — git node operations will be skipped\n')
  }

  // Compute and print the plan
  const toRemove: string[] = []
  const toDisable: string[] = []
  const toInstallNodes: string[] = []
  const toSwitch: string[] = []
  const toEnable: string[] = []
  for (const [key, currentNode] of currentByKey) {
    if (isManagerNode(currentNode)) continue
    if (!targetByKey.has(key)) toRemove.push(currentNode.id)
  }
  for (const targetNode of targetSnapshot.customNodes) {
    if (isManagerNode(targetNode)) continue
    const currentNode = currentByKey.get(nodeKey(targetNode))
    if (!currentNode) {
      if (targetNode.type !== 'file') toInstallNodes.push(targetNode.id)
    } else if (!currentNode.enabled && targetNode.enabled) {
      toEnable.push(targetNode.id)
    } else if (currentNode.enabled && !targetNode.enabled) {
      toDisable.push(targetNode.id)
    } else if (targetNode.enabled || currentNode.enabled) {
      if (targetNode.type === 'cnr' && targetNode.version && currentNode.version !== targetNode.version) {
        toSwitch.push(targetNode.id)
      } else if (targetNode.type === 'git' && targetNode.commit && currentNode.commit !== targetNode.commit) {
        toSwitch.push(targetNode.id)
      }
    }
  }

  const planParts: string[] = []
  if (toInstallNodes.length > 0) planParts.push(`install ${toInstallNodes.length}`)
  if (toSwitch.length > 0) planParts.push(`switch ${toSwitch.length}`)
  if (toEnable.length > 0) planParts.push(`enable ${toEnable.length}`)
  if (toRemove.length > 0) planParts.push(`remove ${toRemove.length}`)
  if (toDisable.length > 0) planParts.push(`disable ${toDisable.length}`)
  if (planParts.length > 0) {
    sendOutput(`\nPlan: ${planParts.join(', ')} node(s)\n\n`)
  } else {
    sendOutput('\nNo node changes needed\n')
  }

  // 2. Remove extras: nodes not in target snapshot (enabled or disabled)
  for (const [key, currentNode] of currentByKey) {
    if (signal?.aborted) break
    if (isManagerNode(currentNode)) continue
    if (!targetByKey.has(key)) {
      if (!isSafePathComponent(currentNode.dirName)) {
        result.failed.push({ id: currentNode.id, error: 'invalid directory name' })
        continue
      }
      try {
        const nodePath = currentNode.enabled
          ? path.join(customNodesDir, currentNode.dirName)
          : path.join(customNodesDir, '.disabled', currentNode.dirName)
        await fs.promises.rm(nodePath, { recursive: true, force: true })
        result.removed.push(currentNode.id)
        sendOutput(`Removed ${currentNode.id}\n`)
      } catch (err) {
        result.failed.push({ id: currentNode.id, error: `remove failed: ${(err as Error).message}` })
      }
    }
  }

  // 3. Process target nodes
  const targetList = targetSnapshot.customNodes.filter((n) => !isManagerNode(n))
  const nodesNeedingPostInstall: string[] = []

  for (let i = 0; i < targetList.length; i++) {
    if (signal?.aborted) break
    const targetNode = targetList[i]!
    const key = nodeKey(targetNode)
    const currentNode = currentByKey.get(key)
    const percent = 10 + Math.round((i / targetList.length) * 80)
    sendProgress('restore-nodes', { percent, status: `Processing ${targetNode.id}…` })

    if (!currentNode) {
      // Node not present — install or report
      if (targetNode.type === 'cnr') {
        if (!targetNode.version) {
          result.failed.push({ id: targetNode.id, error: 'no version in snapshot' })
          continue
        }
        if (!isSafePathComponent(targetNode.id)) {
          result.failed.push({ id: targetNode.id, error: 'invalid node ID' })
          continue
        }
        try {
          await installCnrNode(targetNode.id, targetNode.version, customNodesDir, sendOutput)
          result.installed.push(targetNode.id)
          nodesNeedingPostInstall.push(path.join(customNodesDir, targetNode.id))
          if (!targetNode.enabled) {
            await disableNode(customNodesDir, targetNode.id)
          }
        } catch (err) {
          if (signal?.aborted) break
          result.failed.push({ id: targetNode.id, error: (err as Error).message })
        }
      } else if (targetNode.type === 'git') {
        if (!gitAvailable) {
          result.failed.push({ id: targetNode.id, error: 'git not available' })
          continue
        }
        if (!targetNode.url) {
          result.failed.push({ id: targetNode.id, error: 'no URL in snapshot' })
          continue
        }
        if (!isSafePathComponent(targetNode.dirName)) {
          result.failed.push({ id: targetNode.id, error: 'invalid directory name' })
          continue
        }
        try {
          const dest = path.join(customNodesDir, targetNode.dirName)
          const cloneUrl = rewriteCloneUrl(targetNode.url, settings.get('useChineseMirrors') === true)
          const cloneResult = await gitClone(cloneUrl, dest, sendOutput, signal)
          if (signal?.aborted) {
            await fs.promises.rm(dest, { recursive: true, force: true }).catch(() => {})
            break
          }
          if (cloneResult.exitCode !== 0) {
            const detail = (cloneResult.stderr || cloneResult.stdout).trim().split('\n').slice(-20).join('\n')
            result.failed.push({ id: targetNode.id, error: detail ? `git clone failed (exit ${cloneResult.exitCode}):\n${detail}` : `git clone failed (exit ${cloneResult.exitCode})` })
            continue
          }
          if (targetNode.commit) {
            const checkoutResult = await gitCheckoutCommit(dest, targetNode.commit, sendOutput, signal)
            if (signal?.aborted) {
              await fs.promises.rm(dest, { recursive: true, force: true }).catch(() => {})
              break
            }
            if (checkoutResult.exitCode !== 0) {
              sendOutput(`⚠ git checkout to ${targetNode.commit} failed for ${targetNode.id}\n`)
            }
          }
          result.installed.push(targetNode.id)
          nodesNeedingPostInstall.push(dest)
          if (!targetNode.enabled) {
            await disableNode(customNodesDir, targetNode.dirName)
          }
        } catch (err) {
          if (signal?.aborted) {
            // Clean up partial clone on abort
            const dest = path.join(customNodesDir, targetNode.dirName)
            await fs.promises.rm(dest, { recursive: true, force: true }).catch(() => {})
            break
          }
          result.failed.push({ id: targetNode.id, error: (err as Error).message })
        }
      } else if (targetNode.type === 'file') {
        result.unreportable.push(targetNode.id)
      }
      continue
    }

    // Node exists — handle enable/disable and version changes
    if (!currentNode.enabled && targetNode.enabled) {
      try {
        await enableNode(customNodesDir, currentNode.dirName)
        result.enabled.push(targetNode.id)
        sendOutput(`Enabled ${targetNode.id}\n`)
      } catch (err) {
        result.failed.push({ id: targetNode.id, error: `enable failed: ${(err as Error).message}` })
        continue
      }
    } else if (currentNode.enabled && !targetNode.enabled) {
      try {
        await disableNode(customNodesDir, currentNode.dirName)
        result.disabled.push(targetNode.id)
        sendOutput(`Disabled ${targetNode.id}\n`)
      } catch (err) {
        result.failed.push({ id: targetNode.id, error: `disable failed: ${(err as Error).message}` })
      }
      continue
    }

    // Version/commit changes (only if the node is/will be enabled)
    if (targetNode.enabled || currentNode.enabled) {
      const nodePath = path.join(customNodesDir, currentNode.dirName)

      if (targetNode.type === 'cnr' && targetNode.version && currentNode.version !== targetNode.version) {
        try {
          await switchCnrVersion(targetNode.id, targetNode.version, nodePath, sendOutput)
          result.switched.push(targetNode.id)
          nodesNeedingPostInstall.push(nodePath)
        } catch (err) {
          if (signal?.aborted) break
          result.failed.push({ id: targetNode.id, error: (err as Error).message })
        }
      } else if (targetNode.type === 'git' && targetNode.commit && currentNode.commit !== targetNode.commit) {
        if (!gitAvailable) {
          result.failed.push({ id: targetNode.id, error: 'git not available' })
        } else {
          const checkoutResult = await gitCheckoutCommit(nodePath, targetNode.commit, sendOutput, signal)
          if (signal?.aborted) break
          if (checkoutResult.exitCode === 0) {
            result.switched.push(targetNode.id)
            nodesNeedingPostInstall.push(nodePath)
          } else {
            const detail = (checkoutResult.stderr || checkoutResult.stdout).trim().split('\n').slice(-20).join('\n')
            result.failed.push({ id: targetNode.id, error: detail ? `git checkout failed (exit ${checkoutResult.exitCode}):\n${detail}` : `git checkout failed (exit ${checkoutResult.exitCode})` })
          }
        }
      } else {
        result.skipped.push(targetNode.id)
      }
    } else {
      result.skipped.push(targetNode.id)
    }
  }

  // 4. Run post-install scripts for installed/switched nodes
  if (nodesNeedingPostInstall.length > 0 && !signal?.aborted) {
    const uvPath = getUvPath(installPath)
    const pythonPath = getActivePythonPath(installation)

    if (pythonPath && fs.existsSync(uvPath)) {
      sendProgress('restore-nodes', { percent: 92, status: 'Installing node dependencies…' })
      for (const nodePath of nodesNeedingPostInstall) {
        if (signal?.aborted) break
        sendOutput(`\nRunning post-install for ${path.basename(nodePath)}…\n`)
        await runPostInstallScripts(nodePath, uvPath, pythonPath, installPath, sendOutput, signal, mirrors)
      }
    } else {
      sendOutput('⚠ Cannot run post-install scripts: uv or Python environment not found\n')
    }
  }

  // 5. Install manager_requirements.txt from ComfyUI root if present
  {
    const mgrReqPath = path.join(comfyuiDir, 'manager_requirements.txt')
    if (fs.existsSync(mgrReqPath)) {
      const uvPath = getUvPath(installPath)
      const pythonPath = getActivePythonPath(installation)

      if (pythonPath && fs.existsSync(uvPath)) {
        sendOutput('\nInstalling manager requirements…\n')
        try {
          const mgrResult = await installFilteredRequirements(mgrReqPath, uvPath, pythonPath, installPath, '.restore-mgr-reqs.txt', sendOutput, signal, mirrors)
          if (mgrResult !== 0) {
            sendOutput(`⚠ manager requirements install exited with code ${mgrResult}\n`)
          }
        } catch (err) {
          sendOutput(`⚠ manager_requirements.txt failed: ${(err as Error).message}\n`)
        }
      }
    }
  }

  sendProgress('restore-nodes', { percent: 100, status: 'Node restore complete' })
  return result
}
