import fs from 'fs'
import path from 'path'
import { fetchLatestRelease } from '../../lib/comfyui-releases'
import * as releaseCache from '../../lib/release-cache'
import { formatComfyVersion } from '../../lib/version'
import type { ComfyVersion } from '../../lib/version'
import { resolveInstalledVersion } from '../../lib/version-resolve'
import { readGitHead } from '../../lib/git'
import { installFilteredRequirements } from '../../lib/pip'
import { copyDirWithProgress } from '../../lib/copy'
import { listCustomNodes, findComfyUIDir, backupDir, mergeDirFlat } from '../../lib/migrate'
import { t } from '../../lib/i18n'
import * as installations from '../../installations'
import * as settings from '../../settings'
import * as snapshots from '../../lib/snapshots'
import { getUvPath, getActivePythonPath, getMasterPythonPath } from './envPaths'
import { COMFYUI_REPO } from './updateSections'
import { runComfyUIUpdate } from './updateOrchestrator'
import type { InstallationRecord } from '../../installations'
import type { ActionResult, ActionTools } from '../../types/sources'

export async function handleAction(
  actionId: string,
  installation: InstallationRecord,
  actionData: Record<string, unknown> | undefined,
  { update, sendProgress, sendOutput, signal }: ActionTools
): Promise<ActionResult> {
  if (actionId === 'snapshot-save') {
    const label = (actionData?.label as string | undefined) || undefined
    const filename = await snapshots.saveSnapshot(installation.installPath, installation, 'manual', label)
    const snapshotCount = await snapshots.getSnapshotCount(installation.installPath)
    await update({ lastSnapshot: filename, snapshotCount })
    return { ok: true, navigate: 'detail' }
  }

  if (actionId === 'snapshot-restore') {
    const file = actionData?.file as string | undefined
    if (!file) return { ok: false, message: t('standalone.snapshotNoFile') }

    sendProgress('steps', { steps: [
      { phase: 'restore-comfyui', label: t('standalone.snapshotRestoreComfyUIPhase') },
      { phase: 'restore-nodes', label: t('standalone.snapshotRestoreNodesPhase') },
      { phase: 'restore-pip', label: t('standalone.snapshotRestorePipPhase') },
    ] })
    sendProgress('restore-comfyui', { percent: 0, status: 'Loading snapshot…' })
    sendOutput('Loading snapshot…\n')

    const targetSnapshot = await snapshots.loadSnapshot(installation.installPath, file)

    // Phase 1: Restore ComfyUI version (checkout target commit)
    sendOutput('\n── Restore ComfyUI Version ──\n')
    const comfyResult = await snapshots.restoreComfyUIVersion(
      installation.installPath, targetSnapshot, sendOutput
    )
    sendProgress('restore-comfyui', { percent: 100, status: comfyResult.changed ? 'Restored' : 'Up to date' })

    if (signal?.aborted) return { ok: false, message: 'Cancelled' }

    // Phase 2: Restore custom nodes first (node installs may add pip dependencies)
    sendOutput('\n── Restore Nodes ──\n')
    const nodeResult = await snapshots.restoreCustomNodes(
      installation.installPath, installation, targetSnapshot, sendProgress, sendOutput, signal,
      settings.getMirrorConfig()
    )

    if (signal?.aborted) return { ok: false, message: 'Cancelled' }

    // Phase 3: Restore pip packages (syncs to exact target state)
    sendOutput('\n── Restore Packages ──\n')
    const pipResult = await snapshots.restorePipPackages(
      installation.installPath, installation, targetSnapshot,
      (phase, data) => sendProgress(phase === 'restore' ? 'restore-pip' : phase, data),
      sendOutput, signal, settings.getMirrorConfig()
    )

    // Build combined summary
    const summary: string[] = []

    if (comfyResult.changed) {
      summary.push(`ComfyUI: checked out ${(comfyResult.commit || targetSnapshot.comfyui.commit || '').slice(0, 7)}`)
    }
    if (comfyResult.error) summary.push(`ComfyUI restore failed: ${comfyResult.error}`)

    const nodeActions = nodeResult.installed.length + nodeResult.switched.length +
      nodeResult.enabled.length + nodeResult.disabled.length + nodeResult.removed.length
    if (nodeActions > 0) {
      const parts: string[] = []
      if (nodeResult.installed.length > 0) parts.push(`${nodeResult.installed.length} installed`)
      if (nodeResult.switched.length > 0) parts.push(`${nodeResult.switched.length} switched`)
      if (nodeResult.enabled.length > 0) parts.push(`${nodeResult.enabled.length} enabled`)
      if (nodeResult.removed.length > 0) parts.push(`${nodeResult.removed.length} removed`)
      if (nodeResult.disabled.length > 0) parts.push(`${nodeResult.disabled.length} disabled`)
      summary.push(`Nodes: ${parts.join(', ')}`)
    }
    if (nodeResult.failed.length > 0) summary.push(`${nodeResult.failed.length} node(s) failed`)
    if (nodeResult.unreportable.length > 0) summary.push(`${nodeResult.unreportable.length} standalone .py file(s) not restorable`)

    if (pipResult.installed.length > 0 || pipResult.changed.length > 0 || pipResult.removed.length > 0) {
      const parts: string[] = []
      if (pipResult.installed.length > 0) parts.push(`${pipResult.installed.length} installed`)
      if (pipResult.changed.length > 0) parts.push(`${pipResult.changed.length} changed`)
      if (pipResult.removed.length > 0) parts.push(`${pipResult.removed.length} removed`)
      summary.push(`Packages: ${parts.join(', ')}`)
    }
    if (pipResult.protectedSkipped.length > 0) summary.push(`${pipResult.protectedSkipped.length} protected (skipped)`)
    if (pipResult.failed.length > 0) summary.push(`${pipResult.failed.length} package(s) failed`)

    const totalFailures = nodeResult.failed.length + pipResult.failed.length + (comfyResult.error ? 1 : 0)

    if (summary.length === 0) {
      sendOutput(`\n✓ ${t('standalone.snapshotRestoreNothingToDo')}\n`)
      sendProgress('done', { percent: 100, status: t('standalone.snapshotRestoreNothingToDo') })
      return { ok: true, navigate: 'detail' }
    }

    sendOutput(`\n${totalFailures > 0 ? '⚠' : '✓'} ${t('standalone.snapshotRestoreComplete')}: ${summary.join('; ')}\n`)

    if (pipResult.failed.length > 0) {
      return { ok: false, message: t('standalone.snapshotRestoreReverted') }
    }

    // Restore update channel and version/lastRollback state so the
    // release cache sees accurate state for the restored channel.
    const comfyuiDir = path.join(installation.installPath, 'ComfyUI')
    const restoredHead = comfyResult.commit || readGitHead(comfyuiDir)
    const restoreState = snapshots.buildPostRestoreState(
      targetSnapshot, comfyResult,
      installation.updateInfoByChannel as Record<string, Record<string, unknown>> | undefined,
      installation.comfyVersion as ComfyVersion | undefined
    )
    // Reconcile comfyVersion through the single write-gate.
    // resolveInstalledVersion keeps stored baseTag metadata when the commit
    // matches, and re-resolves from git only for old snapshots that lack it.
    if (!comfyResult.error && restoredHead) {
      const snapshotCv: ComfyVersion | undefined = targetSnapshot.comfyui.commit
        ? { commit: targetSnapshot.comfyui.commit, baseTag: targetSnapshot.comfyui.baseTag, commitsAhead: targetSnapshot.comfyui.commitsAhead }
        : undefined
      const resolved = await resolveInstalledVersion(comfyuiDir, restoredHead, snapshotCv)
      restoreState.comfyVersion = resolved
      const tag = formatComfyVersion(resolved, 'short')
      const channelInfo = restoreState.updateInfoByChannel as Record<string, Record<string, unknown>>
      const ch = targetSnapshot.updateChannel || 'stable'
      channelInfo[ch] = { ...channelInfo[ch], installedTag: tag }
    }
    await update(restoreState)

    // Capture a new snapshot reflecting the restored state
    try {
      const updatedInstallation = {
        ...installation,
        ...restoreState,
      }
      const filename = await snapshots.saveSnapshot(installation.installPath, updatedInstallation, 'post-restore')
      const snapshotCount = await snapshots.getSnapshotCount(installation.installPath)
      await update({ lastSnapshot: filename, snapshotCount })
    } catch (err) {
      console.warn('Post-restore snapshot failed:', err)
    }

    sendProgress('done', { percent: 100, status: t('standalone.snapshotRestoreComplete') })
    return { ok: totalFailures === 0, navigate: 'detail',
      ...(totalFailures > 0 ? { message: `${totalFailures} operation(s) failed` } : {}) }
  }

  // Handler kept for potential future use (e.g., context menu). Button removed from UI since
  // snapshots are tiny (~5 KB) and auto-pruned, so manual deletion adds more risk than value.
  if (actionId === 'snapshot-delete') {
    const file = actionData?.file as string | undefined
    if (!file) return { ok: false, message: t('standalone.snapshotNoFile') }
    await snapshots.deleteSnapshot(installation.installPath, file)
    const remaining = await snapshots.listSnapshots(installation.installPath)
    const snapshotCount = remaining.length
    const lastSnapshot = remaining.length > 0 ? remaining[0]!.filename : null
    await update({ snapshotCount, ...(file === installation.lastSnapshot ? { lastSnapshot } : {}) })
    return { ok: true, navigate: 'detail' }
  }

  if (actionId === 'snapshot-view') {
    const file = actionData?.file as string | undefined
    if (!file) return { ok: false, message: t('standalone.snapshotNoFile') }
    const target = await snapshots.loadSnapshot(installation.installPath, file)
    const diff = await snapshots.diffAgainstCurrent(installation.installPath, installation, target)

    const lines: string[] = []

    // ComfyUI version
    if (diff.comfyuiChanged && diff.comfyui) {
      lines.push(`${t('standalone.snapshotDiffComfyUI')}`)
      lines.push(`  ${diff.comfyui.from.formattedVersion} → ${diff.comfyui.to.formattedVersion}`)
      lines.push('')
    }

    // Custom nodes
    if (diff.nodesAdded.length > 0 || diff.nodesRemoved.length > 0 || diff.nodesChanged.length > 0) {
      lines.push(`${t('standalone.snapshotDiffNodes')}`)
      for (const n of diff.nodesAdded) {
        const ver = n.version || (n.commit ? n.commit.slice(0, 7) : '')
        lines.push(`  + ${n.id}${ver ? ` ${ver}` : ''}`)
      }
      for (const n of diff.nodesRemoved) {
        const ver = n.version || (n.commit ? n.commit.slice(0, 7) : '')
        lines.push(`  − ${n.id}${ver ? ` ${ver}` : ''}`)
      }
      for (const n of diff.nodesChanged) {
        const fromVer = n.from.version || (n.from.commit ? n.from.commit.slice(0, 7) : '?')
        const toVer = n.to.version || (n.to.commit ? n.to.commit.slice(0, 7) : '?')
        const enabledChanged = n.from.enabled !== n.to.enabled
        const versionChanged = fromVer !== toVer
        if (enabledChanged && versionChanged) {
          lines.push(`  ~ ${n.id}: ${fromVer} → ${toVer}, ${n.from.enabled ? 'enabled' : 'disabled'} → ${n.to.enabled ? 'enabled' : 'disabled'}`)
        } else if (enabledChanged) {
          lines.push(`  ~ ${n.id}: ${n.from.enabled ? 'enabled' : 'disabled'} → ${n.to.enabled ? 'enabled' : 'disabled'}`)
        } else {
          lines.push(`  ~ ${n.id}: ${fromVer} → ${toVer}`)
        }
      }
      lines.push('')
    }

    // Pip packages
    const pipTotal = diff.pipsAdded.length + diff.pipsRemoved.length + diff.pipsChanged.length
    if (pipTotal > 0) {
      lines.push(`${t('standalone.snapshotDiffPackages')} (${pipTotal})`)
      for (const p of diff.pipsAdded) lines.push(`  + ${p.name} ${p.version}`)
      for (const p of diff.pipsRemoved) lines.push(`  − ${p.name} ${p.version}`)
      for (const p of diff.pipsChanged) lines.push(`  ~ ${p.name}: ${p.from} → ${p.to}`)
      lines.push('')
    }

    if (lines.length === 0) {
      lines.push(t('standalone.snapshotDiffNoChanges'))
    }

    return { ok: true, message: lines.join('\n') }
  }

  if (actionId === 'switch-channel') {
    const targetChannel = actionData?.channel as string | undefined
    if (!targetChannel) return { ok: false, message: 'No channel specified.' }
    await update({ updateChannel: targetChannel })
    return { ok: true, navigate: 'detail' }
  }

  if (actionId === 'check-update') {
    const channel = (installation.updateChannel as string | undefined) || 'stable'
    const otherChannels = ['stable', 'latest'].filter((ch) => ch !== channel)
    await Promise.allSettled(
      otherChannels.map((ch) =>
        releaseCache.getOrFetch(COMFYUI_REPO, ch, async () => {
          const release = await fetchLatestRelease(ch)
          if (!release) return null
          return releaseCache.buildCacheEntry(release)
        }, true)
      )
    )
    const result = await releaseCache.checkForUpdate(COMFYUI_REPO, channel, installation, update)
    await releaseCache.enrichCommitsAhead(COMFYUI_REPO, path.join(installation.installPath, 'ComfyUI'))
    return result
  }

  if (actionId === 'update-comfyui') {
    return handleUpdateComfyUI(installation, actionData, { update, sendProgress, sendOutput, signal })
  }

  if (actionId === 'migrate-from') {
    return handleMigrateFrom(installation, actionData, { update, sendProgress, sendOutput, signal })
  }

  return { ok: false, message: `Action "${actionId}" not yet implemented.` }
}

