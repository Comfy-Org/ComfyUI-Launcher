import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { resolveInstalledVersion, clearVersionCache } from '../../lib/version-resolve'
import { readGitHead } from '../../lib/git'
import { PYTORCH_RE, installFilteredRequirements, getPipIndexArgs } from '../../lib/pip'
import { formatComfyVersion } from '../../lib/version'
import type { ComfyVersion } from '../../lib/version'
import { t } from '../../lib/i18n'
import { getBundledScriptPath } from '../../lib/bundledScript'
import * as settings from '../../settings'
import * as snapshots from '../../lib/snapshots'
import { repairMacBinaries } from './macRepair'
import { getUvPath, getActivePythonPath, getMasterPythonPath } from './envPaths'
import type { InstallationRecord } from '../../installations'

interface ScriptResult {
  exitCode: number
  exitSignal: string | null
  markers: Record<string, string>
  stdoutBuf: string
  stderrBuf: string
}

export interface UpdateOrchestrationOptions {
  installPath: string
  installation: InstallationRecord
  channel: 'stable' | 'latest'
  update: (data: Record<string, unknown>) => Promise<void>
  sendProgress: (step: string, data: Record<string, unknown>) => void
  sendOutput?: (text: string) => void
  signal?: AbortSignal
  dryRunConflictCheck?: boolean
  saveRollback?: boolean
  preUpdateSnapshot?: boolean
}

export interface UpdateOrchestrationResult {
  ok: boolean
  message?: string
  navigate?: string
  comfyVersion?: ComfyVersion
  installation: InstallationRecord
}

