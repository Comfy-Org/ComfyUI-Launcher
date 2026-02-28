module.exports = async ({ pkgJsonPath, pkgJson }) => {
  const { writeFile } = await import('node:fs/promises')
  const removedScripts = []

  if (pkgJson?.scripts?.postinstall) {
    delete pkgJson.scripts.postinstall
    removedScripts.push('postinstall')
  }

  if (pkgJson?.scripts?.prepare) {
    delete pkgJson.scripts.prepare
    removedScripts.push('prepare')
  }

  if (removedScripts.length === 0) {
    console.log('[todesktop:beforeInstall] No lifecycle scripts to remove')
    return
  }

  await writeFile(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`)
  console.log(
    `[todesktop:beforeInstall] Removed lifecycle scripts: ${removedScripts.join(', ')}`
  )
}
