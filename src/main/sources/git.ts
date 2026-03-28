import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { fetchJSON } from '../lib/fetch'
import { runLoggedProcess, formatProcessError } from '../lib/logged-process'
import { untrackAction, launchAction, openFolderAction, migrateToStandaloneAction } from '../lib/actions'
import { parseArgs, extractPort } from '../lib/util'
import { t } from '../lib/i18n'
import { buildLaunchSettingsFields } from './common/launchSettingsFields'
import type { InstallationRecord } from '../installations'
import type { SourcePlugin, FieldOption, ActionResult, ActionTools, LaunchCommand, StatusTag } from '../types/sources'

const DEFAULT_REPO = 'https://github.com/Comfy-Org/ComfyUI/'
const DEFAULT_LAUNCH_ARGS = ''
const DEFAULT_GIT_SETTINGS = { launchArgs: DEFAULT_LAUNCH_ARGS, launchMode: 'window', browserPartition: 'shared' } as const

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
    const scripts = path.join(venvDir, 'Scripts', 'python.exe')
    if (fs.existsSync(scripts)) return scripts
    return path.join(venvDir, 'python.exe')
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
    return { ...DEFAULT_GIT_SETTINGS }
  },

  buildInstallation(selections: Record<string, FieldOption | undefined>): Record<string, unknown> {
    return {
      version: selections.commit?.value?.slice(0, 8) ?? 'unknown',
      repo: selections.repo?.value ?? DEFAULT_REPO,
      branch: selections.branch?.value ?? '',
      commit: selections.commit?.value ?? '',
      commitMessage: selections.commit?.label ?? '',
      ...DEFAULT_GIT_SETTINGS,
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
    const cwd = path.dirname(mainPy)
    return {
      cmd: pythonPath,
      args: ['-s', 'main.py', ...parsed],
      cwd,
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
    const disabledMsg = !canLaunch ? (!hasVenv ? t('git.noVenv') : !hasMain ? t('git.noMainPy') : t('errors.installNotReady')) : undefined
    return [
      launchAction(canLaunch, disabledMsg),
    ]
  },

  getStatusTag(installation: InstallationRecord): StatusTag | undefined {
    if (installation.status === 'installed') {
      return { label: t('migrate.migrateToStandalonePill'), style: 'migrate' }
    }
    return undefined
  },

  getDetailSections(installation: InstallationRecord): Record<string, unknown>[] {
    const installed = installation.status === 'installed'
    const hasVenv = !!resolveVenvPython(installation)
    const hasMain = !!findMainPy(installation.installPath)
    const canLaunch = installed && hasVenv && hasMain

    const venvPath = installation.venvPath as string | undefined

    return [
      {
        tab: 'status',
        title: t('git.installInfo'),
        fields: [
          { label: t('common.installMethod'), value: installation.sourceLabel as string },
          { label: t('git.repository'), value: (installation.repo as string) || '—' },
          { label: t('git.branch'), value: (installation.branch as string) || '—' },
          { label: t('git.commit'), value: (installation.commit as string) || '—' },
          { id: 'venvPath', label: t('git.venv'), value: venvPath || '', editable: true, editType: 'path' },
          { label: t('common.location'), value: installation.installPath || '—' },
          { label: t('common.installed'), value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
      {
        tab: 'settings',
        title: t('common.launchSettings'),
        fields: buildLaunchSettingsFields(installation, {
          defaultLaunchArgs: DEFAULT_LAUNCH_ARGS,
          includeUseSharedPaths: false,
          extraFields: [
            { id: 'venvPath', label: t('git.venv'), value: venvPath || '', editable: true, editType: 'path' },
          ],
        }),
      },
      {
        title: 'Actions',
        pinBottom: true,
        actions: [
          launchAction(canLaunch, !canLaunch ? (!hasVenv ? t('git.noVenv') : !hasMain ? t('git.noMainPy') : t('errors.installNotReady')) : undefined),
          openFolderAction(installation.installPath),
          { id: 'git-pull', label: t('git.gitPull'), style: 'default', enabled: installed,
            showProgress: true, progressTitle: t('git.gitPulling') },
          migrateToStandaloneAction(installed),
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
      if (branchMatch && branchMatch[1]) {
        info.branch = branchMatch[1]
        // Resolve the ref to a commit SHA
        try {
          const refPath = path.join(dirPath, '.git', 'refs', 'heads', branchMatch[1])
          const sha = fs.readFileSync(refPath, 'utf-8').trim()
          if (sha) {
            info.commit = sha
            info.version = sha.slice(0, 8)
          }
        } catch {
          // ref may be packed — try packed-refs
          try {
            const packed = fs.readFileSync(path.join(dirPath, '.git', 'packed-refs'), 'utf-8')
            const refLine = packed.split('\n').find((l) => l.endsWith(` refs/heads/${branchMatch[1]}`))
            if (refLine) {
              const sha = refLine.split(' ')[0]!
              info.commit = sha
              info.version = sha.slice(0, 8)
            }
          } catch {}
        }
      } else if (/^[0-9a-f]{40}$/i.test(head)) {
        // Detached HEAD
        info.commit = head
        info.version = head.slice(0, 8)
      }
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
    info.launchMode = DEFAULT_GIT_SETTINGS.launchMode
    info.browserPartition = DEFAULT_GIT_SETTINGS.browserPartition
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

      const result = await runLoggedProcess(gitPath, ['pull'], {
        cwd: installation.installPath,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        sendOutput,
      })

      if (result.exitCode !== 0) {
        return { ok: false, message: formatProcessError(t('git.gitPullFailed', { code: result.exitCode }), result) }
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
