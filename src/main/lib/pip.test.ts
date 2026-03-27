import { describe, it, expect } from 'vitest'
import { getPipIndexArgs, PYPI_INDEX_URL, PYPI_MIRROR_URLS } from './pip'

/** Extract --index-url value from args. */
function getIndexUrl(args: string[]): string | undefined {
  const i = args.indexOf('--index-url')
  return i >= 0 ? args[i + 1] : undefined
}

/** Extract all --extra-index-url values from args. */
function getExtras(args: string[]): string[] {
  const extras: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--extra-index-url') extras.push(args[i + 1]!)
  }
  return extras
}

describe('getPipIndexArgs', () => {
  it('uses pypi.org as --index-url when no mirrors configured', () => {
    const args = getPipIndexArgs()
    expect(getIndexUrl(args)).toBe(PYPI_INDEX_URL)
    expect(getExtras(args)).toEqual([])
  })

  it('does not include Chinese mirrors when useChineseMirrors is false or unset', () => {
    const args = getPipIndexArgs()
    for (const url of PYPI_MIRROR_URLS) {
      expect(args).not.toContain(url)
    }
    expect(getExtras(args)).toHaveLength(0)
  })

  it('uses first Chinese mirror as --index-url when useChineseMirrors is true', () => {
    const args = getPipIndexArgs(undefined, true)
    expect(getIndexUrl(args)).toBe(PYPI_MIRROR_URLS[0])
  })

  it('demotes pypi.org to --extra-index-url when useChineseMirrors is true', () => {
    const args = getPipIndexArgs(undefined, true)
    const extras = getExtras(args)
    expect(extras).toContain(PYPI_INDEX_URL)
  })

  it('includes remaining Chinese mirrors as --extra-index-url when useChineseMirrors is true', () => {
    const args = getPipIndexArgs(undefined, true)
    const extras = getExtras(args)
    // pypi.org + remaining mirrors (all except the first which is --index-url)
    const expectedExtras = [PYPI_INDEX_URL, ...PYPI_MIRROR_URLS.slice(1)]
    expect(extras).toEqual(expectedExtras)
  })

  it('does not include --index-strategy', () => {
    const noMirror = getPipIndexArgs()
    expect(noMirror).not.toContain('--index-strategy')

    const withMirror = getPipIndexArgs('https://custom.mirror.example/simple/')
    expect(withMirror).not.toContain('--index-strategy')
  })

  it('uses user mirror as --index-url when provided', () => {
    const mirror = 'https://custom.mirror.example/simple/'
    const args = getPipIndexArgs(mirror)
    expect(getIndexUrl(args)).toBe(mirror)
  })

  it('demotes pypi.org to --extra-index-url when user mirror is provided', () => {
    const mirror = 'https://custom.mirror.example/simple/'
    const args = getPipIndexArgs(mirror)
    const extras = getExtras(args)
    expect(extras).toContain(PYPI_INDEX_URL)
  })

  it('adds user mirror without Chinese mirrors when useChineseMirrors is false', () => {
    const mirror = 'https://custom.mirror.example/simple/'
    const args = getPipIndexArgs(mirror, false)
    expect(getIndexUrl(args)).toBe(mirror)
    const extras = getExtras(args)
    expect(extras).toEqual([PYPI_INDEX_URL])
  })

  it('uses user mirror as --index-url with Chinese mirrors and pypi.org as extras', () => {
    const mirror = 'https://custom.mirror.example/simple/'
    const args = getPipIndexArgs(mirror, true)
    expect(getIndexUrl(args)).toBe(mirror)
    const extras = getExtras(args)
    expect(extras).toContain(PYPI_INDEX_URL)
    for (const url of PYPI_MIRROR_URLS) {
      expect(extras).toContain(url)
    }
    expect(extras).toHaveLength(1 + PYPI_MIRROR_URLS.length)
  })

  it('deduplicates when user mirror matches pypi.org', () => {
    const args = getPipIndexArgs('https://pypi.org/simple/', true)
    // pypi.org is --index-url (user mirror = pypi.org)
    expect(getIndexUrl(args)).toBe('https://pypi.org/simple/')
    const extras = getExtras(args)
    // pypi.org should not appear again as extra
    expect(extras).not.toContain('https://pypi.org/simple/')
    expect(extras).toHaveLength(PYPI_MIRROR_URLS.length)
  })

  it('deduplicates when user mirror matches pypi.org without trailing slash', () => {
    const args = getPipIndexArgs('https://pypi.org/simple', true)
    const extras = getExtras(args)
    expect(extras).toHaveLength(PYPI_MIRROR_URLS.length)
  })

  it('deduplicates when user mirror is one of the Chinese mirrors', () => {
    const mirror = PYPI_MIRROR_URLS[0]!
    const args = getPipIndexArgs(mirror, true)
    // User mirror (= first Chinese mirror) is --index-url
    expect(getIndexUrl(args)).toBe(mirror)
    const extras = getExtras(args)
    // Should not be duplicated in extras
    expect(extras.filter((u) => u === mirror)).toHaveLength(0)
    // pypi.org + remaining Chinese mirrors
    expect(extras).toHaveLength(1 + PYPI_MIRROR_URLS.length - 1)
  })

  it('treats empty string as no mirror', () => {
    const args = getPipIndexArgs('')
    expect(args).toEqual(getPipIndexArgs())
  })

  it('treats whitespace-only string as no mirror', () => {
    const args = getPipIndexArgs('   ')
    expect(args).toEqual(getPipIndexArgs())
  })

  it('trims whitespace from mirror URL', () => {
    const mirror = '  https://custom.mirror.example/simple/  '
    const args = getPipIndexArgs(mirror)
    expect(getIndexUrl(args)).toBe('https://custom.mirror.example/simple/')
  })

  it('passes undefined the same as no argument', () => {
    expect(getPipIndexArgs(undefined)).toEqual(getPipIndexArgs())
  })
})
