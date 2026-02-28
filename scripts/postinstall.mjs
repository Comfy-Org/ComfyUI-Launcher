#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function runInstallAppDeps() {
  const installAppDepsPath = require.resolve('electron-builder/install-app-deps.js')
  const result = spawnSync(process.execPath, [installAppDepsPath], { stdio: 'inherit' })
  if (typeof result.status === 'number') {
    return result.status
  }

  if (result.error) {
    console.error(`[postinstall] install-app-deps failed to start: ${result.error.message}`)
    return 1
  }

  if (result.signal) {
    console.error(`[postinstall] install-app-deps was terminated by signal: ${result.signal}`)
    return 1
  }

  console.error('[postinstall] install-app-deps failed with unknown status')
  return 1
}

const isToDesktopCI = process.env.TODESKTOP_CI === 'true'
const isToDesktopInitialInstall = process.env.TODESKTOP_INITIAL_INSTALL_PHASE === 'true'

if (isToDesktopCI) {
  if (isToDesktopInitialInstall) {
    console.log('[postinstall] ToDesktop initial install phase; skipping install-app-deps')
  } else {
    console.log('[postinstall] ToDesktop non-initial install phase; skipping install-app-deps')
  }
  process.exit(0)
}

try {
  process.exit(runInstallAppDeps())
} catch {
  // Some CI/build environments install prod deps only, which excludes electron-builder.
  console.log('[postinstall] electron-builder not installed; skipping install-app-deps')
  process.exit(0)
}
