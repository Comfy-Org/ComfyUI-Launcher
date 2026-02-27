#!/usr/bin/env node

if (process.env.TODESKTOP_CI === 'true') {
  console.log('[prepare] ToDesktop CI detected; skipping git hooks setup')
  process.exit(0)
}

try {
  const husky = await import('husky')
  const result = typeof husky.default === 'function' ? husky.default() : ''
  if (result) console.log(result)
} catch {
  console.log('[prepare] husky not installed; skipping git hooks setup')
}
