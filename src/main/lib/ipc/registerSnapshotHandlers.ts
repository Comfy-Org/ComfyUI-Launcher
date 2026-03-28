import {
  path, fs, os, ipcMain, dialog, BrowserWindow,
  installations, i18n,
  sourceMap,
  findLatestVersionTag, revParseRef, hasGitDir,
  defaultInstallDir,
  detectGPU, detectDesktopInstall, stageDesktopSnapshot, stageLocalSnapshot,
  getSnapshotCount, getSnapshotListData, getSnapshotDetailData,
  getSnapshotDiffVsPrevious, diffAgainstCurrent, loadSnapshot, listSnapshots,
  buildExportEnvelope, validateExportEnvelope, importSnapshots,
  resolveSnapshotVersion, getVariantLabel,
  findDuplicatePath, uniqueName, ensureDefaultPrimary,
} from './shared'
import type {
  LatestTagOverride, SnapshotExportEnvelope, FieldOption,
} from './shared'

async function _findReferenceRepo(): Promise<{ comfyuiDir: string; override?: LatestTagOverride } | null> {
  const all = await installations.list()
  for (const inst of all) {
    if (!inst.installPath) continue
    const comfyuiDir = path.join(inst.installPath, 'ComfyUI')
    if (!hasGitDir(comfyuiDir)) continue
    const tagName = await findLatestVersionTag(comfyuiDir)
    if (tagName) {
      const sha = await revParseRef(comfyuiDir, tagName)
      if (sha) return { comfyuiDir, override: { name: tagName, sha } }
    }
    return { comfyuiDir }
  }
  return null
}

async function buildSnapshotPreview(filePath: string, envelope: SnapshotExportEnvelope): Promise<Record<string, unknown>> {
  const ref = await _findReferenceRepo()
  const resolveOpts = ref ? { comfyuiDir: ref.comfyuiDir, latestTagOverride: ref.override } : undefined

  const resolveVersion = (comfyui: { ref: string; commit: string | null; baseTag?: string; commitsAhead?: number }, style: 'short' | 'detail'): Promise<string> =>
    resolveSnapshotVersion('', comfyui, style, resolveOpts)

  const newest = envelope.snapshots[0]!
  const resolvedVersions = await Promise.all(
    envelope.snapshots.map((s) => resolveVersion(s.comfyui, 'short'))
  )
  const snapshots = envelope.snapshots.map((s, i) => ({
    filename: `imported-${i}`,
    createdAt: s.createdAt,
    trigger: s.trigger,
    label: s.label,
    comfyuiVersion: resolvedVersions[i]!,
    nodeCount: s.customNodes.length,
    pipPackageCount: Object.keys(s.pipPackages).length,
  }))
  return {
    filePath,
    installationName: envelope.installationName,
    snapshotCount: envelope.snapshots.length,
    snapshots,
    newestSnapshot: {
      filename: 'imported-0',
      createdAt: newest.createdAt,
      trigger: newest.trigger,
      label: newest.label,
      comfyuiVersion: await resolveVersion(newest.comfyui, 'detail'),
      comfyui: newest.comfyui,
      pythonVersion: newest.pythonVersion,
      updateChannel: newest.updateChannel,
      customNodes: newest.customNodes.map((n) => ({
        id: n.id,
        type: n.type,
        dirName: n.dirName,
        enabled: n.enabled,
        version: n.version,
        commit: n.commit,
        url: n.url,
      })),
      pipPackageCount: Object.keys(newest.pipPackages).length,
      pipPackages: newest.pipPackages,
    },
  }
}

