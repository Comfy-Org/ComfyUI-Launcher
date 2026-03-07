import fs from 'fs'
import path from 'path'
import { spawn, execFile } from 'child_process'
import { fetchJSON } from '../lib/fetch'
import { deleteAction, untrackAction } from '../lib/actions'
import { parseArgs, extractPort } from '../lib/util'
import { t } from '../lib/i18n'
import type { InstallationRecord } from '../installations'
import type { SourcePlugin, FieldOption, ActionResult, ActionTools, LaunchCommand } from '../types/sources'

const DEFAULT_REPO = 'https://github.com/Comfy-Org/ComfyUI/'
const DEFAULT_LAUNCH_ARGS = ''

const VENV_CANDIDATES = ['.venv', 'venv', '.env', 'env']

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

function findVenv(dirPath: string): string | null {
  for (const name of VENV_CANDIDATES) {
    const venvDir = path.join(dirPath, name)
    if (fs.existsSync(path.join(venvDir, 'pyvenv.cfg'))) return venvDir
  }
  return null
}

function getVenvPython(venvDir: string): string {
  if (process.platform === 'win32') {
    return path.join(venvDir, 'Scripts', 'python.exe')
  }
  const python3 = path.join(venvDir, 'bin', 'python3')
  if (fs.existsSync(python3)) return python3
  return path.join(venvDir, 'bin', 'python')
}

function resolveVenvPython(installation: InstallationRecord): string | null {
  const venvPath = installation.venvPath as string | undefined
  if (!venvPath) return null
  const pythonPath = getVenvPython(venvPath)
  if (fs.existsSync(pythonPath)) return pythonPath
  return null
}

function findGit(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  return new Promise((resolve) => {
    execFile(cmd, ['git'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const gitPath = stdout.trim().split(/\r?\n/)[0]
      resolve(gitPath || null)
    })
  })
}

function findMainPy(dirPath: string): string | null {
  const direct = path.join(dirPath, 'main.py')
  if (fs.existsSync(direct)) return direct
  const nested = path.join(dirPath, 'ComfyUI', 'main.py')
  if (fs.existsSync(nested)) return nested
  return null
}