function spawnUpdateScript(
  masterPython: string,
  comfyuiDir: string,
  channelArgs: string[],
  sendOutput: ((text: string) => void) | undefined,
  signal?: AbortSignal,
): Promise<ScriptResult> {
  const updateScript = getBundledScriptPath('update_comfyui.py')
  const markers: Record<string, string> = {}
  let markerBuf = ''
  let stdoutBuf = ''
  let stderrBuf = ''
  let exitSignal: string | null = null

  const exitCode = new Promise<number>((resolve) => {
    const proc = spawn(masterPython, ['-s', updateScript, comfyuiDir, ...channelArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (signal) {
      const onAbort = (): void => { proc.kill() }
      signal.addEventListener('abort', onAbort, { once: true })
      proc.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stdoutBuf += text
      markerBuf += text
      const lines = markerBuf.split(/\r?\n/)
      markerBuf = lines.pop()!
      for (const line of lines) {
        const match = line.match(/^\[(\w+)\]\s*(.+)$/)
        if (match) markers[match[1]!] = match[2]!.trim()
      }
      sendOutput?.(text)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stderrBuf += text
      sendOutput?.(text)
    })
    proc.on('error', (err) => {
      sendOutput?.(`Error: ${err.message}\n`)
      resolve(1)
    })
    proc.on('close', (code, sig) => {
      exitSignal = sig
      resolve(code ?? 1)
    })
  })

  return exitCode.then((code) => {
    if (markerBuf) {
      const match = markerBuf.match(/^\[(\w+)\]\s*(.+)$/)
      if (match) markers[match[1]!] = match[2]!.trim()
    }
    return { exitCode: code, exitSignal, markers, stdoutBuf, stderrBuf }
  })
}

export async function runComfyUIUpdate(opts: UpdateOrchestrationOptions): Promise<UpdateOrchestrationResult> {
  const {
    installPath, channel, update, sendProgress, signal,
    dryRunConflictCheck = false,
    saveRollback = false,
    preUpdateSnapshot = false,
  } = opts
  let { installation } = opts
  const sendOutput = opts.sendOutput
  const comfyuiDir = path.join(installPath, 'ComfyUI')
  const masterPython = getMasterPythonPath(installPath)
  const channelArgs = channel === 'stable' ? ['--stable'] : []

  // Read pre-update requirements
  const reqPath = path.join(comfyuiDir, 'requirements.txt')
  let preReqs = ''
  try { preReqs = await fs.promises.readFile(reqPath, 'utf-8') } catch {}

  const mgrReqPath = path.join(comfyuiDir, 'manager_requirements.txt')
  let preMgrReqs = ''
  try { preMgrReqs = await fs.promises.readFile(mgrReqPath, 'utf-8') } catch {}

  // Optional pre-update snapshot
  let preUpdateFilename: string | undefined
  if (preUpdateSnapshot) {
    try {
      preUpdateFilename = await snapshots.saveSnapshot(installPath, installation, 'pre-update')
      const snapshotCount = await snapshots.getSnapshotCount(installPath)
      await update({ lastSnapshot: preUpdateFilename, snapshotCount })
    } catch (err) {
      console.warn('Pre-update snapshot failed:', err)
    }
  }

  // Run the update script (with macOS SIGKILL retry)
  let result = await spawnUpdateScript(masterPython, comfyuiDir, channelArgs, sendOutput, signal)

  if (result.exitCode !== 0 && result.exitSignal === 'SIGKILL' && process.platform === 'darwin') {
    if (sendOutput) {
      sendOutput('\nProcess was killed by macOS — attempting binary repair…\n')
    } else {
      console.warn('macOS killed update process — attempting binary repair and retry')
    }
    await repairMacBinaries(installPath, sendProgress, sendOutput)
    if (sendOutput) {
      sendOutput('Repair complete — retrying update…\n\n')
    }
    result = await spawnUpdateScript(masterPython, comfyuiDir, channelArgs, sendOutput, signal)
  }

  if (result.exitCode !== 0) {
    const detail = (result.stderrBuf || result.stdoutBuf).trim().split('\n').slice(-20).join('\n')
    if (sendOutput) {
      let message: string
      if (detail) {
        message = `${t('standalone.updateFailed', { code: result.exitCode })}\n\n${detail}`
      } else if (result.exitSignal) {
        message = `${t('standalone.updateFailed', { code: result.exitCode })}\n\nProcess was killed by signal ${result.exitSignal}.\npython: ${masterPython}\nscript: ${getBundledScriptPath('update_comfyui.py')}`
      } else {
        message = `${t('standalone.updateFailed', { code: result.exitCode })}\n\nProcess produced no output.\npython: ${masterPython}\nscript: ${getBundledScriptPath('update_comfyui.py')}`
      }
      return { ok: false, message, installation }
    }
    console.warn(`Auto-update script failed (exit ${result.exitCode}):\n${detail.split('\n').slice(-10).join('\n')}`)
    return { ok: false, installation }
  }

  const { markers } = result
  if (signal?.aborted) return { ok: false, message: 'Cancelled', installation }

  // Install updated requirements if changed
  let postReqs = ''
  try { postReqs = await fs.promises.readFile(reqPath, 'utf-8') } catch {}

  if (preReqs !== postReqs && postReqs.length > 0) {
    const uvPath = getUvPath(installPath)
    const activeEnvPython = getActivePythonPath(installation)

    if (fs.existsSync(uvPath) && activeEnvPython) {
      if (dryRunConflictCheck) {
        // Dry-run conflict detection (actions.ts behavior)
        const filteredReqs = postReqs.split('\n').filter((l) => !PYTORCH_RE.test(l.trim())).join('\n')
        const filteredReqPath = path.join(installPath, '.comfyui-reqs-filtered.txt')
        await fs.promises.writeFile(filteredReqPath, filteredReqs, 'utf-8')

        try {
          const indexArgs = getPipIndexArgs(settings.get('pypiMirror'), settings.get('useChineseMirrors') === true)
          sendProgress('deps', { percent: -1, status: t('standalone.updateDepsDryRun') })
          if (signal?.aborted) return { ok: false, message: 'Cancelled', installation }

          const dryRunResult = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
            const proc = spawn(uvPath, ['pip', 'install', '--dry-run', '-r', filteredReqPath, '--python', activeEnvPython, ...indexArgs], {
              cwd: installPath,
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
            })
            if (signal) {
              const onAbort = (): void => { proc.kill() }
              signal.addEventListener('abort', onAbort, { once: true })
              proc.on('close', () => signal.removeEventListener('abort', onAbort))
            }
            let stdout = ''
            let stderr = ''
            proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
            proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })
            proc.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }))
            proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
          })

          if (dryRunResult.code !== 0) {
            sendOutput?.(`\n⚠ Requirements dry-run detected potential conflicts:\n${dryRunResult.stderr || dryRunResult.stdout}\n`)
            sendOutput?.('Proceeding with install attempt — some conflicts may be benign.\nTip: Use "Copy & Update" for a risk-free update that leaves this installation untouched.\n')
          } else if (dryRunResult.stderr) {
            sendOutput?.(dryRunResult.stderr)
          }

          if (signal?.aborted) return { ok: false, message: 'Cancelled', installation }
          sendProgress('deps', { percent: -1, status: t('standalone.updateDepsInstalling') })

          const installResult = await new Promise<number>((resolve) => {
            const proc = spawn(uvPath, ['pip', 'install', '-r', filteredReqPath, '--python', activeEnvPython, ...indexArgs], {
              cwd: installPath,
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
            })
            if (signal) {
              const onAbort = (): void => { proc.kill() }
              signal.addEventListener('abort', onAbort, { once: true })
              proc.on('close', () => signal.removeEventListener('abort', onAbort))
            }
            proc.stdout.on('data', (chunk: Buffer) => sendOutput?.(chunk.toString('utf-8')))
            proc.stderr.on('data', (chunk: Buffer) => sendOutput?.(chunk.toString('utf-8')))
            proc.on('error', (err) => {
              sendOutput?.(`Error: ${err.message}\n`)
              resolve(1)
            })
            proc.on('close', (code) => resolve(code ?? 1))
          })

          if (installResult !== 0) {
            sendOutput?.(`\nWarning: requirements install exited with code ${installResult}\n`)
          }
        } finally {
          try { await fs.promises.unlink(filteredReqPath) } catch {}
        }
      } else {
        // Simple filtered install (install.ts behavior)
        sendProgress('update', { percent: -1, status: 'Installing updated dependencies' })
        const logFn = sendOutput ?? console.log
        const installResult = await installFilteredRequirements(
          reqPath, uvPath, activeEnvPython, installPath,
          '.post-install-reqs.txt', logFn, signal, settings.getMirrorConfig()
        )
        if (installResult !== 0) {
          console.warn(`Post-install requirements install exited with code ${installResult}`)
        }
      }
    }
  } else if (dryRunConflictCheck) {
    sendProgress('deps', { percent: -1, status: t('standalone.updateDepsUpToDate') })
  }

  // Install manager_requirements.txt if changed
  let postMgrReqs = ''
  try { postMgrReqs = await fs.promises.readFile(mgrReqPath, 'utf-8') } catch {}

  if (preMgrReqs !== postMgrReqs && postMgrReqs.length > 0) {
    const uvPath = getUvPath(installPath)
    const activeEnvPython = getActivePythonPath(installation)

    if (fs.existsSync(uvPath) && activeEnvPython) {
      if (dryRunConflictCheck) {
        sendProgress('deps', { percent: -1, status: t('standalone.updateDepsInstalling') })
        sendOutput?.('\nInstalling manager requirements…\n')
      }
      const logFn = sendOutput ?? console.log
      const mgrResult = await installFilteredRequirements(
        mgrReqPath, uvPath, activeEnvPython, installPath,
        dryRunConflictCheck ? '.manager-reqs-filtered.txt' : '.post-install-mgr-reqs.txt',
        logFn, signal, settings.getMirrorConfig()
      )
      if (mgrResult !== 0) {
        const msg = `manager requirements install exited with code ${mgrResult}`
        if (sendOutput) {
          sendOutput(`\nWarning: ${msg}\n`)
        } else {
          console.warn(`Post-install ${msg}`)
        }
      }
    }
  }

  // Re-resolve comfyVersion from git state
  clearVersionCache()
  const checkedOutTag = markers.CHECKED_OUT_TAG || undefined
  const fullPostHead = markers.POST_UPDATE_HEAD || readGitHead(comfyuiDir)

  let comfyVersion: ComfyVersion | undefined
  if (fullPostHead) {
    comfyVersion = await resolveInstalledVersion(
      comfyuiDir, fullPostHead,
      installation.comfyVersion as ComfyVersion | undefined,
      checkedOutTag
    )
    const installedTag = formatComfyVersion(comfyVersion, 'short')

    const existing = (installation.updateInfoByChannel as Record<string, Record<string, unknown>> | undefined) || {}
    const updateData: Record<string, unknown> = {
      comfyVersion,
      updateChannel: channel,
      updateInfoByChannel: {
        ...existing,
        [channel]: { installedTag },
      },
    }

    if (saveRollback) {
      updateData.lastRollback = {
        preUpdateHead: markers.PRE_UPDATE_HEAD || null,
        postUpdateHead: fullPostHead,
        backupBranch: markers.BACKUP_BRANCH || null,
        channel,
        updatedAt: Date.now(),
      }
    }

    await update(updateData)
    installation = { ...installation, comfyVersion } as InstallationRecord
  }

  // Save post-update snapshot
  try {
    const updatedInstallation = { ...installation, updateChannel: channel }
    const filename = await snapshots.saveSnapshot(installPath, updatedInstallation, 'post-update')
    const snapshotCount = await snapshots.getSnapshotCount(installPath)
    await update({ lastSnapshot: filename, snapshotCount })

    // Remove pre-update snapshot if it was identical to the one before it
    if (preUpdateFilename) {
      const pruned = await snapshots.deduplicatePreUpdateSnapshot(installPath, preUpdateFilename)
      if (pruned) {
        const updatedCount = await snapshots.getSnapshotCount(installPath)
        await update({ snapshotCount: updatedCount })
      }
    }
  } catch (err) {
    console.warn('Post-update snapshot failed:', err)
  }

  return { ok: true, comfyVersion, installation }
}