async function handleUpdateComfyUI(
  installation: InstallationRecord,
  actionData: Record<string, unknown> | undefined,
  { update, sendProgress, sendOutput, signal }: ActionTools
): Promise<ActionResult> {
  const installPath = installation.installPath
  const comfyuiDir = path.join(installPath, 'ComfyUI')
  const gitDir = path.join(comfyuiDir, '.git')

  if (!fs.existsSync(gitDir)) {
    return { ok: false, message: t('standalone.updateNoGit') }
  }

  const masterPython = getMasterPythonPath(installPath)
  if (!fs.existsSync(masterPython)) {
    return { ok: false, message: 'Master Python not found.' }
  }

  const targetChannel = (actionData?.channel as string | undefined) ?? (installation.updateChannel as string | undefined) ?? 'stable'
  if (targetChannel !== (installation.updateChannel as string | undefined)) {
    await update({ updateChannel: targetChannel })
  }
  const channel = targetChannel as 'stable' | 'latest'

  sendProgress('steps', { steps: [
    { phase: 'prepare', label: t('standalone.updatePrepare') },
    { phase: 'run', label: t('standalone.updateRun') },
    { phase: 'deps', label: t('standalone.updateDeps') },
  ] })

  sendProgress('prepare', { percent: -1, status: t('standalone.updatePrepareSnapshot') })
  sendProgress('run', { percent: -1, status: t('standalone.updateFetching') })

  const result = await runComfyUIUpdate({
    installPath,
    installation,
    channel,
    update,
    sendProgress,
    sendOutput,
    signal,
    dryRunConflictCheck: true,
    saveRollback: true,
    preUpdateSnapshot: true,
  })

  if (!result.ok) {
    return { ok: false, message: result.message }
  }

  sendProgress('done', { percent: 100, status: 'Complete' })
  return { ok: true, navigate: 'detail' }
}