export const gitSource: SourcePlugin = {
  id: 'git',
  get label() { return t('git.label') },
  get description() { return t('git.desc') },
  category: 'local',
  hidden: true,
  hasConsole: true,

  fields: [
    { id: 'repo', label: 'Git Repository', type: 'text',
      defaultValue: DEFAULT_REPO,
      action: { label: 'Update' } },
    { id: 'branch', label: 'Branch', type: 'select', errorTarget: 'repo' },
    { id: 'commit', label: 'Commit', type: 'select', errorTarget: 'repo' },
  ],

  skipInstall: true,

  getDefaults() {
    return { launchArgs: DEFAULT_LAUNCH_ARGS, launchMode: 'console', browserPartition: 'shared' }
  },

  buildInstallation(selections: Record<string, FieldOption | undefined>): Record<string, unknown> {
    return {
      version: selections.commit?.value?.slice(0, 8) ?? 'unknown',
      repo: selections.repo?.value ?? DEFAULT_REPO,
      branch: selections.branch?.value ?? '',
      commit: selections.commit?.value ?? '',
      commitMessage: selections.commit?.label ?? '',
      launchArgs: DEFAULT_LAUNCH_ARGS,
      launchMode: 'console',
      browserPartition: 'shared',
    }
  },

  getLaunchCommand(installation: InstallationRecord): LaunchCommand | null {
    const pythonPath = resolveVenvPython(installation)
    if (!pythonPath) return null
    const mainPy = findMainPy(installation.installPath)
    if (!mainPy) return null
    const userArgs = ((installation.launchArgs as string | undefined) ?? DEFAULT_LAUNCH_ARGS).trim()
    const parsed = userArgs.length > 0 ? parseArgs(userArgs) : []
    const port = extractPort(parsed)
    const relMainPy = path.relative(installation.installPath, mainPy)
    return {
      cmd: pythonPath,
      args: ['-s', relMainPy, ...parsed],
      cwd: installation.installPath,
      port,
    }
  },

  getListPreview(installation: InstallationRecord): string | null {
    const repo = installation.repo as string | undefined
    const branch = installation.branch as string | undefined
    if (repo && branch) return `${repo} (${branch})`
    return repo || null
  },

  getListActions(installation: InstallationRecord): Record<string, unknown>[] {
    const installed = installation.status === 'installed'
    const hasVenv = !!resolveVenvPython(installation)
    const hasMain = !!findMainPy(installation.installPath)
    const canLaunch = installed && hasVenv && hasMain
    return [
      { id: 'launch', label: t('actions.launch'), style: 'primary', enabled: canLaunch,
        ...(!canLaunch && { disabledMessage: !hasVenv ? t('git.noVenv') : !hasMain ? t('git.noMainPy') : t('errors.installNotReady') }),
        showProgress: true, progressTitle: t('common.startingComfyUI'), cancellable: true },
    ]
  },

  getDetailSections(installation: InstallationRecord): Record<string, unknown>[] {
    const installed = installation.status === 'installed'
    const hasVenv = !!resolveVenvPython(installation)
    const hasMain = !!findMainPy(installation.installPath)
    const canLaunch = installed && hasVenv && hasMain

    const venvPath = installation.venvPath as string | undefined
    const venvDisplay = venvPath || t('git.venvNotFound')

    return [
      {
        tab: 'status',
        title: t('git.installInfo'),
        fields: [
          { label: t('common.installMethod'), value: installation.sourceLabel as string },
          { label: t('git.repository'), value: (installation.repo as string) || '—' },
          { label: t('git.branch'), value: (installation.branch as string) || '—' },
          { label: t('git.commit'), value: (installation.commit as string) || '—' },
          { label: t('git.venv'), value: venvDisplay },
          { label: t('common.location'), value: installation.installPath || '—' },
          { label: t('common.installed'), value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
      {
        tab: 'settings',
        title: t('common.launchSettings'),
        fields: [
          { id: 'venvPath', label: t('git.venv'), value: venvPath || '', editable: true, editType: 'path' },
          { id: 'launchArgs', label: t('common.startupArgs'), value: (installation.launchArgs as string | undefined) ?? DEFAULT_LAUNCH_ARGS, editable: true },
          { id: 'launchMode', label: t('common.launchMode'), value: (installation.launchMode as string | undefined) || 'console', editable: true,
            editType: 'select', options: [
              { value: 'window', label: t('common.launchModeWindow') },
              { value: 'console', label: t('common.launchModeConsole') },
            ] },
          { id: 'browserPartition', label: t('common.browserPartition'), value: (installation.browserPartition as string | undefined) || 'shared', editable: true,
            editType: 'select', options: [
              { value: 'shared', label: t('common.partitionShared') },
              { value: 'unique', label: t('common.partitionUnique') },
            ] },
          { id: 'portConflict', label: t('common.portConflict'), value: (installation.portConflict as string | undefined) || 'ask', editable: true,
            editType: 'select', options: [
              { value: 'ask', label: t('common.portConflictAsk') },
              { value: 'auto', label: t('common.portConflictAuto') },
            ] },
        ],
      },
      {
        title: 'Actions',
        pinBottom: true,
        actions: [
          { id: 'launch', label: t('actions.launch'), style: 'primary', enabled: canLaunch,
            ...(!canLaunch && { disabledMessage: !hasVenv ? t('git.noVenv') : !hasMain ? t('git.noMainPy') : t('errors.installNotReady') }),
            showProgress: true, progressTitle: t('common.startingComfyUI'), cancellable: true },
          { id: 'open-folder', label: t('actions.openDirectory'), style: 'default', enabled: !!installation.installPath },
          { id: 'git-pull', label: t('git.gitPull'), style: 'default', enabled: installed,
            showProgress: true, progressTitle: t('git.gitPulling') },
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
    const venv = findVenv(dirPath)
    if (venv) {
      info.venvPath = venv
      info.venvName = path.basename(venv)
    }
    return info
  },

  async handleAction(
    actionId: string,
    installation: InstallationRecord,
    _actionData: Record<string, unknown> | undefined,
    { sendProgress, sendOutput }: ActionTools
  ): Promise<ActionResult> {
    if (actionId === 'git-pull') {
      const gitPath = await findGit()
      if (!gitPath) {
        return { ok: false, message: t('git.gitNotFound') }
      }

      sendProgress('pull', { percent: -1, status: t('git.gitPulling') })

      const exitCode = await new Promise<number>((resolve) => {
        const proc = spawn(gitPath, ['pull'], {
          cwd: installation.installPath,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        proc.stdout.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
        proc.stderr.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
        proc.on('error', (err: Error) => {
          sendOutput(`Error: ${err.message}\n`)
          resolve(1)
        })
        proc.on('exit', (code: number | null) => resolve(code ?? 1))
      })

      if (exitCode !== 0) {
        return { ok: false, message: t('git.gitPullFailed', { code: exitCode }) }
      }

      sendOutput(`\n✓ ${t('git.gitPullComplete')}\n`)
      sendProgress('done', { percent: 100, status: t('common.done') })
      return { ok: true, navigate: 'detail' }
    }

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
