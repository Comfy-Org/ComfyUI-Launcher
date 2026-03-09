/* eslint-disable @typescript-eslint/no-require-imports */
const { execSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')

function readPackageVersion() {
  try {
    const raw = readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
      return parsed.version.trim()
    }
  } catch {}

  return '0.0.0'
}

function readGitSha() {
  try {
    return execSync('git rev-parse --short=12 HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function resolveDatadogReleaseVersion(env = process.env) {
  const explicitVersion = String(env.VITE_DATADOG_RUM_VERSION || '').trim()
  if (explicitVersion) return explicitVersion

  const packageVersion = String(env.npm_package_version || readPackageVersion()).trim() || '0.0.0'
  const commitSha = String(env.GITHUB_SHA || env.VITE_GIT_SHA || readGitSha()).trim()

  return commitSha ? `${packageVersion}+${commitSha.slice(0, 12)}` : packageVersion
}

module.exports = {
  resolveDatadogReleaseVersion,
}

if (require.main === module) {
  process.stdout.write(resolveDatadogReleaseVersion())
}