async function handleMigrateFrom(
  installation: InstallationRecord,
  actionData: Record<string, unknown> | undefined,
  { sendProgress, sendOutput }: ActionTools
): Promise<ActionResult> {
  const sourceId = actionData?.sourceInstallationId as string | undefined
  if (!sourceId) return { ok: false, message: 'No source installation specified.' }

  const wantNodes = actionData?.customNodes === true
  const wantAllUserData = actionData?.allUserData === true
  const wantWorkflows = !wantAllUserData && actionData?.workflows === true
  const wantSettings = !wantAllUserData && actionData?.userSettings === true
  const wantModels = actionData?.models === true
  const wantInput = actionData?.input === true
  const wantOutput = actionData?.output === true

  const srcInst = await installations.get(sourceId)
  if (!srcInst) return { ok: false, message: 'Source installation not found.' }

  const srcComfyUI = findComfyUIDir(srcInst.installPath)
  const dstComfyUI = path.join(installation.installPath, 'ComfyUI')

  if (!srcComfyUI) {
    return { ok: false, message: t('migrate.noComfyUIDir') }
  }

  const useShared = (installation.useSharedPaths as boolean | undefined) !== false

  const srcModels = path.join(srcComfyUI, 'models')
  const dstModels = useShared
    ? ((settings.get('modelsDirs') as string[] | undefined) || settings.defaults.modelsDirs)[0]!
    : path.join(dstComfyUI, 'models')
  const srcInput = path.join(srcComfyUI, 'input')
  const dstInput = useShared
    ? ((settings.get('inputDir') as string | undefined) || settings.defaults.inputDir)
    : path.join(dstComfyUI, 'input')
  const srcOutput = path.join(srcComfyUI, 'output')
  const dstOutput = useShared
    ? ((settings.get('outputDir') as string | undefined) || settings.defaults.outputDir)
    : path.join(dstComfyUI, 'output')

  const srcCustomNodes = path.join(srcComfyUI, 'custom_nodes')
  const dstCustomNodes = path.join(dstComfyUI, 'custom_nodes')
  const srcWorkflows = path.join(srcComfyUI, 'user', 'default', 'workflows')
  const dstWorkflows = path.join(dstComfyUI, 'user', 'default', 'workflows')
  const srcUserDir = path.join(srcComfyUI, 'user')

  const steps: Array<{ phase: string; label: string }> = [{ phase: 'migrate', label: t('migrate.filePhase') }]
  if (wantNodes) steps.push({ phase: 'deps', label: t('migrate.depsPhase') })
  sendProgress('steps', { steps })

  sendProgress('migrate', { percent: 0, status: t('migrate.scanning') })

  const srcNodes = wantNodes ? listCustomNodes(srcCustomNodes) : []
  const hasAllUserData = wantAllUserData && fs.existsSync(srcUserDir)
  const hasWorkflows = wantWorkflows && fs.existsSync(srcWorkflows)
  const hasModels = wantModels && fs.existsSync(srcModels)
  const hasInput = wantInput && fs.existsSync(srcInput)
  const hasOutput = wantOutput && fs.existsSync(srcOutput)

  const settingsFiles: Array<{ profile: string; src: string; dst: string }> = []
  if (wantSettings && fs.existsSync(srcUserDir)) {
    try {
      for (const d of fs.readdirSync(srcUserDir, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith('_')) {
          const src = path.join(srcUserDir, d.name, 'comfy.settings.json')
          if (fs.existsSync(src)) {
            settingsFiles.push({ profile: d.name, src, dst: path.join(dstComfyUI, 'user', d.name, 'comfy.settings.json') })
          }
        }
      }
    } catch {}
  }

  const total = srcNodes.length + (hasAllUserData ? 1 : 0) + (hasWorkflows ? 1 : 0) + (settingsFiles.length > 0 ? 1 : 0) + (hasModels ? 1 : 0) + (hasInput ? 1 : 0) + (hasOutput ? 1 : 0)

  if (total === 0) {
    sendProgress('migrate', { percent: 100, status: t('migrate.nothingToMigrate') })
    if (wantNodes) sendProgress('deps', { percent: 100, status: t('migrate.noDeps') })
    sendProgress('done', { percent: 100, status: 'Complete' })
    return { ok: true, navigate: 'detail' }
  }

  let migrated = 0
  const migratedNodes: Array<{ name: string; dir: string; hasRequirements: boolean }> = []
  const backedUp: string[] = []
  const summary: string[] = []

  if (srcNodes.length > 0) {
    fs.mkdirSync(dstCustomNodes, { recursive: true })
    for (const node of srcNodes) {
      const dstNodeDir = path.join(dstCustomNodes, node.name)
      if (fs.existsSync(dstNodeDir)) {
        const bak = backupDir(dstNodeDir)
        if (bak) backedUp.push(node.name)
      }
      await copyDirWithProgress(node.dir, dstNodeDir, (copied, fileTotal) => {
        const sub = fileTotal > 0 ? copied / fileTotal : 1
        const percent = Math.round(((migrated + sub) / total) * 100)
        sendProgress('migrate', { percent, status: t('migrate.copyingNode', { name: node.name, current: migrated + 1, total }) })
      })
      migratedNodes.push(node)
      migrated++
    }
    summary.push(t('migrate.summaryNodes', { count: migratedNodes.length }))
    if (backedUp.length > 0) summary.push(t('migrate.summaryBackedUp', { count: backedUp.length }))
  }

  if (hasAllUserData) {
    sendProgress('migrate', { percent: Math.round((migrated / total) * 100), status: t('migrate.mergingUserData') })
    const dstUserDir = path.join(dstComfyUI, 'user')
    const result = await mergeDirFlat(srcUserDir, dstUserDir, (copied, skipped, fileTotal) => {
      const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1
      const percent = Math.round(((migrated + sub) / total) * 100)
      sendProgress('migrate', { percent, status: t('migrate.mergingUserData') })
    })
    migrated++
    summary.push(t('migrate.summaryUserData', { copied: result.copied, skipped: result.skipped }))
  }

  if (hasWorkflows) {
    sendProgress('migrate', { percent: Math.round((migrated / total) * 100), status: t('migrate.mergingWorkflows') })
    const result = await mergeDirFlat(srcWorkflows, dstWorkflows, (copied, skipped, fileTotal) => {
      const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1
      const percent = Math.round(((migrated + sub) / total) * 100)
      sendProgress('migrate', { percent, status: t('migrate.mergingWorkflows') })
    })
    migrated++
    summary.push(t('migrate.summaryWorkflows', { copied: result.copied, skipped: result.skipped }))
  }

  if (settingsFiles.length > 0) {
    sendProgress('migrate', { percent: Math.round((migrated / total) * 100), status: t('migrate.copyingSettings') })
    let copied = 0
    for (const sf of settingsFiles) {
      await fs.promises.mkdir(path.dirname(sf.dst), { recursive: true })
      await fs.promises.copyFile(sf.src, sf.dst)
      copied++
    }
    migrated++
    summary.push(t('migrate.summarySettings', { count: copied }))
  }

  if (hasModels) {
    sendProgress('migrate', { percent: Math.round((migrated / total) * 100), status: t('migrate.mergingModels') })
    const result = await mergeDirFlat(srcModels, dstModels, (copied, skipped, fileTotal) => {
      const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1
      const percent = Math.round(((migrated + sub) / total) * 100)
      sendProgress('migrate', { percent, status: t('migrate.mergingModels') })
    })
    migrated++
    summary.push(t('migrate.summaryModels', { copied: result.copied, skipped: result.skipped }))
  }

  if (hasInput) {
    sendProgress('migrate', { percent: Math.round((migrated / total) * 100), status: t('migrate.mergingInput') })
    const result = await mergeDirFlat(srcInput, dstInput, (copied, skipped, fileTotal) => {
      const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1
      const percent = Math.round(((migrated + sub) / total) * 100)
      sendProgress('migrate', { percent, status: t('migrate.mergingInput') })
    })
    migrated++
    summary.push(t('migrate.summaryInput', { copied: result.copied, skipped: result.skipped }))
  }

  if (hasOutput) {
    sendProgress('migrate', { percent: Math.round((migrated / total) * 100), status: t('migrate.mergingOutput') })
    const result = await mergeDirFlat(srcOutput, dstOutput, (copied, skipped, fileTotal) => {
      const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1
      const percent = Math.round(((migrated + sub) / total) * 100)
      sendProgress('migrate', { percent, status: t('migrate.mergingOutput') })
    })
    migrated++
    summary.push(t('migrate.summaryOutput', { copied: result.copied, skipped: result.skipped }))
  }

  sendProgress('migrate', { percent: 100, status: t('common.done') })

  if (wantNodes) {
    sendProgress('deps', { percent: 0, status: t('migrate.checkingDeps') })

    const nodesWithReqs = migratedNodes.filter((n) => n.hasRequirements)
    if (nodesWithReqs.length === 0) {
      sendProgress('deps', { percent: 100, status: t('migrate.noDeps') })
    } else {
      const uvPath = getUvPath(installation.installPath)
      const activePython = getActivePythonPath(installation)

      if (!fs.existsSync(uvPath) || !activePython) {
        sendOutput(t('migrate.noUvOrPython') + '\n')
        sendProgress('deps', { percent: 100, status: t('migrate.depsSkipped') })
      } else {
        const migrateMirror = settings.get('pypiMirror')
        let depsInstalled = 0

        for (const node of nodesWithReqs) {
          const nodReqPath = path.join(dstCustomNodes, node.name, 'requirements.txt')
          sendProgress('deps', {
            percent: Math.round((depsInstalled / nodesWithReqs.length) * 100),
            status: t('migrate.installingNodeDeps', { name: node.name }),
          })

          try {
            const procResult = await installFilteredRequirements(nodReqPath, uvPath, activePython, installation.installPath, `.migrate-reqs-${node.name}.txt`, sendOutput, undefined, { pypiMirror: migrateMirror, useChineseMirrors: settings.get('useChineseMirrors') === true })
            if (procResult !== 0) {
              sendOutput(`\n⚠ ${node.name}: dependency install exited with code ${procResult}\n`)
            }
          } catch (err) {
            sendOutput(`⚠ ${node.name}: ${(err as Error).message}\n`)
          }

          depsInstalled++
        }

        sendProgress('deps', { percent: 100, status: t('migrate.depsComplete') })
        summary.push(t('migrate.summaryDeps', { count: nodesWithReqs.length }))
      }
    }
  }

  // Install manager_requirements.txt from destination ComfyUI if present
  {
    const dstComfyUIDir = path.join(installation.installPath, 'ComfyUI')
    const mgrReqPath = path.join(dstComfyUIDir, 'manager_requirements.txt')
    if (fs.existsSync(mgrReqPath)) {
      const uvPath = getUvPath(installation.installPath)
      const activePython = getActivePythonPath(installation)

      if (fs.existsSync(uvPath) && activePython) {
        sendOutput('\nInstalling manager requirements…\n')
        const procResult = await installFilteredRequirements(mgrReqPath, uvPath, activePython, installation.installPath, '.migrate-mgr-reqs.txt', sendOutput, undefined, settings.getMirrorConfig())
        if (procResult !== 0) {
          sendOutput(`\n⚠ manager requirements install exited with code ${procResult}\n`)
        }
      }
    }
  }

  sendProgress('done', { percent: 100, status: 'Complete' })
  sendOutput(`\n✓ ${t('migrate.complete')}: ${summary.join(', ')}\n`)

  return { ok: true, navigate: 'detail' }
}
