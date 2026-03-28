import fs from 'fs'
import path from 'path'
import { execFile, spawn } from 'child_process'
import { downloadAndExtract, downloadAndExtractMulti } from '../../lib/installer'
import { copyDirWithProgress } from '../../lib/copy'
import { readGitHead, isGitAvailable, isPygit2Configured, tryConfigurePygit2Fallback, fetchTags } from '../../lib/git'
import { resolveLocalVersion, clearVersionCache } from '../../lib/version-resolve'
import { formatTime } from '../../lib/util'
import { t } from '../../lib/i18n'
import * as snapshots from '../../lib/snapshots'
import { fetchLatestRelease } from '../../lib/comfyui-releases'
import { installFilteredRequirements } from '../../lib/pip'
import { getBundledScriptPath } from '../../lib/bundledScript'
import { formatComfyVersion } from '../../lib/version'
import * as settings from '../../settings'
import { repairMacBinaries, codesignBinaries } from './macRepair'
import {
  MANIFEST_FILE, DEFAULT_LAUNCH_ARGS,
  getUvPath, getVenvDir, findSitePackages, getMasterPythonPath, getActivePythonPath,
} from './envPaths'
import type { InstallationRecord } from '../../installations'
import type { ComfyVersion } from '../../lib/version'
import type { InstallTools, PostInstallTools } from '../../types/sources'

const BULKY_PREFIXES = ['torch', 'nvidia', 'triton', 'cuda']

async function stripMasterPackages(installPath: string): Promise<void> {
  try {
    const sitePackages = findSitePackages(path.join(installPath, 'standalone-env'))
    if (!sitePackages || !fs.existsSync(sitePackages)) return

    const entries = await fs.promises.readdir(sitePackages, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const lower = entry.name.toLowerCase()
      if (BULKY_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
        await fs.promises.rm(path.join(sitePackages, entry.name), { recursive: true, force: true })
      }
    }
  } catch (err) {
    console.warn('Failed to strip master packages:', err)
  }
}

