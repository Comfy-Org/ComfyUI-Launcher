import fs from 'fs'
import path from 'path'

/**
 * electron-builder afterPack hook.
 * Ensures the 7zip-bin binary has the execute permission in the packaged output.
 * This is necessary because AppImage mounts are read-only, so runtime chmod fails.
 */
export default async function afterPack(context) {
  if (process.platform === 'win32') return

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
