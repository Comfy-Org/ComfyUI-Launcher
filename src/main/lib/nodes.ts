import fs from 'fs'
import path from 'path'

export interface ScannedNode {
  id: string
  type: 'cnr' | 'git' | 'file'
  dirName: string
  enabled: boolean
  version?: string
  commit?: string
  url?: string
}

function readGitHead(repoPath: string): string | null {
  const headPath = path.join(repoPath, '.git', 'HEAD')
  try {
    const content = fs.readFileSync(headPath, 'utf-8').trim()
    // Detached HEAD — contains sha directly
    if (!content.startsWith('ref: ')) return content || null
    // Symbolic ref — resolve it
    const refPath = path.join(repoPath, '.git', content.slice(5))
    try {
      return fs.readFileSync(refPath, 'utf-8').trim() || null
    } catch {
      // Try packed-refs as fallback
      const packedRefsPath = path.join(repoPath, '.git', 'packed-refs')
      try {
        const packed = fs.readFileSync(packedRefsPath, 'utf-8')
        const ref = content.slice(5)
        for (const line of packed.split('\n')) {
          if (line.startsWith('#') || !line.trim()) continue
          const [sha, name] = line.trim().split(/\s+/)
          if (name === ref) return sha || null
        }
      } catch {}
      return null
    }
  } catch {
    return null
  }
}

function readGitRemoteUrl(repoPath: string): string | null {
  const configPath = path.join(repoPath, '.git', 'config')
  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    const match = content.match(/\[remote "origin"\][^[]*?url\s*=\s*(.+)/m)
    return match ? match[1]!.trim() : null
  } catch {
    return null
  }
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
    const fieldMatch = section.match(new RegExp(`^${field}\\s*=\\s*"([^"]*)"`, 'm'))
    return fieldMatch ? fieldMatch[1]! : null
  } catch {
    return null
  }
}

function identifyNode(nodePath: string): Omit<ScannedNode, 'enabled'> {
  const dirName = path.basename(nodePath)
  const trackingPath = path.join(nodePath, '.tracking')
  const tomlPath = path.join(nodePath, 'pyproject.toml')
  const gitDir = path.join(nodePath, '.git')

  // CNR node: has .tracking file
  if (fs.existsSync(trackingPath)) {
    const id = readTomlProjectField(tomlPath, 'name') || dirName
    const version = readTomlProjectField(tomlPath, 'version') || undefined
    return { id, type: 'cnr', dirName, version }
  }

  // Git node: has .git/ directory
  if (fs.existsSync(gitDir)) {
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