async function createEnv(
  installPath: string,
  onProgress: (copied: number, total: number, elapsedSecs: number, etaSecs: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const uvPath = getUvPath(installPath)
  const masterPython = getMasterPythonPath(installPath)
  const venvPath = getVenvDir(installPath)
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'))
    const proc = execFile(uvPath, ['venv', '--python', masterPython, venvPath], { cwd: installPath }, (err, _stdout, stderr) => {
      if (signal?.aborted) return reject(new Error('Cancelled'))
      if (err) return reject(new Error(`Failed to create .venv: ${stderr || err.message}`))
      resolve()
    })
    signal?.addEventListener('abort', () => { try { proc.kill() } catch {} }, { once: true })
  })

  try {
    const masterSitePackages = findSitePackages(path.join(installPath, 'standalone-env'))
    const envSitePackages = findSitePackages(venvPath)
    if (!masterSitePackages || !envSitePackages || !fs.existsSync(masterSitePackages)) {
      throw new Error('Could not locate site-packages for .venv.')
    }
    await copyDirWithProgress(masterSitePackages, envSitePackages, onProgress, { signal })
    await codesignBinaries(envSitePackages)
  } catch (err) {
    await fs.promises.rm(venvPath, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

export async function install(installation: InstallationRecord, tools: InstallTools): Promise<void> {
  const files = installation.downloadFiles as Array<{ url: string; filename: string; size: number }> | undefined
  if (files && files.length > 0) {
    const cacheDir = `${installation.releaseTag as string}_${installation.variant as string}`
    await downloadAndExtractMulti(files, installation.installPath, cacheDir, tools)
  } else if (installation.downloadUrl as string | undefined) {
    const downloadUrl = installation.downloadUrl as string
    const filename = downloadUrl.split('/').pop()!
    const cacheKey = `${installation.releaseTag as string}_${filename}`
    await downloadAndExtract(downloadUrl, installation.installPath, cacheKey, tools)
  }
}

export async function postInstall(installation: InstallationRecord, { sendProgress, update, signal }: PostInstallTools): Promise<void> {
  const standaloneEnvDir = path.join(installation.installPath, 'standalone-env')
  if (process.platform !== 'win32') {
    const binDir = path.join(standaloneEnvDir, 'bin')
    try {
      const entries = fs.readdirSync(binDir)
      for (const entry of entries) {
        const fullPath = path.join(binDir, entry)
        try { fs.chmodSync(fullPath, 0o755) } catch {}
      }
    } catch {}
  }
  await repairMacBinaries(installation.installPath, sendProgress)
  if (signal?.aborted) throw new Error('Cancelled')
  sendProgress('setup', { percent: 0, status: 'Creating Python environment…' })
  await createEnv(installation.installPath, (copied, total, elapsedSecs, etaSecs) => {
    const percent = Math.round((copied / total) * 100)
    const elapsed = formatTime(elapsedSecs)
    const eta = etaSecs >= 0 ? formatTime(etaSecs) : '—'
    sendProgress('setup', { percent, status: `Copying packages… ${copied} / ${total} files  ·  ${elapsed} elapsed  ·  ${eta} remaining` })
  }, signal)
  if (signal?.aborted) throw new Error('Cancelled')
  sendProgress('cleanup', { percent: -1, status: t('standalone.cleanupEnvStatus') })
  await stripMasterPackages(installation.installPath)

  // Populate comfyVersion from the extracted git repo so version displays
  // are correct immediately, without waiting for the first update.
  // On machines without a global git binary, configure pygit2 using the
  // just-installed standalone Python so tag resolution works correctly.
  if (!isPygit2Configured() && !await isGitAvailable()) {
    tryConfigurePygit2Fallback(installation.installPath)
  }
  const comfyuiDir = path.join(installation.installPath, 'ComfyUI')
  sendProgress('cleanup', { percent: -1, status: 'Fetching version tags…' })
  await fetchTags(comfyuiDir)
  const headCommit = readGitHead(comfyuiDir)
  if (headCommit) {
    const ref = installation.version as string | undefined
    const comfyVersion = await resolveLocalVersion(comfyuiDir, headCommit, ref)
    await update({ comfyVersion })
    // Use updated installation for snapshot so it captures the version
    installation = { ...installation, comfyVersion } as InstallationRecord
  }

  // Capture initial snapshot so the detail view shows "Current" immediately
  try {
    const filename = await snapshots.saveSnapshot(installation.installPath, installation, 'boot')
    const snapshotCount = await snapshots.getSnapshotCount(installation.installPath)
    await update({ lastSnapshot: filename, snapshotCount })
  } catch (err) {
    console.warn('Initial snapshot failed:', err)
  }

  // Auto-update to latest stable release if the bundled version is behind
  if (fs.existsSync(path.join(comfyuiDir, '.git'))) {
    if (signal?.aborted) throw new Error('Cancelled')
    sendProgress('update', { percent: -1, status: 'Fetching latest stable version' })

    try {
      const latestRelease = await fetchLatestRelease('stable')
      const latestTag = latestRelease?.tag_name as string | undefined
      const currentTag = (installation.comfyVersion as ComfyVersion | undefined)
        ? formatComfyVersion(installation.comfyVersion as ComfyVersion, 'short')
        : (installation.version as string | undefined)

      if (!latestTag || latestTag === currentTag) {
        sendProgress('update', { percent: 100, status: 'Already up to date' })
      } else {
        const masterPython = getMasterPythonPath(installation.installPath)
        const updateScript = getBundledScriptPath('update_comfyui.py')

        const reqPath = path.join(comfyuiDir, 'requirements.txt')
        let preReqs = ''
        try { preReqs = await fs.promises.readFile(reqPath, 'utf-8') } catch {}

        const mgrReqPath = path.join(comfyuiDir, 'manager_requirements.txt')
        let preMgrReqs = ''
        try { preMgrReqs = await fs.promises.readFile(mgrReqPath, 'utf-8') } catch {}

        const runUpdateScript = async (): Promise<{ exitCode: number; exitSignal: string | null; markers: Record<string, string>; outputBuf: string }> => {
          const markers: Record<string, string> = {}
          let markerBuf = ''
          let outputBuf = ''
          let exitSignal: string | null = null
          const exitCode = await new Promise<number>((resolve) => {
            const proc = spawn(masterPython, ['-s', updateScript, comfyuiDir, '--stable'], {
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
              outputBuf += text
              markerBuf += text
              const lines = markerBuf.split(/\r?\n/)
              markerBuf = lines.pop()!
              for (const line of lines) {
                const match = line.match(/^\[(\w+)\]\s*(.+)$/)
                if (match) markers[match[1]!] = match[2]!.trim()
              }
            })
            proc.stderr.on('data', (chunk: Buffer) => { outputBuf += chunk.toString('utf-8') })
            proc.on('error', () => resolve(1))
            proc.on('close', (code, sig) => { exitSignal = sig; resolve(code ?? 1) })
          })
          if (markerBuf) {
            const match = markerBuf.match(/^\[(\w+)\]\s*(.+)$/)
            if (match) markers[match[1]!] = match[2]!.trim()
          }
          return { exitCode, exitSignal, markers, outputBuf }
        }

        let result = await runUpdateScript()

        // On macOS, SIGKILL typically means Gatekeeper blocked an unsigned binary.
        // Auto-repair (quarantine removal + codesigning) and retry once.
        if (result.exitCode !== 0 && result.exitSignal === 'SIGKILL' && process.platform === 'darwin') {
          console.warn('macOS killed update process — attempting binary repair and retry')
          await repairMacBinaries(installation.installPath, sendProgress)
          result = await runUpdateScript()
        }

        if (result.exitCode !== 0) {
          console.warn(`Auto-update script failed (exit ${result.exitCode}):\n${result.outputBuf.trim().split('\n').slice(-10).join('\n')}`)
          sendProgress('update', { percent: 100, status: 'Skipped (update failed)' })
        } else {
          const { markers } = result
          if (signal?.aborted) throw new Error('Cancelled')

          // Install updated dependencies if requirements.txt changed
          let postReqs = ''
          try { postReqs = await fs.promises.readFile(reqPath, 'utf-8') } catch {}

          if (preReqs !== postReqs && postReqs.length > 0) {
            sendProgress('update', { percent: -1, status: 'Installing updated dependencies' })
            const uvPath = getUvPath(installation.installPath)
            const activeEnvPython = getActivePythonPath(installation)

            if (fs.existsSync(uvPath) && activeEnvPython) {
              const result = await installFilteredRequirements(
                reqPath, uvPath, activeEnvPython, installation.installPath,
                '.post-install-reqs.txt', console.log, signal, settings.getMirrorConfig()
              )
              if (result !== 0) {
                console.warn(`Post-install requirements install exited with code ${result}`)
              }
            }
          }

          // Install manager_requirements.txt if changed
          let postMgrReqs = ''
          try { postMgrReqs = await fs.promises.readFile(mgrReqPath, 'utf-8') } catch {}

          if (preMgrReqs !== postMgrReqs && postMgrReqs.length > 0) {
            const uvPath = getUvPath(installation.installPath)
            const activeEnvPython = getActivePythonPath(installation)

            if (fs.existsSync(uvPath) && activeEnvPython) {
              const result = await installFilteredRequirements(
                mgrReqPath, uvPath, activeEnvPython, installation.installPath,
                '.post-install-mgr-reqs.txt', console.log, signal, settings.getMirrorConfig()
              )
              if (result !== 0) {
                console.warn(`Post-install manager requirements install exited with code ${result}`)
              }
            }
          }

          // Re-resolve comfyVersion from git state
          clearVersionCache()
          const checkedOutTag = markers.CHECKED_OUT_TAG || undefined
          const fullPostHead = markers.POST_UPDATE_HEAD || readGitHead(comfyuiDir)
          if (fullPostHead) {
            const newComfyVersion = await resolveLocalVersion(comfyuiDir, fullPostHead, checkedOutTag)
            const installedTag = formatComfyVersion(newComfyVersion, 'short')
            await update({
              comfyVersion: newComfyVersion,
              updateChannel: 'stable',
              updateInfoByChannel: {
                ...((installation.updateInfoByChannel as Record<string, Record<string, unknown>> | undefined) || {}),
                stable: { installedTag },
              },
            })
            installation = { ...installation, comfyVersion: newComfyVersion } as InstallationRecord
          }

          // Re-capture snapshot reflecting the updated state
          try {
            const filename = await snapshots.saveSnapshot(installation.installPath, installation, 'post-update')
            const snapshotCount = await snapshots.getSnapshotCount(installation.installPath)
            await update({ lastSnapshot: filename, snapshotCount })
          } catch (err) {
            console.warn('Post-update snapshot failed:', err)
          }

          sendProgress('update', { percent: 100, status: 'Up to date' })
        }
      }
    } catch (err) {
      if ((err as Error).message === 'Cancelled') throw err
      console.warn('Auto-update to latest stable failed:', err)
      sendProgress('update', { percent: 100, status: 'Skipped' })
    }
  }
}

export async function probeInstallation(dirPath: string): Promise<Record<string, unknown> | null> {
  const envExists = fs.existsSync(path.join(dirPath, 'standalone-env'))
  const mainExists = fs.existsSync(path.join(dirPath, 'ComfyUI', 'main.py'))
  if (!envExists || !mainExists) return null
  const hasVenv = fs.existsSync(path.join(dirPath, 'ComfyUI', '.venv'))
  const hasLegacyEnvs = fs.existsSync(path.join(dirPath, 'envs'))
  const hasGit = fs.existsSync(path.join(dirPath, 'ComfyUI', '.git'))

  let version = 'unknown'
  let releaseTag = ''
  let variant = ''
  let pythonVersion = ''
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dirPath, MANIFEST_FILE), 'utf8')) as Record<string, string>
    version = data.comfyui_ref || version
    releaseTag = data.version || releaseTag
    variant = data.id || variant
    pythonVersion = data.python_version || pythonVersion
  } catch {}

  let comfyVersion: ComfyVersion | undefined
  if (hasGit) {
    const comfyuiDir = path.join(dirPath, 'ComfyUI')
    const commit = readGitHead(comfyuiDir)
    if (commit) {
      const manifestTag = version !== 'unknown' ? version : undefined
      comfyVersion = await resolveLocalVersion(comfyuiDir, commit, manifestTag)
    }
  }

  return {
    version,
    ...(comfyVersion ? { comfyVersion } : {}),
    releaseTag,
    variant,
    pythonVersion,
    hasGit,
    launchArgs: DEFAULT_LAUNCH_ARGS,
    launchMode: 'window',
    ...(hasLegacyEnvs && !hasVenv ? { needsEnvMigration: true } : {}),
  }
}

