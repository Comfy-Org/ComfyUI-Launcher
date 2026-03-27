import fs from 'fs'
import path from 'path'
import { execFile, spawn } from 'child_process'
import { killProcTree } from './process'

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
      detached: process.platform !== 'win32',
    })

    const onAbort = (): void => {
      killProcTree(proc)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    proc.stdout.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
    proc.stderr.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      sendOutput(`Error: ${err.message}\n`)
      resolve(1)
    })
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      resolve(code ?? 1)
    })
  })
}

export interface PipMirrorConfig {
  pypiMirror?: string
  useChineseMirrors?: boolean
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
  signal?: AbortSignal,
  mirrors?: PipMirrorConfig
): Promise<number> {
  const content = await fs.promises.readFile(reqPath, 'utf-8')
  const filtered = content.split('\n').filter((l) => !PYTORCH_RE.test(l.trim())).join('\n')
  const filteredPath = path.join(installPath, tempName)
  await fs.promises.writeFile(filteredPath, filtered, 'utf-8')

  try {
    const indexArgs = getPipIndexArgs(mirrors?.pypiMirror, mirrors?.useChineseMirrors)
    return await runUvPip(uvPath, ['pip', 'install', '-r', filteredPath, '--python', pythonPath, ...indexArgs], installPath, sendOutput, signal)
  } finally {
    try { await fs.promises.unlink(filteredPath) } catch {}
  }
}

/** The canonical PyPI index — always used as the primary `--index-url`. */
export const PYPI_INDEX_URL = 'https://pypi.org/simple/'

/**
 * Additional PyPI mirror URLs for users in regions with restricted access
 * to the default package source (e.g. China). Mirrors Desktop's constant.
 */
export const PYPI_MIRROR_URLS: string[] = [
  'https://mirrors.aliyun.com/pypi/simple/',
  'https://mirrors.cloud.tencent.com/pypi/simple/',
]

/**
 * Build `--index-url` and `--extra-index-url` arguments for uv pip commands.
 *
 * When a user-configured `pypiMirror` is set, it becomes the primary
 * `--index-url` and pypi.org is demoted to `--extra-index-url`.
 *
 * When `useChineseMirrors` is true (and no user mirror is set), the first
 * Chinese mirror becomes `--index-url` and pypi.org is an extra fallback.
 * This avoids the slowdown caused by uv's `first-match` strategy checking
 * the (unreachable) pypi.org before falling back to the Chinese mirrors.
 *
 * When neither is set, pypi.org remains the primary `--index-url`.
 */

/** Trim whitespace and ensure a trailing slash for consistent URL comparison. */
function normalizeIndexUrl(url: string): string {
  const trimmed = url.trim()
  return trimmed.endsWith('/') ? trimmed : trimmed + '/'
}

export function getPipIndexArgs(pypiMirror?: string, useChineseMirrors?: boolean): string[] {
  const mirror = pypiMirror?.trim() || undefined

  // Determine the primary --index-url:
  // 1. User-provided mirror takes highest priority
  // 2. First Chinese mirror when useChineseMirrors is enabled
  // 3. Default pypi.org
  let primary: string
  if (mirror) {
    primary = mirror
  } else if (useChineseMirrors && PYPI_MIRROR_URLS.length > 0) {
    primary = PYPI_MIRROR_URLS[0]!
  } else {
    primary = PYPI_INDEX_URL
  }

  const args: string[] = ['--index-url', primary]
  const seen = new Set<string>([normalizeIndexUrl(primary)])
  const extras: string[] = []

  // Add pypi.org as a fallback extra when it's not the primary
  const pypiNorm = normalizeIndexUrl(PYPI_INDEX_URL)
  if (!seen.has(pypiNorm)) {
    extras.push(PYPI_INDEX_URL)
    seen.add(pypiNorm)
  }

  if (useChineseMirrors) {
    for (const url of PYPI_MIRROR_URLS) {
      const norm = normalizeIndexUrl(url)
      if (!seen.has(norm)) {
        extras.push(url)
        seen.add(norm)
      }
    }
  }

  for (const url of extras) {
    args.push('--extra-index-url', url)
  }
  return args
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
