import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { _electron as electron, type ElectronApplication } from 'playwright'

export interface LauncherAppHandle {
  application: ElectronApplication
  homeDir: string
  cleanup: () => Promise<void>
}

function buildIsolatedEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(homeDir, '.local', 'state'),
  }
}

export async function launchLauncherApp(): Promise<LauncherAppHandle> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-e2e-'))
  const application = await electron.launch({
    args: ['.'],
    env: buildIsolatedEnv(homeDir),
  })

  const cleanup = async (): Promise<void> => {
    if (application.process().exitCode === null) {
      await application.close().catch(() => {})
    }
    await rm(homeDir, { recursive: true, force: true })
  }

  return { application, homeDir, cleanup }
}

export async function waitForAppExit(application: ElectronApplication, timeoutMs = 10_000): Promise<void> {
  const child = application.process()
  if (child.exitCode !== null) return

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error(`Electron app did not exit within ${timeoutMs}ms`))
    }, timeoutMs)

    const onExit = (): void => {
      clearTimeout(timer)
      resolve()
    }

    child.once('exit', onExit)
  })
}
