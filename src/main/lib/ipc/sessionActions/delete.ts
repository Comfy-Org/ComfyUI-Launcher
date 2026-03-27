import {
  path, fs,
  installations, i18n,
  deleteDir, formatTime,
  findLockingProcesses,
  MARKER_FILE,
  _operationAborts,
  autoAssignPrimary,
  makeSendProgress,
} from '../shared'
import type { ActionContext, ActionResult } from './types'

export async function handleDelete({ event, installationId, inst }: ActionContext): Promise<ActionResult> {
  if (!fs.existsSync(inst.installPath)) {
    await installations.remove(installationId)
    await autoAssignPrimary(installationId)
    return { ok: true, navigate: 'list' }
  }
  if (_operationAborts.has(installationId)) {
    return { ok: false, message: 'Another operation is already running for this installation.' }
  }
  const markerPath = path.join(inst.installPath, MARKER_FILE)
  let markerContent: string | null
  try { markerContent = fs.readFileSync(markerPath, 'utf-8').trim() } catch { markerContent = null }
  if (!markerContent) {
    return { ok: false, message: 'Safety check failed: this directory was not created by ComfyUI Desktop 2.0. Use Untrack to remove it from the list, then delete the files manually.' }
  }
  if (markerContent !== inst.id && markerContent !== 'tracked') {
    return { ok: false, message: 'Safety check failed: the marker file does not match this installation. Use Untrack instead.' }
  }
  const sender = event.sender
  const sendProgress = makeSendProgress(sender, installationId)
  const abort = new AbortController()
  _operationAborts.set(installationId, abort)
  sendProgress('delete', { percent: 0, status: 'Counting files…' })
  try {
    await deleteDir(inst.installPath, (p) => {
      const elapsed = formatTime(p.elapsedSecs)
      const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : '—'
      sendProgress('delete', {
        percent: p.percent,
        status: `Deleting… ${p.deleted} / ${p.total} items  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
      })
    }, { signal: abort.signal })
  } catch (err) {
    _operationAborts.delete(installationId)
    try {
      fs.mkdirSync(inst.installPath, { recursive: true })
      fs.writeFileSync(markerPath, markerContent)
    } catch {}
    await installations.update(installationId, { status: 'partial-delete' })
    const raw = (err as NodeJS.ErrnoException)
    let message = raw.message
    if (raw.code === 'EBUSY' || raw.code === 'EPERM') {
      message = i18n.t('errors.deleteLocked', { path: raw.path ?? '' })
      const lockedPath = raw.path
      if (lockedPath) {
        findLockingProcesses(lockedPath).then((procs) => {
          if (procs.length > 0 && !sender.isDestroyed()) {
            const names = [...new Set(procs.map((p) => p.name))].join(', ')
            const detail = i18n.t('errors.deleteLockedBy', { processes: names, path: lockedPath })
            sender.send('error-detail', { installationId, message: detail })
          }
        }).catch((err) => { console.error('Failed to identify locking processes:', err) })
      }
    }
    return { ok: false, message }
  }
  _operationAborts.delete(installationId)
  await installations.remove(installationId)
  await autoAssignPrimary(installationId)
  return { ok: true, navigate: 'list' }
}
