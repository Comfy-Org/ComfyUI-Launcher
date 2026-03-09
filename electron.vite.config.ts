import { createRequire } from 'module'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const require = createRequire(import.meta.url)
const { resolveDatadogReleaseVersion } = require('./scripts/datadog-release-version.cjs') as {
  resolveDatadogReleaseVersion: (env?: NodeJS.ProcessEnv) => string
}

if (!process.env.VITE_DATADOG_RUM_VERSION) {
  process.env.VITE_DATADOG_RUM_VERSION = resolveDatadogReleaseVersion(process.env)
}

export default defineConfig({
  main: {
    build: {
      sourcemap: 'hidden',
    },
  },
  preload: {
    build: {
      sourcemap: 'hidden',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          comfyPreload: resolve(__dirname, 'src/preload/comfyPreload.ts'),
        },
      },
    },
  },
  renderer: {
    build: {
      sourcemap: 'hidden',
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue(), tailwindcss()]
  }
})
