import {
  path, fs,
  installations, settings, i18n,
  sourceMap,
  spawnProcess, waitForPort, waitForUrl, killProcessTree,
  findPidsByPort, getProcessInfo, looksLikeComfyUI, setPortArg,
  findAvailablePort, writePortLock, readPortLock,
  COMFY_BOOT_TIMEOUT_MS, SENSITIVE_ARG_RE,
  _onLaunch, _onComfyExited, _onComfyRestarted, _onModelFolderRelaunch,
  _operationAborts, _runningSessions, _pendingPorts,
  _reservePort, _releasePort, _broadcastToRenderer,
  _addSession, _removeSession,
  isEffectivelyEmptyInstallDir,
  captureSnapshotIfChanged, getSnapshotCount,
  syncCustomModelFolders, discoverExtraModelFolders,
  createSessionPath, buildLaunchEnv, checkRebootMarker,
  makeSendProgress, makeSendOutput,
  getComfyArgsSchema, filterUnsupportedArgs,
} from '../shared'
import type { ChildProcess, LaunchCmd } from '../shared'
import type { ActionContext, ActionResult } from './types'

export async function handleLaunch({ event, installationId, inst: instArg, actionData }: ActionContext): Promise<ActionResult> {
  let inst = instArg
  if (_runningSessions.has(installationId)) {
    return { ok: false, message: i18n.t('errors.alreadyRunning') }
  }
  if (_operationAborts.has(installationId)) {
    return { ok: false, message: 'Another operation is already running for this installation.' }
  }
  const source = sourceMap[inst.sourceId]
  if (!source) return { ok: false, message: i18n.t('errors.unknownSource') }
  if (!source.skipInstall && isEffectivelyEmptyInstallDir(inst.installPath)) {
    return { ok: false, message: i18n.t('errors.installDirEmpty') }
  }
  // Migrate legacy envs/default/ → ComfyUI/.venv/ for standalone installations
  if (inst.sourceId === 'standalone') {
    const { migrateEnvLayout } = await import('../../../sources/standalone/install')
    const updateFn = async (data: Record<string, unknown>): Promise<unknown> => installations.update(installationId, data)
    try {
      const migrated = await migrateEnvLayout(inst.installPath, updateFn)
      if (migrated) inst = (await installations.get(installationId)) || inst
    } catch (err) {
      console.warn('Env layout migration failed:', err)
    }
  }

  const launchStartedAt = Date.now()
  const launchCmdRaw = source.getLaunchCommand(inst)
  if (!launchCmdRaw) {
    return { ok: false, message: i18n.t('errors.noEnvFound') }
  }
  const launchCmd = launchCmdRaw

  // Filter out unsupported args
  if (launchCmd.cmd && launchCmd.args && launchCmd.cwd) {
    const sIdx = launchCmd.args.indexOf('-s')
    if (sIdx !== -1 && sIdx + 1 < launchCmd.args.length) {
      const mainPyRel = launchCmd.args[sIdx + 1]!
      const mainPyAbs = path.resolve(launchCmd.cwd, mainPyRel)
      try {
        const schema = await getComfyArgsSchema(launchCmd.cmd, mainPyAbs, launchCmd.cwd, installationId, inst.version as string | undefined)
        const prefixArgs = launchCmd.args.slice(0, sIdx + 2)
        const userArgs = launchCmd.args.slice(sIdx + 2)
        const filtered = filterUnsupportedArgs(userArgs, schema)
        launchCmd.args = [...prefixArgs, ...filtered]
      } catch {
        // Schema not available — pass args as-is
      }
    }
  }

  // Inject shared paths
  const useSharedPaths = !launchCmd.skipSharedPaths && (inst.useSharedPaths as boolean | undefined) !== false && !!launchCmd.args
  let preLaunchExtras: string[] = []
  let sharedModelsDirs: string[] | undefined
  if (useSharedPaths) {
    sharedModelsDirs = settings.get('modelsDirs') as string[] | undefined
    const { config } = syncCustomModelFolders(inst.installPath, sharedModelsDirs)
    if (config) {
      launchCmd.args!.push('--extra-model-paths-config', config.yamlPath)
    }
    const installExtras = discoverExtraModelFolders(inst.installPath)
    const baselineSet = new Set([...(config?.extraFolders ?? []), ...installExtras])
    preLaunchExtras = [...baselineSet].sort()
    const inputDir = (settings.get('inputDir') as string | undefined) || settings.defaults.inputDir
    const outputDir = (settings.get('outputDir') as string | undefined) || settings.defaults.outputDir
    fs.mkdirSync(inputDir, { recursive: true })
    fs.mkdirSync(outputDir, { recursive: true })
    launchCmd.args!.push('--input-directory', inputDir)
    launchCmd.args!.push('--output-directory', outputDir)
  }

  const sender = event.sender
  const sendProgress = makeSendProgress(sender, installationId)

  const abort = new AbortController()
  _operationAborts.set(installationId, abort)

  // Remote connection
  if (launchCmd.remote) {
    sendProgress('launch', { percent: -1, status: i18n.t('launch.connecting', { url: launchCmd.url || '' }) })
    try {
      await waitForUrl(launchCmd.url!, {
        timeoutMs: 15000,
        signal: abort.signal,
        onPoll: ({ elapsedMs }) => {
          const secs = Math.round(elapsedMs / 1000)
          sendProgress('launch', { percent: -1, status: i18n.t('launch.connectingTime', { url: launchCmd.url || '', secs }) })
        },
      })
    } catch (_err) {
      _operationAborts.delete(installationId)
      if (abort.signal.aborted) return { ok: false, cancelled: true }
      return { ok: false, message: i18n.t('errors.cannotConnect', { url: launchCmd.url || '' }) }
    }

    _operationAborts.delete(installationId)
    const mode = (inst.launchMode as string | undefined) || 'window'
    _addSession(installationId, { proc: null, port: launchCmd.port!, url: launchCmd.url, mode, installationName: inst.name }, Date.now() - launchStartedAt)
    if (_onLaunch) {
      _onLaunch({ port: launchCmd.port!, url: launchCmd.url, process: null, installation: inst, mode })
    }
    return { ok: true, mode, port: launchCmd.port, url: launchCmd.url }
  }

  // Local process launch
  if (!fs.existsSync(launchCmd.cmd!)) {
    _operationAborts.delete(installationId)
    return { ok: false, message: `Executable not found: ${launchCmd.cmd}` }
  }

  // Skip port logic entirely
  if (launchCmd.skipPortWait) {
    _broadcastToRenderer('instance-launching', { installationId, installationName: inst.name })
    const sendOutput = makeSendOutput(sender, installationId)
    const launchEnv = buildLaunchEnv(inst)
    const proc = spawnProcess(launchCmd.cmd!, launchCmd.args!, launchCmd.cwd!, launchEnv, { showWindow: launchCmd.showWindow })
    let stderrBuf = ''
    proc.stdout?.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stderrBuf += text
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096)
      sendOutput(text)
    })

    _operationAborts.delete(installationId)
    const mode = (inst.launchMode as string | undefined) || 'window'
    _addSession(installationId, { proc, port: 0, mode, installationName: inst.name }, Date.now() - launchStartedAt)

    proc.on('exit', (code) => {
      const crashed = _runningSessions.has(installationId) && code !== 0
      _removeSession(installationId)
      if (!sender.isDestroyed()) {
        sender.send('comfy-exited', { installationId, crashed, exitCode: code, installationName: inst.name })
      }
      if (_onComfyExited) _onComfyExited({ installationId })
    })

    if (_onLaunch) {
      _onLaunch({ port: 0, process: proc, installation: inst, mode })
    }
    return { ok: true, mode }
  }

  if (actionData && actionData.portOverride) {
    setPortArg(launchCmd as LaunchCmd, actionData.portOverride as number)
  }

  // Check for port conflicts
  const pendingPortOwner = _pendingPorts.get(launchCmd.port!)
  const existingPids = pendingPortOwner ? [] : await findPidsByPort(launchCmd.port!)
  const portOccupied = !!pendingPortOwner || existingPids.length > 0

  if (portOccupied) {
    const defaults = source.getDefaults ? source.getDefaults() : {}
    const portConflictMode = (inst.portConflict as string | undefined) || (defaults.portConflict as string | undefined) || 'auto'
    const userArgs = ((inst.launchArgs as string | undefined) || '').trim()
    const portIsExplicit = /(?:^|\s)--port\b/.test(userArgs)

    const reservedPorts = new Set(_pendingPorts.keys())
    let nextPort: number | null = null
    try {
      nextPort = await findAvailablePort('127.0.0.1', launchCmd.port! + 1, launchCmd.port! + 1000, reservedPorts)
    } catch {}

    if (portConflictMode === 'auto' && nextPort && !portIsExplicit) {
      sendProgress('launch', { percent: -1, status: i18n.t('launch.portBusyUsing', { old: launchCmd.port!, new: nextPort }) })
      setPortArg(launchCmd as LaunchCmd, nextPort)
    } else {
      let message: string
      let isComfy: boolean
      if (pendingPortOwner) {
        message = i18n.t('errors.portConflictLauncher', { port: launchCmd.port!, name: pendingPortOwner })
        isComfy = true
      } else {
        const lock = readPortLock(launchCmd.port!)
        if (lock) {
          message = i18n.t('errors.portConflictLauncher', { port: launchCmd.port!, name: lock.installationName })
          isComfy = true
        } else {
          const info = await getProcessInfo(existingPids[0]!)
          isComfy = looksLikeComfyUI(info)
          const processDesc = info ? info.name : `PID ${existingPids[0]}`
          message = isComfy
            ? i18n.t('errors.portConflictComfy', { port: launchCmd.port!, process: processDesc })
            : i18n.t('errors.portConflictOther', { port: launchCmd.port!, process: processDesc })
        }
      }
      _operationAborts.delete(installationId)
      return { ok: false, message, portConflict: { port: launchCmd.port, pids: existingPids, isComfy, nextPort } }
    }
  }

  // Synchronous re-check: TOCTOU gap
  const lateConflictOwner = _pendingPorts.get(launchCmd.port!)
  if (lateConflictOwner) {
    const defaults = source.getDefaults ? source.getDefaults() : {}
    const portConflictMode = (inst.portConflict as string | undefined) || (defaults.portConflict as string | undefined) || 'auto'
    const userArgs = ((inst.launchArgs as string | undefined) || '').trim()
    const portIsExplicit = /(?:^|\s)--port\b/.test(userArgs)

    const reservedPorts = new Set(_pendingPorts.keys())
    let nextPort: number | null = null
    try {
      nextPort = await findAvailablePort('127.0.0.1', launchCmd.port! + 1, launchCmd.port! + 1000, reservedPorts)
    } catch {}

    if (portConflictMode === 'auto' && nextPort && !portIsExplicit) {
      sendProgress('launch', { percent: -1, status: i18n.t('launch.portBusyUsing', { old: launchCmd.port!, new: nextPort }) })
      setPortArg(launchCmd as LaunchCmd, nextPort)
    } else {
      _operationAborts.delete(installationId)
      return {
        ok: false,
        message: i18n.t('errors.portConflictLauncher', { port: launchCmd.port!, name: lateConflictOwner }),
        portConflict: { port: launchCmd.port, pids: [], isComfy: true, nextPort },
      }
    }
  }

  // Reserve port eagerly
  _reservePort(launchCmd.port!, inst.name)
  _broadcastToRenderer('instance-launching', { installationId, installationName: inst.name })

  const sessionPath = createSessionPath()
  const launchEnv = buildLaunchEnv(inst, sessionPath)
  const sendOutput = (text: string): void => {
    if (!sender.isDestroyed()) {
      sender.send('comfy-output', { installationId, text })
    }
  }

  function spawnComfy(): { proc: ChildProcess; getStderr: () => string } {
    const p = spawnProcess(launchCmd.cmd!, launchCmd.args!, launchCmd.cwd!, launchEnv, { showWindow: launchCmd.showWindow })
    let stderrBuf = ''
    p.stdout!.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
    p.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stderrBuf += text
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096)
      sendOutput(text)
    })
    return { proc: p, getStderr: () => stderrBuf }
  }

  const PORT_RETRY_MAX = 3
  const REBOOT_RETRY_MAX = 5
  let portRetries = 0
  let rebootRetries = 0

  const tryLaunch = async (): Promise<{ ok: true; proc: ChildProcess; getStderr: () => string } | { ok: false; message: string; cancelled?: boolean }> => {
    const cmdLine = [launchCmd.cmd!, ...launchCmd.args!].map((a, ci, ca) => {
      if (ci > 0 && SENSITIVE_ARG_RE.test(ca[ci - 1]!)) return '"***"'
      return /\s/.test(a) ? `"${a}"` : a
    }).join(' ')
    sendProgress('launch', { percent: -1, status: i18n.t('launch.starting') })
    if (!sender.isDestroyed()) {
      sender.send('comfy-output', { installationId, text: `> ${cmdLine}\n\n` })
    }
    const spawned = spawnComfy()

    let earlyExit: string | null = null
    const earlyExitPromise = new Promise<void>((_resolve, reject) => {
      spawned.proc.on('error', (err: Error) => {
        const code = (err as NodeJS.ErrnoException).code ? ` (${(err as NodeJS.ErrnoException).code})` : ''
        earlyExit = err.message
        reject(new Error(`Failed to start${code}: ${launchCmd.cmd}`))
      })
      spawned.proc.on('exit', (code) => {
        if (!earlyExit) {
          const detail = spawned.getStderr().trim() ? `\n\n${spawned.getStderr().trim()}` : ''
          earlyExit = `Process exited with code ${code}${detail}`
          reject(new Error(earlyExit))
        }
      })
    })

    sendProgress('launch', { percent: -1, status: i18n.t('launch.waiting') })
    try {
      await Promise.race([
        waitForPort(launchCmd.port!, '127.0.0.1', {
          timeoutMs: COMFY_BOOT_TIMEOUT_MS,
          signal: abort.signal,
          onPoll: ({ elapsedMs }) => {
            const secs = Math.round(elapsedMs / 1000)
            sendProgress('launch', { percent: -1, status: i18n.t('launch.waitingTime', { secs }) })
          },
        }),
        earlyExitPromise,
      ])
      return { ok: true, proc: spawned.proc, getStderr: spawned.getStderr }
    } catch (err) {
      killProcessTree(spawned.proc)
      if (checkRebootMarker(sessionPath) && rebootRetries < REBOOT_RETRY_MAX) {
        rebootRetries++
        sendOutput('\n--- Manager requested restart during startup, respawning… ---\n\n')
        return tryLaunch()
      }
      const stderr = spawned.getStderr().toLowerCase()
      const isPortConflict = stderr.includes('address already in use') || (stderr.includes('port') && stderr.includes('in use'))
      if (isPortConflict && portRetries < PORT_RETRY_MAX) {
        portRetries++
        try {
          const reservedPorts = new Set(_pendingPorts.keys())
          const retryPort = await findAvailablePort('127.0.0.1', launchCmd.port! + 1, launchCmd.port! + 1000, reservedPorts)
          sendOutput(`\nPort ${launchCmd.port} in use, retrying on port ${retryPort}…\n`)
          _releasePort(launchCmd.port!)
          setPortArg(launchCmd as LaunchCmd, retryPort)
          _reservePort(launchCmd.port!, inst.name)
          return tryLaunch()
        } catch {}
      }
      if (abort.signal.aborted) return { ok: false, message: (err as Error).message, cancelled: true }
      return { ok: false, message: (err as Error).message }
    }
  }

  const launchResult = await tryLaunch()
  if (!launchResult.ok) {
    _releasePort(launchCmd.port!)
    _operationAborts.delete(installationId)
    _broadcastToRenderer('instance-launch-failed', { installationId })
    if (launchResult.cancelled) return { ok: false, cancelled: true }
    return { ok: false, message: launchResult.message }
  }
  let { proc } = launchResult

  _pendingPorts.delete(launchCmd.port!)
  _operationAborts.delete(installationId)
  const mode = (inst.launchMode as string | undefined) || 'window'
  _addSession(installationId, { proc, port: launchCmd.port!, mode, installationName: inst.name }, Date.now() - launchStartedAt)
  writePortLock(launchCmd.port!, { pid: proc.pid!, installationName: inst.name })

  // Capture snapshot in background after successful launch
  if (inst.sourceId === 'standalone') {
    captureSnapshotIfChanged(inst.installPath, inst, 'boot')
      .then(async ({ saved, filename }) => {
        if (saved) {
          const snapshotCount = await getSnapshotCount(inst.installPath)
          installations.update(installationId, { lastSnapshot: filename, snapshotCount })
        }
      })
      .catch((err) => console.warn('Snapshot capture failed:', err))
  }

  // Check if custom nodes created new model folders during startup
  let site1Relaunched = false
  if (useSharedPaths) {
    const { newFolders } = syncCustomModelFolders(inst.installPath, sharedModelsDirs, preLaunchExtras)
    if (newFolders.length > 0) {
      sendOutput(`\n--- Restarting: new model folders detected (${newFolders.join(', ')}) ---\n\n`)
      if (_onModelFolderRelaunch) {
        await Promise.resolve(_onModelFolderRelaunch({ installationId })).catch(() => {})
      }
      await killProcessTree(proc)
      const respawned = spawnComfy()
      proc = respawned.proc
      const session = _runningSessions.get(installationId)
      if (session) session.proc = proc
      writePortLock(launchCmd.port!, { pid: proc.pid!, installationName: inst.name })
      const relaunchEarlyExit = new Promise<void>((_resolve, reject) => {
        proc.on('error', (err: Error) => reject(err))
        proc.on('exit', (code) => reject(new Error(`Process exited with code ${code}`)))
      })
      try {
        await Promise.race([
          waitForPort(launchCmd.port!, '127.0.0.1', {
            timeoutMs: COMFY_BOOT_TIMEOUT_MS,
            signal: abort.signal,
            onPoll: ({ elapsedMs }) => {
              const secs = Math.round(elapsedMs / 1000)
              sendProgress('launch', { percent: -1, status: i18n.t('launch.waitingTime', { secs }) })
            },
          }),
          relaunchEarlyExit,
        ])
      } catch (err) {
        await killProcessTree(proc)
        _removeSession(installationId)
        _broadcastToRenderer('instance-launch-failed', { installationId })
        if (abort.signal.aborted) return { ok: false, cancelled: true }
        return { ok: false, message: (err as Error).message }
      }
      site1Relaunched = true
    }
  }

  const knownExtras = new Set(
    site1Relaunched ? discoverExtraModelFolders(inst.installPath) : preLaunchExtras,
  )
  let pendingModelFolderRelaunch = false
  let rebootModelCheckAbort: AbortController | null = null

  function attachExitHandler(p: ChildProcess): void {
    p.on('exit', (code) => {
      if (rebootModelCheckAbort) {
        rebootModelCheckAbort.abort()
        rebootModelCheckAbort = null
      }

      if (pendingModelFolderRelaunch || checkRebootMarker(sessionPath)) {
        const isModelRelaunch = pendingModelFolderRelaunch
        pendingModelFolderRelaunch = false
        if (!isModelRelaunch) {
          sendOutput('\n--- ComfyUI restarting ---\n\n')
        }
        if (useSharedPaths) {
          const { config } = syncCustomModelFolders(inst.installPath, sharedModelsDirs)
          if (config) {
            for (const f of config.extraFolders) knownExtras.add(f)
          }
          if (!isModelRelaunch) {
            knownExtras.clear()
            const freshExtras = discoverExtraModelFolders(inst.installPath)
            for (const f of freshExtras) knownExtras.add(f)
            if (config) {
              for (const f of config.extraFolders) knownExtras.add(f)
            }
          }
        }
        const spawned = spawnComfy()
        proc = spawned.proc
        const session = _runningSessions.get(installationId)
        if (session) session.proc = proc
        writePortLock(launchCmd.port!, { pid: proc.pid!, installationName: inst.name })
        attachExitHandler(proc)
        if (_onComfyRestarted) _onComfyRestarted({ installationId, process: proc })
        if (useSharedPaths) {
          rebootModelCheckAbort = new AbortController()
          const checkSignal = rebootModelCheckAbort.signal
          waitForPort(launchCmd.port!, '127.0.0.1', { timeoutMs: COMFY_BOOT_TIMEOUT_MS, signal: checkSignal })
            .then(async () => {
              if (checkSignal.aborted) return
              const currentSession = _runningSessions.get(installationId)
              if (!currentSession || currentSession.proc !== proc) return
              const currentExtras = discoverExtraModelFolders(inst.installPath)
              const newFolders = currentExtras.filter((f) => !knownExtras.has(f))
              if (newFolders.length > 0) {
                const { config } = syncCustomModelFolders(inst.installPath, sharedModelsDirs)
                if (config) {
                  for (const f of config.extraFolders) knownExtras.add(f)
                }
                for (const f of newFolders) knownExtras.add(f)
                sendOutput(`\n--- Restarting: new model folders detected (${newFolders.join(', ')}) ---\n\n`)
                pendingModelFolderRelaunch = true
                if (_onModelFolderRelaunch) {
                  await Promise.resolve(_onModelFolderRelaunch({ installationId })).catch(() => {})
                }
                killProcessTree(proc)
              }
            })
            .catch(() => {})
        }
        // Capture snapshot after Manager-triggered restart
        if (inst.sourceId === 'standalone') {
          installations.get(installationId).then((currentInst) => {
            if (!currentInst) return
            captureSnapshotIfChanged(currentInst.installPath, currentInst, 'restart')
              .then(async ({ saved, filename }) => {
                if (saved) {
                  const snapshotCount = await getSnapshotCount(currentInst.installPath)
                  installations.update(installationId, { lastSnapshot: filename, snapshotCount })
                }
              })
              .catch((err) => console.warn('Snapshot capture failed:', err))
          })
        }
        return
      }
      const crashed = _runningSessions.has(installationId)
      _removeSession(installationId)
      if (!sender.isDestroyed()) {
        sender.send('comfy-exited', { installationId, crashed, exitCode: code, installationName: inst.name })
      }
      if (_onComfyExited) _onComfyExited({ installationId })
    })
  }
  attachExitHandler(proc)

  if (_onLaunch) {
    _onLaunch({ port: launchCmd.port!, process: proc, installation: inst, mode })
  }
  return { ok: true, mode, port: launchCmd.port }
}
