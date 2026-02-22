import { spawn, execFile, type ChildProcess } from 'child_process'
import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import net from 'net'
import { stateDir } from './paths'

export interface WaitOptions {
  timeoutMs?: number
  intervalMs?: number
  onPoll?: (info: { attempt: number; elapsedMs: number }) => void
  signal?: AbortSignal
}

export interface ProcessInfo {
  name: string
  commandLine: string
}

export interface LaunchCmd {
  args: string[]
  port: number
}

interface PortLock {
  pid: number
  installationName: string
  timestamp: number
}

export function spawnProcess(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): ChildProcess {
  return spawn(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    env: env || process.env,
  })
}

export function killProcessTree(proc: ChildProcess | null): void {
  if (!proc || proc.killed) return
  if (process.platform === "win32") {
    execFile("taskkill", ["/T", "/F", "/PID", String(proc.pid)], { windowsHide: true }, () => {})
  } else {
    try { process.kill(-proc.pid!, "SIGKILL") } catch {}
  }
}

export function findPidsByPort(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("netstat", ["-ano", "-p", "TCP"], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve([])
        const pids = new Set<number>()
        const target = `:${port}`
        for (const line of stdout.split("\n")) {
          const parts = line.trim().split(/\s+/)
          // Format: Proto  LocalAddress  ForeignAddress  State  PID
          if (parts.length >= 5 && parts[3] === "LISTENING") {
            const addr = parts[1]
            // Match exactly :port at the end of the address (e.g. 0.0.0.0:8188 or 127.0.0.1:8188)
            if (addr && addr.endsWith(target)) {
              const pid = parseInt(parts[4]!, 10)
              if (pid > 0) pids.add(pid)
            }
          }
        }
        resolve([...pids])
      })
    } else {
      execFile("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t"], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve([])
        const pids = stdout.trim().split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => n > 0)
        resolve(pids)
      })
    }
  })
}

export function killByPort(port: number): Promise<void> {
  return findPidsByPort(port).then((pids) => {
    if (pids.length === 0) return
    if (process.platform === "win32") {
      const args: string[] = []
      for (const pid of pids) args.push("/F", "/T", "/PID", String(pid))
      return new Promise<void>((resolve) => {
        execFile("taskkill", args, { windowsHide: true }, () => resolve())
      })
    }
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL") } catch {}
    }
  })
}

export function waitForPort(port: number, host: string = "127.0.0.1", { timeoutMs = 60000, intervalMs = 500, onPoll, signal }: WaitOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    let attempt = 0

    const poll = (): void => {
      if (signal && signal.aborted) { reject(new Error("Launch cancelled.")); return }
      const elapsed = Date.now() - start
      if (elapsed > timeoutMs) {
        reject(new Error(`Timed out waiting for port ${port} after ${Math.round(elapsed / 1000)}s`))
        return
      }

      attempt++
      if (onPoll) onPoll({ attempt, elapsedMs: elapsed })

      const req = http.get({ host, port, path: "/", timeout: 2000 }, (res) => {
        res.resume()
        resolve()
      })

      req.on("error", () => setTimeout(poll, intervalMs))
      req.on("timeout", () => {
        req.destroy()
        setTimeout(poll, intervalMs)
      })
    }

    poll()
  })
}

export function waitForUrl(url: string, { timeoutMs = 60000, intervalMs = 500, onPoll, signal }: WaitOptions = {}): Promise<void> {
  const client = url.startsWith("https") ? https : http
  return new Promise((resolve, reject) => {
    const start = Date.now()
    let attempt = 0

    const poll = (): void => {
      if (signal && signal.aborted) { reject(new Error("Launch cancelled.")); return }
      const elapsed = Date.now() - start
      if (elapsed > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url} after ${Math.round(elapsed / 1000)}s`))
        return
      }

      attempt++
      if (onPoll) onPoll({ attempt, elapsedMs: elapsed })

      const req = client.get(url, { timeout: 2000 }, (res) => {
        res.resume()
        resolve()
      })

      req.on("error", () => setTimeout(poll, intervalMs))
      req.on("timeout", () => {
        req.destroy()
        setTimeout(poll, intervalMs)
      })
    }

    poll()
  })
}

export function getProcessInfo(pid: number): Promise<ProcessInfo | null> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      // Use PowerShell Get-CimInstance with JSON output (wmic is deprecated/removed on modern Windows)
      const cmd = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object Name,CommandLine | ConvertTo-Json`
      execFile("powershell", ["-NoProfile", "-Command", cmd],
        { windowsHide: true }, (err, stdout) => {
          if (err) return resolve(null)
          try {
            const obj = JSON.parse(stdout) as { Name?: string; CommandLine?: string }
            resolve({ name: obj.Name || "", commandLine: obj.CommandLine || "" })
          } catch {
            resolve(null)
          }
        })
    } else {
      execFile("ps", ["-p", String(pid), "-o", "comm=,args="], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null)
        const parts = stdout.trim().split(/\s+/)
        resolve({
          name: parts[0] ?? "",
          commandLine: stdout.trim(),
        })
      })
    }
  })
}

export function looksLikeComfyUI(info: ProcessInfo | null): boolean {
  if (!info) return false
  const cmd = (info.commandLine || "").toLowerCase()
  // Match ComfyUI's main.py entry point and any path containing "comfyui"
  return cmd.includes("main.py") && cmd.includes("comfyui")
}

export function setPortArg(launchCmd: LaunchCmd, port: number): void {
  const portIdx = launchCmd.args.indexOf("--port")
  if (portIdx >= 0 && launchCmd.args[portIdx + 1] != null) {
    launchCmd.args[portIdx + 1] = String(port)
  } else {
    launchCmd.args.push("--port", String(port))
  }
  launchCmd.port = port
}

export function findAvailablePort(host: string, startPort: number, endPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    function tryPort(port: number): void {
      if (port > endPort) {
        reject(new Error(`No available ports found between ${startPort} and ${endPort}`))
        return
      }
      const server = net.createServer()
      server.listen(port, host, () => {
        server.once("close", () => resolve(port))
        server.close()
      })
      server.on("error", () => tryPort(port + 1))
    }
    tryPort(startPort)
  })
}

// --- Port lock files ---
// When the launcher spawns ComfyUI on a port, it writes a lock file so other
// launcher instances can identify the owner without inspecting process trees.

function portLockDir(): string {
  return path.join(stateDir(), "port-locks")
}

function portLockPath(port: number): string {
  return path.join(portLockDir(), `port-${port}.json`)
}

export function writePortLock(port: number, { pid, installationName }: { pid: number; installationName: string }): void {
  const dir = portLockDir()
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  const data: PortLock = { pid, installationName, timestamp: Date.now() }
  try { fs.writeFileSync(portLockPath(port), JSON.stringify(data)) } catch {}
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return Boolean(e && (e as NodeJS.ErrnoException).code === "EPERM")
  }
}

export function readPortLock(port: number): PortLock | null {
  try {
    const raw = fs.readFileSync(portLockPath(port), "utf-8")
    const lock = JSON.parse(raw) as PortLock | null
    if (!lock || !lock.pid || !isProcessAlive(lock.pid)) {
      // Stale lock — clean it up
      removePortLock(port)
      return null
    }
    return lock
  } catch {
    return null
  }
}

export function removePortLock(port: number): void {
  try { fs.unlinkSync(portLockPath(port)) } catch {}
}
