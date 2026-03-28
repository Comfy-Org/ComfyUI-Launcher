import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { getVenvDir } from './envPaths'

export async function removeQuarantine(dir: string, log?: (text: string) => void): Promise<void> {
  if (process.platform !== 'darwin') return
  await new Promise<void>((resolve) => {
    execFile('xattr', ['-dr', 'com.apple.quarantine', dir], (err) => {
      if (err && log) log(`⚠ removeQuarantine: ${err.message}\n`)
      resolve()
    })
  })
}

export async function repairMacBinaries(
  installPath: string,
  sendProgress: (step: string, data: { percent: number; status: string; [key: string]: unknown }) => void,
  sendOutput?: (text: string) => void
): Promise<void> {
  if (process.platform !== 'darwin') return
  const standaloneEnvDir = path.join(installPath, 'standalone-env')
  sendProgress('repair', { percent: -1, status: 'Removing quarantine flags…' })
  await removeQuarantine(standaloneEnvDir, sendOutput)
  sendProgress('repair', { percent: -1, status: 'Codesigning binaries…' })
  await codesignBinaries(standaloneEnvDir, sendOutput)
  const venvDir = getVenvDir(installPath)
  if (fs.existsSync(venvDir)) {
    sendProgress('repair', { percent: -1, status: 'Codesigning environment binaries…' })
    await removeQuarantine(venvDir, sendOutput)
    await codesignBinaries(venvDir, sendOutput)
  }
}

const NON_BINARY_EXTENSIONS = new Set([
  '.py', '.pyc', '.pyo', '.pyi', '.pyd',
  '.txt', '.md', '.rst', '.json', '.yaml', '.yml', '.toml', '.cfg', '.ini', '.csv',
  '.html', '.htm', '.css', '.js', '.ts', '.xml', '.svg',
  '.h', '.c', '.cpp', '.hpp', '.pxd', '.pyx',
  '.sh', '.bat', '.ps1',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot',
  '.egg-info', '.dist-info', '.data',
  '.typed', '.LICENSE', '.license',
])

function hasNonBinaryExtension(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return NON_BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

async function isMachO(filePath: string): Promise<boolean> {
  let fh: fs.promises.FileHandle | undefined
  try {
    fh = await fs.promises.open(filePath, 'r')
    const buf = Buffer.alloc(4)
    await fh.read(buf, 0, 4, 0)
    // Mach-O magic numbers: MH_MAGIC, MH_CIGAM, MH_MAGIC_64, MH_CIGAM_64, FAT_MAGIC, FAT_CIGAM
    const magic = buf.readUInt32BE(0)
    return (
      magic === 0xfeedface || magic === 0xcefaedfe ||
      magic === 0xfeedfacf || magic === 0xcffaedfe ||
      magic === 0xcafebabe || magic === 0xbebafeca
    )
  } catch {
    return false
  } finally {
    await fh?.close()
  }
}

export async function codesignBinaries(dir: string, log?: (text: string) => void): Promise<void> {
  if (process.platform !== 'darwin') return
  const CONCURRENCY = 8
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let items: fs.Dirent[]
    try { items = await fs.promises.readdir(current, { withFileTypes: true }) } catch { continue }
    const candidates: string[] = []
    for (const item of items) {
      const full = path.join(current, item.name)
      if (item.isDirectory()) {
        stack.push(full)
      } else if (item.name.endsWith('.dylib') || item.name.endsWith('.so')) {
        candidates.push(full)
      } else if (!hasNonBinaryExtension(item.name)) {
        candidates.push(full)
      }
    }
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      await Promise.all(candidates.slice(i, i + CONCURRENCY).map((f) => checkAndSign(f, log)))
    }
  }
}

async function checkAndSign(filePath: string, log?: (text: string) => void): Promise<void> {
  const name = path.basename(filePath)
  if (!name.endsWith('.dylib') && !name.endsWith('.so') && !await isMachO(filePath)) return
  return new Promise<void>((resolve) => {
    execFile('codesign', ['--force', '--sign', '-', filePath], (err) => {
      if (err && log) log(`⚠ codesign failed: ${filePath}: ${err.message}\n`)
      resolve()
    })
  })
}
