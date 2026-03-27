import {
  ipcMain,
  installations, i18n,
  killByPort,
  findPidsByPort,
  removePortLock,
  REQUIRES_STOPPED,
  _onStop,
  _operationAborts, _runningSessions,
  _getPublicSessions,
  stopRunning,
} from './shared'
import {
  handleRemove, handleSetPrimaryInstall, handlePinInstall, handleUnpinInstall, handleOpenFolder,
  handleDelete,
  handleCopy, handleCopyUpdate, handleReleaseUpdate,
  handleMigrateToStandalone,
  handleLaunch,
  handleDelegateToSource,
} from './sessionActions'

export function registerSessionHandlers(): void {
  ipcMain.handle('stop-comfyui', async (_event, installationId?: string) => {
    if (installationId) {
      await stopRunning(installationId)
    } else {
      await stopRunning()
    }
    if (_onStop) _onStop({ installationId })
  })

  ipcMain.handle('get-running-instances', () => _getPublicSessions())

  ipcMain.handle('cancel-launch', () => {
    for (const [_id, abort] of _operationAborts) {
      abort.abort()
    }
    _operationAborts.clear()
  })

  ipcMain.handle('cancel-operation', (_event, installationId: string) => {
    const abort = _operationAborts.get(installationId)
    if (abort) {
      abort.abort()
      _operationAborts.delete(installationId)
    }
  })

  ipcMain.handle('kill-port-process', async (_event, port: number) => {
    removePortLock(port)
    await killByPort(port)
    await new Promise((r) => setTimeout(r, 500))
    const remaining = await findPidsByPort(port)
    return { ok: remaining.length === 0 }
  })

  ipcMain.handle('run-action', async (_event, installationId: string, actionId: string, actionData?: Record<string, unknown>) => {
    const maybeInst = await installations.get(installationId)
    if (!maybeInst) return { ok: false, message: 'Installation not found.' }
    const inst = maybeInst
    if (REQUIRES_STOPPED.has(actionId) && _runningSessions.has(installationId)) {
      return { ok: false, message: i18n.t('errors.stopRequired'), running: true }
    }
    if (REQUIRES_STOPPED.has(actionId) && _operationAborts.has(installationId)) {
      return { ok: false, message: i18n.t('errors.operationInProgress') }
    }

    const ctx = { event: _event, installationId, inst, actionData }

    switch (actionId) {
      case 'remove': return handleRemove(ctx)
      case 'set-primary-install': return handleSetPrimaryInstall(ctx)
      case 'pin-install': return handlePinInstall(ctx)
      case 'unpin-install': return handleUnpinInstall(ctx)
      case 'open-folder': return handleOpenFolder(ctx)
      case 'delete': return handleDelete(ctx)
      case 'copy': return handleCopy(ctx)
      case 'copy-update': return handleCopyUpdate(ctx)
      case 'release-update': return handleReleaseUpdate(ctx)
      case 'migrate-to-standalone': return handleMigrateToStandalone(ctx)
      case 'launch': return handleLaunch(ctx)
      default: return handleDelegateToSource(ctx, actionId)
    }
  })
}
