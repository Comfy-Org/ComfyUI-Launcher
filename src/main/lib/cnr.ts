import fs from 'fs'
import path from 'path'
import os from 'os'
import { fetchJSON } from './fetch'
import { download } from './download'
import { extract } from './extract'

interface CnrInstallInfo {
  downloadUrl: string
  version: string
}

const TRACKING_FILE = '.tracking'

/** Validate that a name is a safe single path component (no traversal). */
export function isSafePathComponent(name: string): boolean {
  if (!name || name !== path.basename(name)) return false
  if (name === '.' || name === '..') return false
  return true
}

function walkDir(dir: string, base: string = ''): string[] {
  const results: string[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      results.push(...walkDir(path.join(dir, entry.name), rel))
    } else if (entry.name !== TRACKING_FILE) {
      results.push(rel)
    }
  }
  return results
}

export async function getCnrInstallInfo(
  nodeId: string,
  version?: string,
): Promise<CnrInstallInfo | null> {
  try {
    let url = `https://api.comfy.org/nodes/${encodeURIComponent(nodeId)}/install`
    if (version) {
      url += `?version=${encodeURIComponent(version)}`
    }
    const data = (await fetchJSON(url)) as Record<string, unknown>
    if (!data || typeof data.downloadUrl !== 'string' || typeof data.version !== 'string') {
      return null
    }
    return { downloadUrl: data.downloadUrl as string, version: data.version as string }
  } catch {
    return null
  }
}

export async function installCnrNode(
  nodeId: string,
  version: string,
  customNodesDir: string,
  sendOutput: (text: string) => void,
): Promise<string[]> {
  if (!isSafePathComponent(nodeId)) {
    throw new Error(`Invalid node ID: ${nodeId}`)
  }

  const info = await getCnrInstallInfo(nodeId, version)
  if (!info) {
    throw new Error(`Failed to get install info for ${nodeId}@${version}`)
  }

  const installPath = path.join(customNodesDir, nodeId)
  const tmpZip = path.join(os.tmpdir(), `cnr-${nodeId}-${version}-${Date.now()}.zip`)

  try {
    sendOutput(`Downloading ${nodeId}@${info.version}...\n`)
    await download(info.downloadUrl, tmpZip, null)

    sendOutput(`Extracting ${nodeId}@${info.version}...\n`)
    await fs.promises.mkdir(installPath, { recursive: true })
    await extract(tmpZip, installPath)

    const files = walkDir(installPath)
    await fs.promises.writeFile(path.join(installPath, TRACKING_FILE), files.join('\n') + '\n')

    sendOutput(`Installed ${nodeId}@${info.version}\n`)
    return files
  } finally {
    try {
      await fs.promises.unlink(tmpZip)
    } catch {}
  }
}

export async function switchCnrVersion(
  nodeId: string,
  newVersion: string,
  nodePath: string,
  sendOutput: (text: string) => void,
): Promise<string[]> {
  const info = await getCnrInstallInfo(nodeId, newVersion)
  if (!info) {
    throw new Error(`Failed to get install info for ${nodeId}@${newVersion}`)
  }

  const trackingPath = path.join(nodePath, TRACKING_FILE)
  const oldFiles = new Set<string>()
  try {
    const content = await fs.promises.readFile(trackingPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) oldFiles.add(trimmed)
    }
  } catch {}

  const stamp = Date.now()
  const tmpZip = path.join(os.tmpdir(), `cnr-${nodeId}-${newVersion}-${stamp}.zip`)
  const tmpExtract = path.join(os.tmpdir(), `cnr-${nodeId}-${newVersion}-${stamp}`)

  try {
    sendOutput(`Downloading ${nodeId}@${info.version}...\n`)
    await download(info.downloadUrl, tmpZip, null)

    // Extract to a temp directory first so we can get the true new file list
    // before merging into nodePath (walkDir after in-place extraction would
    // return the union of old+new files, making garbage detection impossible)
    sendOutput(`Extracting ${nodeId}@${info.version}...\n`)
    await fs.promises.mkdir(tmpExtract, { recursive: true })
    await extract(tmpZip, tmpExtract)

    const newFiles = walkDir(tmpExtract)
    const newFileSet = new Set(newFiles)

    // Copy extracted files into nodePath (overwriting existing)
    await fs.promises.mkdir(nodePath, { recursive: true })
    await fs.promises.cp(tmpExtract, nodePath, { recursive: true, force: true })

    const garbageFiles: string[] = []
    const garbageDirs = new Set<string>()
    for (const oldFile of oldFiles) {
      if (!newFileSet.has(oldFile)) {
        garbageFiles.push(oldFile)
        let dir = oldFile
        while (true) {
          const parent = dir.substring(0, dir.lastIndexOf('/'))
          if (!parent) break
          garbageDirs.add(parent)
          dir = parent
        }
      }
    }

    for (const file of garbageFiles) {
      try {
        await fs.promises.unlink(path.join(nodePath, file.split('/').join(path.sep)))
      } catch {}
    }

    const sortedDirs = [...garbageDirs].sort((a, b) => b.length - a.length)
    for (const dir of sortedDirs) {
      try {
        await fs.promises.rmdir(path.join(nodePath, dir.split('/').join(path.sep)))
      } catch {}
    }

    await fs.promises.writeFile(path.join(nodePath, TRACKING_FILE), newFiles.join('\n') + '\n')

    sendOutput(`Switched ${nodeId} to ${info.version}\n`)
    return newFiles
  } finally {
    try { await fs.promises.unlink(tmpZip) } catch {}
    try { await fs.promises.rm(tmpExtract, { recursive: true, force: true }) } catch {}
  }
}
