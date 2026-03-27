import {
  fs,
  installations,
  performDesktopMigration, performLocalMigration,
  _operationAborts,
  sourceMap, uniqueName, ensureDefaultPrimary,
  makeSendProgress, makeSendOutput,
} from '../shared'
import type { InstallationRecord } from '../shared'
import type { ActionContext, ActionResult } from './types'

export async function handleMigrateToStandalone({ event, installationId, inst, actionData }: ActionContext): Promise<ActionResult> {
  if (_operationAborts.has(installationId)) {
    return { ok: false, message: 'Another operation is already running for this installation.' }
  }

  const sender = event.sender
  const sendProgress = makeSendProgress(sender, installationId)
  const sendOutput = makeSendOutput(sender, installationId)

  const abort = new AbortController()
  _operationAborts.set(installationId, abort)

  let entry: InstallationRecord | null = null
  let destPath = ''
  try {
    const migrationTools = {
      sendProgress,
      sendOutput,
      signal: abort.signal,
      sourceMap,
      uniqueName,
      ensureDefaultPrimary,
    }
    const result = inst.sourceId === 'desktop'
      ? await performDesktopMigration(actionData, migrationTools, { id: inst.id, name: inst.name })
      : await performLocalMigration(inst, actionData, migrationTools)
    entry = result.entry
    destPath = result.destPath

    _operationAborts.delete(installationId)
    sendProgress('done', { percent: 100, status: 'Complete' })
    return { ok: true, navigate: 'list' }
  } catch (err) {
    _operationAborts.delete(installationId)
    if (entry) {
      try { await installations.remove(entry.id) } catch {}
    }
    if (destPath && fs.existsSync(destPath)) {
      try { await fs.promises.rm(destPath, { recursive: true, force: true }) } catch {}
    }
    if (abort.signal.aborted) return { ok: true, navigate: 'detail' }
    return { ok: false, message: (err as Error).message }
  }
}
