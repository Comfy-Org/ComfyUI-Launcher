import fs from 'fs'
import path from 'path'
import { hasGitDir, readGitHead, readGitRemoteUrl } from './git'

export interface ScannedNode {
  id: string
  type: 'cnr' | 'git' | 'file'
  dirName: string
  enabled: boolean
  version?: string
  commit?: string
  url?: string
}

/** Stable unique key for a node — used for snapshot comparisons and diffs. */
export function nodeKey(node: ScannedNode): string {
  return `${node.type}:${node.dirName}`
}

function readTomlProjectField(tomlPath: string, field: string): string | null {
  try {
    const content = fs.readFileSync(tomlPath, 'utf-8')
    // Simple TOML parser: find [project] section, then the field
    const projectMatch = content.match(/\[project\]/)
    if (!projectMatch) return null
    const afterProject = content.slice(projectMatch.index! + projectMatch[0].length)
    // Stop at next section header
    const nextSection = afterProject.search(/^\[/m)
    const section = nextSection >= 0 ? afterProject.slice(0, nextSection) : afterProject
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const fieldMatch = section.match(new RegExp(`^${escapedField}\\s*=\\s*["']([^"']*)["']`, 'm'))
    return fieldMatch ? fieldMatch[1]! : null
  } catch {
    return null
  }
}

function identifyNode(nodePath: string): Omit<ScannedNode, 'enabled'> {
  const dirName = path.basename(nodePath)
  const trackingPath = path.join(nodePath, '.tracking')
  const tomlPath = path.join(nodePath, 'pyproject.toml')

  // CNR node: has .tracking file
  if (fs.existsSync(trackingPath)) {
    const id = readTomlProjectField(tomlPath, 'name') || dirName
    const version = readTomlProjectField(tomlPath, 'version') || undefined
    return { id, type: 'cnr', dirName, version }
  }

  // Git node: has .git/ directory (or .git file for worktrees/submodules)
  if (hasGitDir(nodePath)) {
    const commit = readGitHead(nodePath) || undefined
    const url = readGitRemoteUrl(nodePath) || undefined
    return { id: dirName, type: 'git', dirName, commit, url }
  }

  // Unknown directory node — treat as git without metadata
  return { id: dirName, type: 'git', dirName }
}

export async function scanCustomNodes(comfyuiDir: string): Promise<ScannedNode[]> {
  const customNodesDir = path.join(comfyuiDir, 'custom_nodes')
  const disabledDir = path.join(customNodesDir, '.disabled')
  const nodes: ScannedNode[] = []

  // Scan active nodes
  try {
    const entries = await fs.promises.readdir(customNodesDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__') continue
      const fullPath = path.join(customNodesDir, entry.name)
      if (entry.isDirectory()) {
        nodes.push({ ...identifyNode(fullPath), enabled: true })
      } else if (entry.name.endsWith('.py')) {
        nodes.push({ id: entry.name, type: 'file', dirName: entry.name, enabled: true })
      }
    }
  } catch {}

  // Scan disabled nodes
  try {
    const entries = await fs.promises.readdir(disabledDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__') continue
      if (entry.isDirectory()) {
        nodes.push({ ...identifyNode(path.join(disabledDir, entry.name)), enabled: false })
      }
    }
  } catch {}

  return nodes
}
