import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tmpRoot = ''
let homePath = ''
let userDataPath = ''
let programDataPath = ''
let oemRoot = ''

async function loadModules() {
  const settings = await import('../settings')
  const installations = await import('../installations')
  const { syncOemSeed } = await import('./oem')
  return { settings, installations, syncOemSeed }
}

function writeManifest(data: Record<string, unknown>): void {
  fs.mkdirSync(oemRoot, { recursive: true })
  fs.writeFileSync(path.join(oemRoot, 'manifest.json'), JSON.stringify(data, null, 2), 'utf-8')
}

function createLocalInstall(installPath: string): void {
  fs.mkdirSync(path.join(installPath, 'ComfyUI', 'user', 'default', 'workflows'), { recursive: true })
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyui-desktop-2-oem-'))
  homePath = path.join(tmpRoot, 'home')
  userDataPath = path.join(tmpRoot, 'user-data')
  programDataPath = path.join(tmpRoot, 'program-data')
  oemRoot = path.join(programDataPath, 'ComfyUI Desktop 2.0', 'OEM')

  fs.mkdirSync(homePath, { recursive: true })
  fs.mkdirSync(userDataPath, { recursive: true })
  fs.mkdirSync(programDataPath, { recursive: true })

  vi.resetModules()
  vi.restoreAllMocks()
  vi.doMock('electron', () => ({
    app: {
      getPath: (name: string) => {
        if (name === 'home') return homePath
        return userDataPath
      },
    },
  }))
  vi.stubGlobal('process', {
    ...process,
    platform: 'win32',
    env: { ...process.env, ProgramData: programDataPath },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('syncOemSeed', () => {
  it('adds OEM model dirs and copies workflows into tracked local installs', async () => {
    fs.mkdirSync(path.join(oemRoot, 'models'), { recursive: true })
    fs.mkdirSync(path.join(oemRoot, 'workflows'), { recursive: true })
    fs.writeFileSync(path.join(oemRoot, 'workflows', 'seed.json'), '{"name":"seed"}', 'utf-8')
    writeManifest({ version: 1, modelDirs: ['models'], workflowDirs: ['workflows'] })

    const firstInstallPath = path.join(tmpRoot, 'standalone-a')
    const secondInstallPath = path.join(tmpRoot, 'standalone-b')
    createLocalInstall(firstInstallPath)
    createLocalInstall(secondInstallPath)

    const { settings, installations, syncOemSeed } = await loadModules()
    await installations.add({ name: 'Standalone A', installPath: firstInstallPath, sourceId: 'standalone', status: 'installed' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await installations.add({ name: 'Standalone B', installPath: secondInstallPath, sourceId: 'standalone', status: 'installed' })

    await syncOemSeed()

    expect(settings.get('modelsDirs')).toEqual([
      path.join(homePath, 'ComfyUI-Shared', 'models'),
      path.join(oemRoot, 'models'),
    ])
    expect(fs.readFileSync(path.join(firstInstallPath, 'ComfyUI', 'user', 'default', 'workflows', 'seed.json'), 'utf-8'))
      .toBe('{"name":"seed"}')
    expect(fs.existsSync(path.join(secondInstallPath, 'ComfyUI', 'user', 'default', 'workflows', 'seed.json'))).toBe(false)

    expect(settings.get('oemManagedModelDirs')).toEqual([path.join(oemRoot, 'models')])
    expect(settings.get('oemWorkflowImportVersion')).toBe(1)
  })

  it('defers workflow import until a local install exists', async () => {
    fs.mkdirSync(path.join(oemRoot, 'workflows'), { recursive: true })
    fs.writeFileSync(path.join(oemRoot, 'workflows', 'seed.json'), '{"name":"seed"}', 'utf-8')
    writeManifest({ version: 1, workflowDirs: ['workflows'] })

    const { settings, installations, syncOemSeed } = await loadModules()

    await syncOemSeed()
    expect(settings.get('oemWorkflowImportVersion')).toBeUndefined()

    const installPath = path.join(tmpRoot, 'portable')
    createLocalInstall(installPath)
    await installations.add({ name: 'Portable', installPath, sourceId: 'portable', status: 'installed' })

    await syncOemSeed()

    expect(fs.existsSync(path.join(installPath, 'ComfyUI', 'user', 'default', 'workflows', 'seed.json'))).toBe(true)
    expect(settings.get('oemWorkflowImportVersion')).toBe(1)
  })

  it('removes previously managed OEM model dirs when the manifest disappears', async () => {
    fs.mkdirSync(path.join(oemRoot, 'models'), { recursive: true })
    writeManifest({ version: 1, modelDirs: ['models'] })

    const { settings, syncOemSeed } = await loadModules()

    await syncOemSeed()
    fs.rmSync(path.join(oemRoot, 'manifest.json'))
    await syncOemSeed()

    expect(settings.get('modelsDirs')).toEqual([path.join(homePath, 'ComfyUI-Shared', 'models')])
  })

  it('rejects manifest paths outside the OEM root', async () => {
    const outsideModels = path.join(programDataPath, 'outside-models')
    const outsideWorkflows = path.join(programDataPath, 'outside-workflows')
    fs.mkdirSync(outsideModels, { recursive: true })
    fs.mkdirSync(outsideWorkflows, { recursive: true })
    fs.writeFileSync(path.join(outsideWorkflows, 'seed.json'), '{"name":"outside"}', 'utf-8')
    writeManifest({ version: 1, modelDirs: ['../outside-models'], workflowDirs: ['../outside-workflows'] })

    const installPath = path.join(tmpRoot, 'standalone')
    createLocalInstall(installPath)

    const { settings, installations, syncOemSeed } = await loadModules()
    await installations.add({ name: 'Standalone', installPath, sourceId: 'standalone', status: 'installed' })

    await syncOemSeed()

    expect(settings.get('modelsDirs')).toEqual([path.join(homePath, 'ComfyUI-Shared', 'models')])
    expect(fs.existsSync(path.join(installPath, 'ComfyUI', 'user', 'default', 'workflows', 'seed.json'))).toBe(false)
  })
})
