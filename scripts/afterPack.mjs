import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const vcRedistUrl = 'https://aka.ms/vc14/vc_redist.x64.exe'

async function ensureVcRedist(context) {
  const buildResourcesDir = context.packager.buildResourcesDir
  const vcRedistPath = path.join(buildResourcesDir, 'vc_redist.x64.exe')
  const vcRedistTempPath = `${vcRedistPath}.tmp`

  if (fs.existsSync(vcRedistPath)) return

  console.log(`afterPack: downloading ${vcRedistUrl}`)
  const response = await fetch(vcRedistUrl)

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download VC++ redistributable (${response.status} ${response.statusText})`)
  }

  fs.mkdirSync(buildResourcesDir, { recursive: true })
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(vcRedistTempPath))
  fs.renameSync(vcRedistTempPath, vcRedistPath)
  console.log(`afterPack: saved ${vcRedistPath}`)
}

/**
 * electron-builder afterPack hook.
 * Ensures the 7zip-bin binary has the execute permission in the packaged output.
 * This is necessary because AppImage mounts are read-only, so runtime chmod fails.
 */
export default async function afterPack(context) {
  if (process.platform === 'win32') {
    await ensureVcRedist(context)
    return
  }

  const unpackedDir = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '7zip-bin',
  )

  if (!fs.existsSync(unpackedDir)) return

  // Find all 7za binaries under the unpacked 7zip-bin directory
  for (const entry of fs.readdirSync(unpackedDir, { recursive: true })) {
    if (path.basename(String(entry)) === '7za') {
      const binPath = path.join(unpackedDir, String(entry))
      fs.chmodSync(binPath, 0o755)
      console.log(`afterPack: set +x on ${binPath}`)
    }
  }
}
