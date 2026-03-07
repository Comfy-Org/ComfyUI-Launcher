import fs from 'fs'
import path from 'path'
import { execFile, spawn } from 'child_process'

/** Regex matching PyTorch-family packages that must never be overwritten by pip. */
export const PYTORCH_RE = /^(torch|torchvision|torchaudio|torchsde)(\s*[<>=!~;[#]|$)/i

/** Run a uv pip command and stream output. Returns the exit code. */
export function runUvPip(
  uvPath: string,
  args: string[],
  cwd: string,
  sendOutput: (text: string) => void,
  signal?: AbortSignal
): Promise<number> {
  if (signal?.aborted) return Promise.resolve(1)
  return new Promise<number>((resolve) => {
    const proc = spawn(uvPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const onAbort = (): void => {
      proc.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    proc.stdout.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
    proc.stderr.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      sendOutput(`Error: ${err.message}\n`)
      resolve(1)
    })
    proc.on('exit', (code) => {
      signal?.removeEventListener('abort', onAbort)
      resolve(code ?? 1)
    })
  })
}

/**
 * Read a requirements file, filter out PyTorch packages, write a temp file,
 * and install via `uv pip install -r`. Cleans up the temp file afterward.
 * Returns the exit code (0 = success).
 */
export async function installFilteredRequirements(
  reqPath: string,
  uvPath: string,
  pythonPath: string,
  installPath: string,
  tempName: string,
  sendOutput: (text: string) => void,
  signal?: AbortSignal
): Promise<number> {
  const content = await fs.promises.readFile(reqPath, 'utf-8')
  const filtered = content.split('\n').filter((l) => !PYTORCH_RE.test(l.trim())).join('\n')
  const filteredPath = path.join(installPath, tempName)
  await fs.promises.writeFile(filteredPath, filtered, 'utf-8')

  try {
    return await runUvPip(uvPath, ['pip', 'install', '-r', filteredPath, '--python', pythonPath], installPath, sendOutput, signal)
  } finally {
    try { await fs.promises.unlink(filteredPath) } catch {}
  }
}

export async function pipFreeze(uvPath: string, pythonPath: string): Promise<Record<string, string>> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      uvPath,
      ['pip', 'freeze', '--python', pythonPath],
      { windowsHide: true, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr ? stderr.slice(0, 500) : err.message
          return reject(new Error(`uv pip freeze failed: ${detail}`))
        }
        resolve(stdout)
      }
    )
  })

  const packages: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // Editable installs: "-e git+https://...@commit#egg=name"
    if (trimmed.startsWith('-e ')) {
      const eggMatch = trimmed.match(/#egg=(.+)/)
      if (eggMatch) {
        packages[eggMatch[1]!] = trimmed
      }
      continue
    }
    // PEP 508 direct references: "package @ git+https://..." or "package @ file:///..."
    const atMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*@\s*(.+)$/)
    if (atMatch) {
      packages[atMatch[1]!] = atMatch[2]!.trim()
      continue
    }
    // Standard: "package==version"
    const eqIdx = trimmed.indexOf('==')
    if (eqIdx > 0) {
      packages[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 2)
    }
  }
  return packages
}