export async function migrateEnvLayout(
  installPath: string,
  update: (data: Record<string, unknown>) => Promise<unknown>,
  sendProgress?: (step: string, data: { percent: number; status: string }) => void,
): Promise<boolean> {
  const venvDir = getVenvDir(installPath)
  if (fs.existsSync(venvDir)) return false

  const legacyEnvDir = path.join(installPath, 'envs', 'default')
  if (!fs.existsSync(legacyEnvDir)) return false

  sendProgress?.('migration', { percent: 0, status: 'Migrating environment layout…' })

  // Move envs/default/ → ComfyUI/.venv/
  await fs.promises.rename(legacyEnvDir, venvDir)

  // Fix up pyvenv.cfg home path (old path included envs/default/)
  const cfgPath = path.join(venvDir, 'pyvenv.cfg')
  if (fs.existsSync(cfgPath)) {
    let content = await fs.promises.readFile(cfgPath, 'utf-8')
    const oldEnvPath = path.join(installPath, 'envs', 'default')
    content = content.replaceAll(oldEnvPath, venvDir)
    await fs.promises.writeFile(cfgPath, content, 'utf-8')
  }

  // Fix up shebangs on unix
  if (process.platform !== 'win32') {
    const binDir = path.join(venvDir, 'bin')
    if (fs.existsSync(binDir)) {
      const entries = await fs.promises.readdir(binDir, { withFileTypes: true })
      const oldEnvPath = path.join(installPath, 'envs', 'default')
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const filePath = path.join(binDir, entry.name)
        try {
          let content = await fs.promises.readFile(filePath, 'utf-8')
          if (content.startsWith('#!') && content.includes(oldEnvPath)) {
            content = content.replaceAll(oldEnvPath, venvDir)
            await fs.promises.writeFile(filePath, content, 'utf-8')
          }
        } catch {}
      }
    }
  }

  // On macOS, re-codesign moved binaries
  if (process.platform === 'darwin') {
    sendProgress?.('migration', { percent: 50, status: 'Codesigning migrated binaries…' })
    await codesignBinaries(venvDir)
  }

  // Remove empty envs/ directory
  const envsDir = path.join(installPath, 'envs')
  try {
    const remaining = await fs.promises.readdir(envsDir)
    if (remaining.length === 0) {
      await fs.promises.rmdir(envsDir)
    }
  } catch {}

  // Clean up stale metadata fields
  await update({ activeEnv: undefined, envMethods: undefined, needsEnvMigration: undefined })

  sendProgress?.('migration', { percent: 100, status: 'Migration complete' })
  return true
}
