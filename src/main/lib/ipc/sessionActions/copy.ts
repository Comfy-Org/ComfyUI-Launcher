import {
  path, fs,
  installations, settings, i18n,
  deleteDir, formatTime,
  download, createCache, extract,
  MARKER_FILE,
  _operationAborts,
  sourceMap, findDuplicatePath, uniqueName,
  performCopy, copyBrowserPartition,
  makeSendProgress, makeSendOutput,
} from '../shared'
import type { FieldOption, InstallationRecord } from '../shared'
import type { ActionContext, ActionResult } from './types'

export async function handleCopy({ event, installationId, inst, actionData }: ActionContext): Promise<ActionResult> {
  const name = actionData?.name as string | undefined
  if (!name) return { ok: false, message: 'No name provided.' }
  if (!inst.installPath || !fs.existsSync(inst.installPath)) {
    return { ok: false, message: i18n.t('errors.dirNotExist', { path: inst.installPath || '' }) }
  }
  if (_operationAborts.has(installationId)) {
    return { ok: false, message: 'Another operation is already running for this installation.' }
  }

  const sender = event.sender
  const sendProgress = makeSendProgress(sender, installationId)

  const abort = new AbortController()
  _operationAborts.set(installationId, abort)

  try {
    await performCopy(inst, name, sendProgress, abort.signal)
    _operationAborts.delete(installationId)
    sendProgress('done', { percent: 100, status: 'Complete' })
    return { ok: true, navigate: 'list' }
  } catch (err) {
    _operationAborts.delete(installationId)
    if (abort.signal.aborted) return { ok: true, navigate: 'detail' }
    return { ok: false, message: (err as Error).message }
  }
}

export async function handleCopyUpdate({ event, installationId, inst, actionData }: ActionContext): Promise<ActionResult> {
  const name = actionData?.name as string | undefined
  if (!name) return { ok: false, message: 'No name provided.' }
  if (!inst.installPath || !fs.existsSync(inst.installPath)) {
    return { ok: false, message: i18n.t('errors.dirNotExist', { path: inst.installPath || '' }) }
  }
  if (_operationAborts.has(installationId)) {
    return { ok: false, message: 'Another operation is already running for this installation.' }
  }

  const sender = event.sender
  const sendProgress = makeSendProgress(sender, installationId)
  const sendOutput = makeSendOutput(sender, installationId)

  const abort = new AbortController()
  _operationAborts.set(installationId, abort)

  try {
    sendProgress('steps', { steps: [
      { phase: 'copy', label: i18n.t('actions.copyingFiles') },
      { phase: 'prepare', label: i18n.t('standalone.updatePrepare') },
      { phase: 'run', label: i18n.t('standalone.updateRun') },
      { phase: 'deps', label: i18n.t('standalone.updateDeps') },
    ] })

    const { entry } = await performCopy(inst, name, sendProgress, abort.signal, 'copy-update')

    const targetChannel = actionData?.channel as string | undefined
    if (targetChannel) {
      await installations.update(entry.id, { updateChannel: targetChannel })
    }

    const updateSendProgress = (phase: string, detail: Record<string, unknown>): void => {
      if (phase !== 'steps') sendProgress(phase, detail)
    }
    try {
      const source = sourceMap[inst.sourceId]
      if (!source) throw new Error(i18n.t('errors.unknownSource'))
      const newInst = await installations.get(entry.id)
      const newUpdate = (data: Record<string, unknown>): Promise<void> =>
        installations.update(entry.id, data).then(() => {})
      const updateResult = await source.handleAction('update-comfyui', newInst!, {}, {
        update: newUpdate,
        sendProgress: updateSendProgress,
        sendOutput,
        signal: abort.signal,
      })
      if (updateResult && !updateResult.ok) {
        sendOutput(`\n⚠ Update: ${updateResult.message}\n`)
        sendOutput('The copy was created successfully. You can retry the update from the new installation.\n')
      }
    } catch (updateErr) {
      sendOutput(`\n⚠ Update failed: ${(updateErr as Error).message}\n`)
      sendOutput('The copy was created successfully. You can retry the update from the new installation.\n')
    }

    _operationAborts.delete(installationId)
    return { ok: true, navigate: 'list' }
  } catch (err) {
    _operationAborts.delete(installationId)
    if (abort.signal.aborted) return { ok: true, navigate: 'detail' }
    return { ok: false, message: (err as Error).message }
  }
}

