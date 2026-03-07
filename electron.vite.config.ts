import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

function readPackageVersion(): string {
  try {
    const raw = readFileSync(resolve(__dirname, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
      return parsed.version.trim()
    }
  } catch {}
  return '0.0.0'
}

function readGitSha(): string {
  try {
    return execSync('git rev-parse --short=12 HEAD', {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

const packageVersion = (process.env.npm_package_version || readPackageVersion()).trim() || '0.0.0'
const commitSha = (process.env.GITHUB_SHA || process.env.VITE_GIT_SHA || readGitSha()).trim()

if (!process.env.VITE_DATADOG_RUM_VERSION) {
  process.env.VITE_DATADOG_RUM_VERSION = commitSha
    ? `${packageVersion}+${commitSha.slice(0, 12)}`
    : packageVersion
}

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          comfyPreload: resolve(__dirname, 'src/preload/comfyPreload.ts'),
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue(), tailwindcss()]
  }
})
