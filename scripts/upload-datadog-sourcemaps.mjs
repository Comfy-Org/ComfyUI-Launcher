import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { resolveDatadogReleaseVersion } = require('./datadog-release-version.cjs')
const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = path.dirname(scriptPath)
const repoRoot = path.resolve(scriptDir, '..')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const extraArgs = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2)

const basePath = path.resolve(
  repoRoot,
  String(process.env.DATADOG_SOURCEMAP_BASE_PATH || 'out'),
)
const releaseVersion = resolveDatadogReleaseVersion()
const service = String(process.env.VITE_DATADOG_RUM_SERVICE || 'comfyui-launcher').trim()
const minifiedPathPrefix = String(process.env.DATADOG_SOURCEMAP_PREFIX || 'app://app').trim()
const datadogSite = String(process.env.DATADOG_SITE || process.env.VITE_DATADOG_RUM_SITE || 'us5.datadoghq.com').trim()

if (!String(process.env.DATADOG_API_KEY || '').trim()) {
  throw new Error('DATADOG_API_KEY environment variable is required to upload Datadog sourcemaps.')
}

if (!existsSync(basePath)) {
  throw new Error(`Sourcemap base path does not exist: ${basePath}`)
}

const args = [
  'exec',
  'datadog-ci',
  'sourcemaps',
  'upload',
  ...extraArgs,
  basePath,
  '--service',
  service,
  '--release-version',
  releaseVersion,
  '--minified-path-prefix',
  minifiedPathPrefix,
]

execFileSync(pnpmCommand, args, {
  cwd: repoRoot,
  env: {
    ...process.env,
    DATADOG_SITE: datadogSite,
    VITE_DATADOG_RUM_VERSION: releaseVersion,
  },
  stdio: 'inherit',
})
