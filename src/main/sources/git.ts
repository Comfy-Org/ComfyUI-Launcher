import fs from 'fs'
import path from 'path'
import { fetchJSON } from '../lib/fetch'
import { deleteAction, untrackAction } from '../lib/actions'
import { t } from '../lib/i18n'
import type { InstallationRecord } from '../installations'
import type { SourcePlugin, FieldOption, ActionResult, ActionTools } from '../types/sources'

const DEFAULT_REPO = 'https://github.com/Comfy-Org/ComfyUI/'

interface GitHubParsed {
  owner: string
  repo: string
}

function parseGitHubRepo(url: string): GitHubParsed | null {
  const cleaned = url.trim().replace(/\/+$/, '')
  const sshMatch = cleaned.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
  if (sshMatch) {
    return { owner: sshMatch[1]!, repo: sshMatch[2]!.replace(/\.git$/, '') }
  }
  try {
    const parsed = new URL(cleaned)
    if (!parsed.hostname.match(/^(www\.)?github\.com$/)) return null
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/')
    if (parts.length < 2) return null
    return { owner: parts[0]!, repo: parts[1]! }
  } catch {
    return null
  }
}

export const gitSource: SourcePlugin = {
  id: 'git',
  get label() { return t('git.label') },
  get description() { return t('git.desc') },
  category: 'local',

  fields: [
    { id: 'repo', label: 'Git Repository', type: 'text',
      defaultValue: DEFAULT_REPO,
      action: { label: 'Update' } },
    { id: 'branch', label: 'Branch', type: 'select', errorTarget: 'repo' },
    { id: 'commit', label: 'Commit', type: 'select', errorTarget: 'repo' },
  ],

  buildInstallation(selections: Record<string, FieldOption | undefined>): Record<string, unknown> {
    return {
      version: selections.commit?.value?.slice(0, 8) ?? 'unknown',
      repo: selections.repo?.value ?? DEFAULT_REPO,
      branch: selections.branch?.value ?? '',
      commit: selections.commit?.value ?? '',
      commitMessage: selections.commit?.label ?? '',
    }
  },

  getLaunchCommand(_installation: InstallationRecord) {
    return null
  },

  getListActions(_installation: InstallationRecord) {
    return [
      { id: 'launch', label: 'Launch', style: 'primary', enabled: false },
    ]
  },

  getDetailSections(installation: InstallationRecord) {
    return [
      {
        title: 'Installation Info',
        fields: [
          { label: 'Install Method', value: installation.sourceLabel as string },
          { label: 'Repository', value: (installation.repo as string) || '—' },
          { label: 'Branch', value: (installation.branch as string) || '—' },
          { label: 'Commit', value: (installation.commit as string) || '—' },
          { label: 'Location', value: installation.installPath || '—' },
          { label: 'Installed', value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
      {
        title: 'Launch Settings',
        fields: [
          { id: 'browserPartition', label: 'Browser Cache',
            value: (installation.browserPartition as string) || 'shared',
            editable: true,
            editType: 'select',
            options: [
              { value: 'shared', label: 'Shared' },
              { value: 'unique', label: 'Unique to this install' },
            ] },
        ],
      },
      {
        title: 'Actions',
        pinBottom: true,
        actions: [
          { id: 'launch', label: 'Launch', style: 'primary', enabled: false },
          { id: 'open-folder', label: 'Open Directory', style: 'default', enabled: !!installation.installPath },
          { id: 'pull', label: 'Git Pull', style: 'default', enabled: false },
          deleteAction(installation),
          untrackAction(),
        ],
      },
    ]
  },

  probeInstallation(dirPath: string): Record<string, unknown> | null {
    if (!fs.existsSync(path.join(dirPath, '.git'))) return null
    const info: Record<string, unknown> = { version: 'unknown', repo: '', branch: '', commit: '' }
    try {
      const head = fs.readFileSync(path.join(dirPath, '.git', 'HEAD'), 'utf-8').trim()
      const branchMatch = head.match(/^ref: refs\/heads\/(.+)$/)
      if (branchMatch && branchMatch[1]) info.branch = branchMatch[1]
      const configRaw = fs.readFileSync(path.join(dirPath, '.git', 'config'), 'utf-8')
      const urlMatch = configRaw.match(/url\s*=\s*(.+)/)
      if (urlMatch) info.repo = urlMatch[1]!.trim()
    } catch {
      // ignore — partial info is fine
    }
    return info
  },

  async handleAction(
    actionId: string,
    _installation: InstallationRecord,
    _actionData: Record<string, unknown> | undefined,
    _tools: ActionTools
  ): Promise<ActionResult> {
    return { ok: false, message: `Action "${actionId}" not yet implemented.` }
  },

  async getFieldOptions(
    fieldId: string,
    selections: Record<string, FieldOption | undefined>,
    _context: Record<string, unknown>
  ): Promise<FieldOption[]> {
    if (fieldId === 'branch') {
      const parsed = parseGitHubRepo(selections.repo?.value ?? '')
      if (!parsed) throw new Error('Invalid GitHub repository URL.')
      const [repoInfo, branches] = await Promise.all([
        fetchJSON(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`) as Promise<{ default_branch: string }>,
        fetchJSON(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/branches?per_page=100`) as Promise<{ name: string }[]>,
      ])
      const defaultBranch = repoInfo.default_branch
      branches.sort((a, b) =>
        (a.name === defaultBranch ? 0 : 1) - (b.name === defaultBranch ? 0 : 1)
      )
      return branches.map((b) => ({
        value: b.name,
        label: b.name === defaultBranch ? `${b.name} (default)` : b.name,
      }))
    }
    if (fieldId === 'commit') {
      const parsed = parseGitHubRepo(selections.repo?.value ?? '')
      if (!parsed) throw new Error('Invalid GitHub repository URL.')
      const branch = selections.branch?.value
      if (!branch) return []
      const commits = await fetchJSON(
        `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits?sha=${encodeURIComponent(branch)}&per_page=30`
      ) as { sha: string; commit: { message: string } }[]
      return commits.map((c) => ({
        value: c.sha,
        label: `${c.sha.slice(0, 8)} — ${c.commit.message.split('\n')[0]}`,
      }))
    }
    return []
  },
}
