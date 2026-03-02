import { execFile } from 'child_process'

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