export async function handleReleaseUpdate({ event, installationId, inst, actionData }: ActionContext): Promise<ActionResult> {
  const name = actionData?.name as string | undefined
  const releaseSelection = actionData?.releaseSelection as Record<string, unknown> | undefined
  const variantSelection = actionData?.variantSelection as Record<string, unknown> | undefined
  if (!name || !releaseSelection || !variantSelection) {
    return { ok: false, message: 'Missing required selections.' }
  }
  if (!inst.installPath || !fs.existsSync(inst.installPath)) {
    return { ok: false, message: i18n.t('errors.dirNotExist', { path: inst.installPath || '' }) }
  }
  if (_operationAborts.has(installationId)) {
    return { ok: false, message: 'Another operation is already running for this installation.' }
  }

  const source = sourceMap[inst.sourceId]
  if (!source) return { ok: false, message: i18n.t('errors.unknownSource') }
  const installData = source.buildInstallation({
    release: releaseSelection as unknown as FieldOption,
    variant: variantSelection as unknown as FieldOption,
  })

  const parentDir = path.dirname(inst.installPath)
  const dirName = name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'ComfyUI'
  let destPath = path.join(parentDir, dirName)
  let suffix = 1
  while (fs.existsSync(destPath)) {
    destPath = path.join(parentDir, `${dirName} (${suffix})`)
    suffix++
  }

  const duplicate = await findDuplicatePath(destPath)
  if (duplicate) {
    return { ok: false, message: `That directory is already used by "${duplicate.name}".` }
  }

  const sender = event.sender
  const sendProgress = makeSendProgress(sender, installationId)
  const sendOutput = makeSendOutput(sender, installationId)

  const abort = new AbortController()
  _operationAborts.set(installationId, abort)

  sendProgress('steps', { steps: [
    { phase: 'download', label: i18n.t('common.download') },
    { phase: 'extract', label: i18n.t('common.extract') },
    { phase: 'setup', label: i18n.t('standalone.setupEnv') },
    { phase: 'migrate', label: i18n.t('migrate.filePhase') },
    { phase: 'deps', label: i18n.t('migrate.depsPhase') },
  ] })

  let entry: InstallationRecord | null = null
  let installComplete = false
  try {
    fs.mkdirSync(destPath, { recursive: true })
    const installRecord = { ...installData, installPath: destPath } as InstallationRecord
    const cache = createCache(settings.get('cacheDir') as string, settings.get('maxCachedFiles') as number)
    await source.install!(installRecord, { sendProgress, download, cache, extract, signal: abort.signal })

    const finalName = await uniqueName(name)
    entry = await installations.add({
      sourceId: inst.sourceId,
      sourceLabel: source.label,
      ...installData,
      name: finalName,
      installPath: destPath,
      status: 'installed',
      seen: false,
      browserPartition: 'unique',
      copiedFrom: inst.id,
      copiedFromName: inst.name,
      copiedAt: new Date().toISOString(),
      copyReason: 'release-update' as const,
    })
    try { fs.writeFileSync(path.join(destPath, MARKER_FILE), entry.id) } catch {}
    await copyBrowserPartition(inst.id, entry.id, inst.browserPartition as string | undefined)

    const newUpdate = (data: Record<string, unknown>): Promise<void> =>
      installations.update(entry!.id, data).then(() => {})
    await source.postInstall!(installRecord, { sendProgress, update: newUpdate, signal: abort.signal })
    installComplete = true

    const newInst = await installations.get(entry.id)
    const migrateSendProgress = (phase: string, detail: Record<string, unknown>): void => {
      if (phase !== 'steps' && phase !== 'done') sendProgress(phase, detail)
    }
    const migrateData = {
      sourceInstallationId: inst.id,
      customNodes: true,
      allUserData: true,
      models: true,
      input: true,
      output: true,
    }
    let migrateError: string | null = null
    try {
      const migrateResult = await source.handleAction('migrate-from', newInst!, migrateData, {
        update: newUpdate,
        sendProgress: migrateSendProgress,
        sendOutput,
        signal: abort.signal,
      })
      if (migrateResult && !migrateResult.ok) {
        migrateError = migrateResult.message || 'Unknown migration error'
      }
    } catch (migrateErr) {
      migrateError = (migrateErr as Error).message
    }

    _operationAborts.delete(installationId)
    if (migrateError) {
      sendOutput(`\n⚠ ${migrateError}\n`)
      sendProgress('migrate', { percent: -1, status: i18n.t('standalone.releaseUpdateCleaningUp') })
      try { await installations.remove(entry.id) } catch {}
      try {
        await deleteDir(destPath, (p) => {
          const elapsed = formatTime(p.elapsedSecs)
          const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : '—'
          sendProgress('migrate', {
            percent: p.percent,
            status: `${i18n.t('standalone.releaseUpdateCleaningUp')}  ${p.deleted} / ${p.total}  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
          })
        })
      } catch {}
      return { ok: false, message: migrateError }
    }
    sendProgress('done', { percent: 100, status: 'Complete' })
    return { ok: true, navigate: 'list' }
  } catch (err) {
    _operationAborts.delete(installationId)
    if (!installComplete) {
      if (entry) try { await installations.remove(entry.id) } catch {}
      try { await fs.promises.rm(destPath, { recursive: true, force: true }) } catch {}
    }
    if (abort.signal.aborted) return { ok: true, navigate: installComplete ? 'list' : 'detail' }
    return { ok: false, message: (err as Error).message }
  }
}
