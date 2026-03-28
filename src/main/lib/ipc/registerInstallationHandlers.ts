import {
  path, fs, ipcMain,
  sources, installations, settings, i18n,
  sourceMap, formatComfyVersion, _resolveAndBroadcastVersions,
  isPromotableLocal, ensureDefaultPrimary, findDuplicatePath, uniqueName,
  syncOemSeedBestEffort, isEffectivelyEmptyInstallDir,
  download, createCache, extract, deleteDir, deleteAction, untrackAction,
  formatTime, MARKER_FILE,
  validateExportEnvelope, importSnapshots, saveSnapshot, getSnapshotCount,
  restoreCustomNodes, restorePipPackages, restoreComfyUIVersion, buildPostRestoreState,
  _operationAborts,
  sanitizeEnvVars,
  getComfyArgsSchema,
} from './shared'
import type { ComfyVersion, ComfyArgDef } from './shared'

export function registerInstallationHandlers(): void {
  // Installations
  ipcMain.handle('get-installations', async () => {
    const allInstalls = await installations.list()

    // Hide source installs that have been migrated to standalone, as long as
    // at least one child install (with copiedFrom pointing to them) still exists.
    const migratedSourceIds = new Set(
      allInstalls
        .filter((i) => (i.copyReason as string | undefined) === 'standalone-migration' && i.status !== 'installing')
        .map((i) => i.copiedFrom as string)
        .filter(Boolean)
    )
    const list = allInstalls.filter((i) => i.status !== 'installing' && !migratedSourceIds.has(i.id))

    // Ensure a primary is always set when promotable local installs exist
    const currentPrimary = settings.get('primaryInstallId')
    if (!currentPrimary || !list.some((i) => i.id === currentPrimary)) {
      const firstLocal = list.find((i) => isPromotableLocal(i.sourceId))
      const newPrimary = firstLocal?.id
      if (currentPrimary !== newPrimary) {
        settings.set('primaryInstallId', newPrimary)
      }
    }

    const result = list.map((inst) => {
      const source = sourceMap[inst.sourceId]
      if (!source) return inst
      const listPreview = source.getListPreview ? source.getListPreview(inst) : undefined
      const statusTag = inst.status === 'partial-delete'
        ? { label: i18n.t('errors.deleteInterrupted'), style: 'danger' }
        : inst.status === 'failed'
        ? { label: i18n.t('errors.installFailed'), style: 'danger' }
        : (source.getStatusTag ? source.getStatusTag(inst) : undefined)
      const cv = inst.comfyVersion as ComfyVersion | undefined
      const rawVersion = cv ? formatComfyVersion(cv, 'short') : (inst.version as string | undefined)
      const version = rawVersion === inst.sourceId ? undefined : rawVersion
      return {
        ...inst,
        version,
        sourceLabel: source.label,
        sourceCategory: source.category,
        hasConsole: source.hasConsole !== false,
        ...(listPreview != null ? { listPreview } : {}),
        ...(statusTag ? { statusTag } : {}),
      }
    })

    // Resolve versions from git state in the background
    _resolveAndBroadcastVersions(list).catch(() => {})

    return result
  })

  ipcMain.handle('get-unique-name', async (_event, baseName: string) => {
    return uniqueName(baseName)
  })

  ipcMain.handle('add-installation', async (_event, data: Record<string, unknown>) => {
    data.name = await uniqueName((data.name as string) || 'ComfyUI')
    if (data.installPath) {
      const dirName = (data.name as string).replace(/[<>:"/\\|?*]+/g, '_').trim() || 'ComfyUI'
      let installPath = path.join(data.installPath as string, dirName)
      let suffix = 1
      while (fs.existsSync(installPath)) {
        installPath = path.join(data.installPath as string, `${dirName} (${suffix})`)
        suffix++
      }
      data.installPath = installPath
      const duplicate = await findDuplicatePath(data.installPath as string)
      if (duplicate) {
        return { ok: false, message: `That directory is already used by "${duplicate.name}".` }
      }
    }
    const entry = await installations.add({ ...data, seen: false })
    ensureDefaultPrimary(entry)
    return { ok: true, entry }
  })

  ipcMain.handle('reorder-installations', async (_event, orderedIds: string[]) => {
    await installations.reorder(orderedIds)
  })

  ipcMain.handle('probe-installation', async (_event, dirPath: string) => {
    const results: Record<string, unknown>[] = []
    for (const source of sources) {
      if (source.probeInstallation) {
        const data = await source.probeInstallation(dirPath)
        if (data) {
          results.push({ sourceId: source.id, sourceLabel: source.label, ...data })
        }
      }
    }
    return results
  })

  ipcMain.handle('track-installation', async (_event, data: Record<string, unknown>) => {
    const duplicate = await findDuplicatePath(data.installPath as string)
    if (duplicate) {
      return { ok: false, message: `That directory is already used by "${duplicate.name}".` }
    }
    if (!fs.existsSync(data.installPath as string)) {
      return { ok: false, message: 'That directory does not exist.' }
    }
    try {
      fs.writeFileSync(path.join(data.installPath as string, MARKER_FILE), 'tracked')
    } catch (err) {
      return { ok: false, message: `Cannot write to directory: ${(err as Error).message}` }
    }
    const entry = await installations.add({ ...data, status: 'installed', seen: false })
    ensureDefaultPrimary(entry)
    await syncOemSeedBestEffort()
    return { ok: true, entry }
  })

  ipcMain.handle('install-instance', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst) return { ok: false, message: 'Installation not found.' }
    const source = sourceMap[inst.sourceId]
    if (!source) return { ok: false, message: i18n.t('errors.unknownSource') }
    if (_operationAborts.has(installationId)) {
      return { ok: false, message: 'Another operation is already running for this installation.' }
    }
    const sender = _event.sender

    const sendProgress = (phase: string, detail: Record<string, unknown>): void => {
      if (!sender.isDestroyed()) {
        sender.send('install-progress', { installationId, phase, ...detail })
      }
    }

    if (source.install) {
      fs.mkdirSync(inst.installPath, { recursive: true })
      fs.writeFileSync(path.join(inst.installPath, MARKER_FILE), installationId)
      if (source.installSteps) {
        let steps = [...source.installSteps]
        if (!inst.autoUpdateComfyUI) {
          steps = steps.filter((s) => s.phase !== 'update')
        }
        if (inst.pendingSnapshotRestore) {
          steps.push(
            { phase: 'restore-nodes', label: i18n.t('standalone.snapshotRestoreNodesPhase') },
            { phase: 'restore-pip', label: i18n.t('standalone.snapshotRestorePipPhase') },
          )
        }
        sendProgress('steps', { steps })
      }
      const abort = new AbortController()
      _operationAborts.set(installationId, abort)
      const cache = createCache(settings.get('cacheDir') as string, settings.get('maxCachedFiles') as number)
      try {
        await source.install(inst, { sendProgress, download, cache, extract, signal: abort.signal })
        if (source.postInstall) {
          const update = (data: Record<string, unknown>): Promise<void> =>
            installations.update(installationId, data).then(() => {})
          await source.postInstall(inst, { sendProgress, update, signal: abort.signal })
        }

        // After postInstall, check for pending snapshot restore
        const freshInst = await installations.get(installationId)
        const pendingFile = freshInst?.pendingSnapshotRestore as string | undefined
        if (freshInst && pendingFile && fs.existsSync(pendingFile)) {
          const sendOutput = (text: string): void => {
            try { if (!sender.isDestroyed()) sender.send('comfy-output', { installationId, text }) } catch {}
          }
          const update = (data: Record<string, unknown>): Promise<void> =>
            installations.update(installationId, data).then(() => {})

          try {
            const fileContent = await fs.promises.readFile(pendingFile, 'utf-8')
            const envelope = validateExportEnvelope(JSON.parse(fileContent))
            await importSnapshots(freshInst.installPath, envelope)
            const targetSnapshot = envelope.snapshots[0]!

            // Restore ComfyUI version
            sendOutput('\n── Restore ComfyUI Version ──\n')
            const comfyResult = await restoreComfyUIVersion(freshInst.installPath, targetSnapshot, sendOutput)

            sendOutput('\n── Restore Nodes ──\n')
            await restoreCustomNodes(freshInst.installPath, freshInst, targetSnapshot, sendProgress, sendOutput, abort.signal, settings.getMirrorConfig())

            if (!abort.signal.aborted && !targetSnapshot.skipPipSync) {
              sendOutput('\n── Restore Packages ──\n')
              await restorePipPackages(freshInst.installPath, freshInst, targetSnapshot,
                (phase, data) => sendProgress(phase === 'restore' ? 'restore-pip' : phase, data),
                sendOutput, abort.signal, settings.getMirrorConfig())
            }

            const restoreState = buildPostRestoreState(
              targetSnapshot, comfyResult,
              freshInst.updateInfoByChannel as Record<string, Record<string, unknown>> | undefined,
              freshInst.comfyVersion as ComfyVersion | undefined
            )
            await update(restoreState)

            // Save post-restore snapshot
            try {
              const updatedInst = { ...freshInst, ...restoreState }
              const filename = await saveSnapshot(freshInst.installPath, updatedInst, 'post-restore')
              const snapshotCount = await getSnapshotCount(freshInst.installPath)
              await update({ pendingSnapshotRestore: undefined, lastSnapshot: filename, snapshotCount })
            } catch {
              await update({ pendingSnapshotRestore: undefined })
            }
          } catch (restoreErr) {
            console.warn('Post-install snapshot restore failed:', restoreErr)
            sendOutput(`\n⚠ Snapshot restore failed: ${(restoreErr as Error).message}\nThe installation completed successfully. You can restore the snapshot manually from the Snapshots tab.\n`)
            await update({ pendingSnapshotRestore: undefined })
          } finally {
            fs.promises.unlink(pendingFile).catch(() => {})
          }
        }

        sendProgress('done', { percent: 100, status: 'Complete' })
      } catch (err) {
        _operationAborts.delete(installationId)
        if (abort.signal.aborted) {
          let cleaned = !fs.existsSync(inst.installPath)
          if (!cleaned) {
            try {
              fs.rmSync(inst.installPath, { recursive: true, force: true })
              cleaned = true
            } catch {}
          }
          if (cleaned) {
            await installations.remove(installationId)
            return { ok: true, navigate: 'list' }
          }
          const markerPath = path.join(inst.installPath, MARKER_FILE)
          try { fs.writeFileSync(markerPath, installationId) } catch {}
          await installations.update(installationId, { status: 'partial-delete' })
          const deleteAbort = new AbortController()
          _operationAborts.set(installationId, deleteAbort)
          sendProgress('delete', { percent: 0, status: 'Counting files…' })
          try {
            await deleteDir(inst.installPath, (p) => {
              const elapsed = formatTime(p.elapsedSecs)
              const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : '—'
              sendProgress('delete', {
                percent: p.percent,
                status: `Deleting… ${p.deleted} / ${p.total} items  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
              })
            }, { signal: deleteAbort.signal })
            _operationAborts.delete(installationId)
            await installations.remove(installationId)
          } catch (_delErr) {
            _operationAborts.delete(installationId)
            if (deleteAbort.signal.aborted) {
              if (isEffectivelyEmptyInstallDir(inst.installPath)) {
                try { fs.rmSync(inst.installPath, { recursive: true, force: true }) } catch {}
                await installations.remove(installationId)
              } else {
                try { fs.writeFileSync(markerPath, installationId) } catch {}
                await installations.update(installationId, { status: 'partial-delete' })
              }
            }
          }
          return { ok: true, navigate: 'list' }
        }
        await installations.update(installationId, { status: 'failed' })
        return { ok: false, message: (err as Error).message }
      }
      _operationAborts.delete(installationId)
      await installations.update(installationId, { status: 'installed' })
      await syncOemSeedBestEffort()
      return { ok: true }
    }

    await installations.update(installationId, { status: 'failed' })
    return { ok: false, message: 'This source does not support installation.' }
  })

  // List actions
  ipcMain.handle('get-list-actions', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst) return []
    const source = sourceMap[inst.sourceId]
    if (!source) return []
    return source.getListActions ? source.getListActions(inst) : []
  })

  // Detail — validate editable fields dynamically from source schema
  ipcMain.handle('update-installation', async (_event, installationId: string, data: Record<string, unknown>) => {
    const inst = await installations.get(installationId)
    if (!inst) return { ok: false, message: 'Installation not found.' }
    const source = sourceMap[inst.sourceId]
    if (!source) return { ok: false, message: i18n.t('errors.unknownSource') }
    const sections = source.getDetailSections(inst)
    const allowedIds = new Set(['name', 'seen'])
    for (const section of sections) {
      const fields = (section as Record<string, unknown>).fields as Record<string, unknown>[] | undefined
      if (!fields) continue
      for (const f of fields) {
        if ((f as Record<string, unknown>).editable && (f as Record<string, unknown>).id) {
          allowedIds.add((f as Record<string, unknown>).id as string)
        }
      }
    }
    const filtered: Record<string, unknown> = {}
    for (const key of Object.keys(data)) {
      if (allowedIds.has(key)) {
        filtered[key] = key === 'envVars' ? sanitizeEnvVars(data[key]) : data[key]
      }
    }
    if (filtered.name && filtered.name !== inst.name) {
      const all = await installations.list()
      if (all.some((i) => i.id !== installationId && i.name === filtered.name)) {
        return { ok: false, message: i18n.t('errors.duplicateName', { name: filtered.name as string }) }
      }
    }
    await installations.update(installationId, filtered)
    return { ok: true }
  })

  ipcMain.handle('get-detail-sections', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst) return []
    const source = sourceMap[inst.sourceId]
    if (!source) {
      const actions = [untrackAction()]
      if (inst.installPath && fs.existsSync(inst.installPath)) {
        actions.unshift(deleteAction(inst))
      }
      return [
        {
          title: '',
          description: i18n.t('errors.unknownSource'),
        },
        {
          pinBottom: true,
          actions,
        },
      ]
    }
    return source.getDetailSections(inst)
  })

  ipcMain.handle('get-comfy-args', async (_event, installationId: string): Promise<{ args: ComfyArgDef[]; error?: string } | null> => {
    const inst = await installations.get(installationId)
    if (!inst) return { args: [], error: 'Installation not found' }
    const source = sourceMap[inst.sourceId]
    if (!source) return { args: [], error: `Unknown source: ${inst.sourceId}` }
    const launchCmd = source.getLaunchCommand(inst)
    if (!launchCmd?.cmd || !launchCmd.args || !launchCmd.cwd) {
      return { args: [], error: `No launch command available (source: ${inst.sourceId})` }
    }
    const sIdx = launchCmd.args.indexOf('-s')
    if (sIdx === -1 || sIdx + 1 >= launchCmd.args.length) {
      return { args: [], error: `No -s flag in launch args: [${launchCmd.args.join(', ')}]` }
    }
    const mainPyRel = launchCmd.args[sIdx + 1]!
    const mainPyAbs = path.resolve(launchCmd.cwd, mainPyRel)
    try {
      const schema = await getComfyArgsSchema(launchCmd.cmd, mainPyAbs, launchCmd.cwd, installationId, inst.version as string | undefined)
      return { args: schema.args }
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      console.warn('[get-comfy-args] Failed to get schema:', msg)
      return { args: [], error: msg }
    }
  })
}