export function registerSnapshotHandlers(): void {
  ipcMain.handle('get-snapshots', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) return { snapshots: [], copyEvents: [], totalCount: 0, context: { updateChannel: '', pythonVersion: '', variant: '', variantLabel: '' } }
    const data = await getSnapshotListData(inst.installPath)

    const allInstalls = await installations.list()
    const copyEvents = allInstalls
      .filter((i) => (i.copiedFrom as string | undefined) === installationId && (i.copiedAt as string | undefined))
      .map((i) => ({
        installationId: i.id,
        installationName: i.name,
        copiedAt: i.copiedAt as string,
        copyReason: (i.copyReason as 'copy' | 'copy-update' | 'release-update') || 'copy',
        exists: true,
      }))

    return {
      ...data,
      copyEvents,
      context: {
        updateChannel: (inst.updateChannel as string | undefined) || 'stable',
        pythonVersion: (inst.pythonVersion as string | undefined) || '',
        variant: (inst.variant as string | undefined) || '',
        variantLabel: (inst.variant as string | undefined) ? getVariantLabel(inst.variant as string) : '',
      },
    }
  })

  ipcMain.handle('get-snapshot-detail', async (_event, installationId: string, filename: string) => {
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) throw new Error('Installation not found or has no install path')
    const detail = await getSnapshotDetailData(inst.installPath, filename)
    if (!detail.pythonVersion) detail.pythonVersion = (inst.pythonVersion as string | undefined) || undefined
    if (!detail.updateChannel) detail.updateChannel = (inst.updateChannel as string | undefined) || undefined
    return detail
  })

  ipcMain.handle('get-snapshot-diff', async (_event, installationId: string, filename: string, mode: 'previous' | 'current') => {
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) throw new Error('Installation not found or has no install path')
    if (mode === 'previous') {
      return getSnapshotDiffVsPrevious(inst.installPath, filename)
    }
    const target = await loadSnapshot(inst.installPath, filename)
    const diff = await diffAgainstCurrent(inst.installPath, inst, target)
    const empty = !diff.comfyuiChanged && !diff.updateChannelChanged && diff.nodesAdded.length === 0 && diff.nodesRemoved.length === 0 &&
                  diff.nodesChanged.length === 0 && diff.pipsAdded.length === 0 && diff.pipsRemoved.length === 0 &&
                  diff.pipsChanged.length === 0
    return { mode: 'current' as const, baseLabel: 'Current state', diff, empty }
  })

  ipcMain.handle('export-snapshot', async (_event, installationId: string, filename: string) => {
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) return { ok: false, message: 'Installation not found.' }
    const snapshot = await loadSnapshot(inst.installPath, filename)
    const envelope = buildExportEnvelope(inst.name, [{ filename, snapshot }])
    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return { ok: false, message: 'No window.' }
    const safeName = inst.name.replace(/[<>:"/\\|?*]+/g, '_')
    const dateStr = snapshot.createdAt.slice(0, 10).replace(/-/g, '')
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `snapshot-${safeName}-${snapshot.trigger}-${dateStr}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { ok: false }
    await fs.promises.writeFile(filePath, JSON.stringify(envelope, null, 2))
    return { ok: true }
  })

  ipcMain.handle('export-all-snapshots', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) return { ok: false, message: 'Installation not found.' }
    const entries = await listSnapshots(inst.installPath)
    if (entries.length === 0) return { ok: false, message: 'No snapshots to export.' }
    const envelope = buildExportEnvelope(inst.name, entries)
    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return { ok: false, message: 'No window.' }
    const safeName = inst.name.replace(/[<>:"/\\|?*]+/g, '_')
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `snapshots-${safeName}-${dateStr}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { ok: false }
    await fs.promises.writeFile(filePath, JSON.stringify(envelope, null, 2))
    return { ok: true }
  })

  ipcMain.handle('import-snapshots', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) return { ok: false, message: 'Installation not found.' }
    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return { ok: false, message: 'No window.' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (canceled || filePaths.length === 0) return { ok: false }
    const content = await fs.promises.readFile(filePaths[0]!, 'utf-8')
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch { return { ok: false, message: 'Invalid JSON file.' } }
    let envelope
    try { envelope = validateExportEnvelope(parsed) } catch (err) { return { ok: false, message: (err as Error).message } }
    const result = await importSnapshots(inst.installPath, envelope)
    const snapshotCount = await getSnapshotCount(inst.installPath)
    const allSnapshots = await listSnapshots(inst.installPath)
    const lastSnapshot = allSnapshots.length > 0 ? allSnapshots[0]!.filename : null
    await installations.update(installationId, { snapshotCount, ...(lastSnapshot ? { lastSnapshot } : {}) })
    return { ok: true, imported: result.imported, skipped: result.skipped }
  })

  let _lastDesktopPreviewFile: string | null = null

  ipcMain.handle('preview-desktop-migration', async () => {
    try {
      if (_lastDesktopPreviewFile) {
        fs.promises.unlink(_lastDesktopPreviewFile).catch(() => {})
        _lastDesktopPreviewFile = null
      }

      const desktopInfo = detectDesktopInstall()
      if (!desktopInfo) return { ok: false, message: i18n.t('desktop.notFound') }

      const { envelope, stagedFile } = await stageDesktopSnapshot(desktopInfo)

      _lastDesktopPreviewFile = stagedFile
      return { ok: true, preview: await buildSnapshotPreview(stagedFile, envelope), snapshotPath: stagedFile }
    } catch (err) {
      console.warn('preview-desktop-migration failed:', err)
      return { ok: false, message: (err as Error)?.message ?? String(err) }
    }
  })

  const _lastLocalPreviewFiles = new Map<string, string>()
  ipcMain.handle('preview-local-migration', async (_event, installationId: string) => {
    try {
      const prev = _lastLocalPreviewFiles.get(installationId)
      if (prev) {
        fs.promises.unlink(prev).catch(() => {})
        _lastLocalPreviewFiles.delete(installationId)
      }

      const inst = await installations.get(installationId)
      if (!inst) return { ok: false, message: 'Installation not found.' }

      const { envelope, stagedFile } = await stageLocalSnapshot(
        inst.installPath,
        inst.sourceId as string,
        inst.name,
      )

      _lastLocalPreviewFiles.set(installationId, stagedFile)
      return { ok: true, preview: await buildSnapshotPreview(stagedFile, envelope), snapshotPath: stagedFile }
    } catch (err) {
      console.warn('preview-local-migration failed:', err)
      return { ok: false, message: (err as Error)?.message ?? String(err) }
    }
  })

  ipcMain.handle('preview-snapshot-file', async (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return { ok: false, message: 'No window.' }

    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Snapshot', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (canceled || filePaths.length === 0) return { ok: false }

    const content = await fs.promises.readFile(filePaths[0]!, 'utf-8')
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch { return { ok: false, message: 'Invalid JSON file.' } }
    let envelope: SnapshotExportEnvelope
    try { envelope = validateExportEnvelope(parsed) } catch (err) { return { ok: false, message: (err as Error).message } }

    return { ok: true, preview: await buildSnapshotPreview(filePaths[0]!, envelope) }
  })

  ipcMain.handle('preview-snapshot-path', async (_event, filePath: string) => {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, message: 'Snapshot file not found.' }

    const content = await fs.promises.readFile(filePath, 'utf-8')
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch { return { ok: false, message: 'Invalid JSON file.' } }
    let envelope: SnapshotExportEnvelope
    try { envelope = validateExportEnvelope(parsed) } catch (err) { return { ok: false, message: (err as Error).message } }

    return { ok: true, preview: await buildSnapshotPreview(filePath, envelope) }
  })

  ipcMain.handle('create-from-snapshot', async (_event, filePath: string, customName?: string, releaseTag?: string, variantId?: string) => {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, message: 'Snapshot file not found.' }

    const content = await fs.promises.readFile(filePath, 'utf-8')
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch { return { ok: false, message: 'Invalid JSON file.' } }
    let envelope: SnapshotExportEnvelope
    try { envelope = validateExportEnvelope(parsed) } catch (err) { return { ok: false, message: (err as Error).message } }

    const targetSnapshot = envelope.snapshots[0]!
    const snapshotVariant = targetSnapshot.comfyui.variant || ''

    const platformPrefix: Record<string, string> = { win32: 'win-', darwin: 'mac-', linux: 'linux-' }
    const prefix = platformPrefix[process.platform]
    if (!prefix) return { ok: false, message: `Unsupported platform: ${process.platform}` }
    const strippedVariant = snapshotVariant.replace(/^(win|mac|linux)-/, '')
    const baseGpu = strippedVariant.replace(/-.*$/, '')

    const source = sourceMap['standalone']!
    const releaseOptions = await source.getFieldOptions!('release', {}, {})
    if (releaseOptions.length === 0) return { ok: false, message: 'No releases available.' }

    let selectedRelease: FieldOption
    if (releaseTag) {
      const match = releaseOptions.find((r) => r.value === releaseTag)
      if (!match) return { ok: false, message: `Release "${releaseTag}" is no longer available.` }
      selectedRelease = match
    } else {
      console.warn('No releaseTag specified for create-from-snapshot, falling back to latest release.')
      selectedRelease = releaseOptions[0]!
    }

    const gpu = await detectGPU()
    const variantOptions = await source.getFieldOptions!('variant', { release: selectedRelease }, { gpu: gpu?.id })
    if (variantOptions.length === 0) return { ok: false, message: 'No compatible variants found for this platform.' }

    let matched: FieldOption | undefined
    if (variantId) {
      matched = variantOptions.find((v) => (v.data?.variantId as string) === variantId)
      if (!matched) return { ok: false, message: `Variant "${variantId}" is not available for the selected release.` }
    } else {
      const localVariant = prefix + strippedVariant
      matched = variantOptions.find((v) => (v.data?.variantId as string) === localVariant)
      if (!matched) {
        matched = variantOptions.find((v) => {
          const vid = ((v.data?.variantId as string) || '').replace(/^(win|mac|linux)-/, '')
          return vid === baseGpu || vid.startsWith(baseGpu + '-')
        })
      }
      if (!matched) matched = variantOptions.find((v) => v.recommended)
      if (!matched) matched = variantOptions[0]!
    }

    const instData = {
      sourceId: source.id,
      sourceLabel: source.label,
      ...source.buildInstallation({ release: selectedRelease, variant: matched }),
    }
    const baseName = customName || envelope.installationName || 'ComfyUI'
    const name = await uniqueName(baseName)
    const dirName = name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'ComfyUI'
    const installDir = defaultInstallDir()
    let installPath = path.join(installDir, dirName)
    let suffix = 1
    while (fs.existsSync(installPath)) {
      installPath = path.join(installDir, `${dirName} (${suffix})`)
      suffix++
    }

    const duplicate = await findDuplicatePath(installPath)
    if (duplicate) return { ok: false, message: `Directory already used by "${duplicate.name}".` }

    const stagingDir = path.join(os.tmpdir(), 'comfyui-desktop-2-snapshots')
    await fs.promises.mkdir(stagingDir, { recursive: true })
    const stagedFile = path.join(stagingDir, `pending-${Date.now()}.json`)
    await fs.promises.copyFile(filePath, stagedFile)

    const entry = await installations.add({
      name,
      installPath,
      pendingSnapshotRestore: stagedFile,
      ...instData,
      seen: false,
    })
    ensureDefaultPrimary(entry)

    return { ok: true, entry: { id: entry.id, name: entry.name } }
  })
}
