import fs from 'fs'
import path from 'path'
import { resolveGitDir } from './git'

export const GITCODE_COMFY_ORG_BASE = 'https://gitcode.com/gh_mirrors/co'

const DEFAULT_COMFYUI_URL = 'https://github.com/Comfy-Org/ComfyUI.git'

const COMFY_ORG_RE = /^(?:https?:\/\/|git@)github\.com[/:]Comfy-Org\/([^/]+?)(?:\.git)?\/?$/

export function rewriteCloneUrl(url: string, enabled: boolean): string {
  if (!enabled) return url
  const match = url.match(COMFY_ORG_RE)
  if (!match) return url
  // .git suffix is required — gitcode redirects bare URLs and pygit2/libgit2
  // does not follow the redirect.
  return `${GITCODE_COMFY_ORG_BASE}/${match[1]}.git`
}

export function getComfyUIRemoteUrl(enabled: boolean): string {
  if (!enabled) return DEFAULT_COMFYUI_URL
  return `${GITCODE_COMFY_ORG_BASE}/ComfyUI.git`
}

const GITCODE_COMFY_RE = /^https?:\/\/gitcode\.com\/gh_mirrors\/co\/([^/]+?)(?:\.git)?\/?$/

function restoreGitHubUrl(url: string): string {
  const match = url.match(GITCODE_COMFY_RE)
  if (!match) return url
  return `https://github.com/Comfy-Org/${match[1]}.git`
}

/**
 * Ensure the git remote "origin" uses the correct URL based on the mirror
 * setting. Reads and updates `.git/config` directly so it works even when
 * system git is unavailable (pygit2-only environments).
 */
export async function ensureRemoteUrl(repoPath: string, enabled: boolean): Promise<void> {
  try {
    const gitDir = resolveGitDir(repoPath)
    if (!gitDir) return
    const configPath = path.join(gitDir, 'config')
    const content = await fs.promises.readFile(configPath, 'utf-8')
    const match = content.match(/(\[remote "origin"\][^[]*?url\s*=\s*)(.+)/m)
    if (!match) return
    const currentUrl = match[2]!.trim()
    const desired = enabled ? rewriteCloneUrl(currentUrl, true) : restoreGitHubUrl(currentUrl)
    if (desired === currentUrl) return
    const updated = content.replace(match[0]!, match[1]! + desired)
    await fs.promises.writeFile(configPath, updated, 'utf-8')
  } catch {}
}
