import net from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { _electron as electron, type ElectronApplication } from 'playwright'

export interface LauncherAppHandle {
  application: ElectronApplication
  homeDir: string
  cleanup: () => Promise<void>
}

function buildIsolatedEnv(homeDir: string): Record<string, string> {
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )

  const env: Record<string, string> = {
    ...inheritedEnv,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(homeDir, '.local', 'state'),
  }

  // On Windows, Electron resolves userData via APPDATA (%APPDATA%\<appName>).
  // Point it into the isolated home so the app doesn't touch the real profile.
  if (process.platform === 'win32') {
    env['APPDATA'] = path.join(homeDir, 'AppData', 'Roaming')
  }

  return env
}

export async function launchLauncherApp(): Promise<LauncherAppHandle> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-e2e-'))

  // Pre-create directories that Electron expects to exist
  if (process.platform === 'win32') {
    await mkdir(path.join(homeDir, 'AppData', 'Roaming'), { recursive: true })
  }

  // Linux CI runners lack the SUID sandbox binary; disable it the same way linux-dev.sh does.
  const args = ['.']
  if (process.platform === 'linux') {
    args.push('--no-sandbox')
  }

  const application = await electron.launch({
    args,
    env: buildIsolatedEnv(homeDir),
  })

  const cleanup = async (): Promise<void> => {
    try {
      const proc = application.process()
      if (proc && proc.exitCode === null) {
        await application.close().catch(() => {})
      }
    } catch {
      // Application already closed / disconnected — nothing to clean up.
    }
    await rm(homeDir, { recursive: true, force: true })
  }

  return { application, homeDir, cleanup }
}

/**
 * Reserve a port by binding to :0, record the assigned port, then close
 * the server so nothing is listening.  This guarantees the port is free
 * (no accidental collisions) but has nothing behind it — exactly the
 * state the Vite dev server is in when it hasn't started yet.
 */
async function findDeadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
    srv.on('error', reject)
  })
}

/**
 * Launch the app in simulated dev mode where the Vite dev server is NOT
 * ready yet: ELECTRON_RENDERER_URL points at a port with nothing listening.
 *
 * This reproduces issue #283 — loadURL fails with ERR_CONNECTION_REFUSED,
 * ready-to-show never fires, and the window stays invisible unless the
 * main process has a fallback.
 */
export async function launchLauncherAppDev(): Promise<LauncherAppHandle> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-e2e-'))

  if (process.platform === 'win32') {
    await mkdir(path.join(homeDir, 'AppData', 'Roaming'), { recursive: true })
  }

  // Point at a port where nothing is listening — connection will be refused.
  const deadPort = await findDeadPort()

  const args = ['.']
  if (process.platform === 'linux') {
    args.push('--no-sandbox')
  }

  const env = buildIsolatedEnv(homeDir)
  env['ELECTRON_RENDERER_URL'] = `http://127.0.0.1:${deadPort}`

  const application = await electron.launch({ args, env })

  const cleanup = async (): Promise<void> => {
    try {
      const proc = application.process()
      if (proc && proc.exitCode === null) {
        await application.close().catch(() => {})
      }
    } catch {
      // Application already closed / disconnected.
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
