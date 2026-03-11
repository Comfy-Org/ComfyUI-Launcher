import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyui-launcher-machine-'))
const homePath = path.join(tmpRoot, 'home')
const userDataPath = path.join(tmpRoot, 'user-data')

let machineInstall: {
  normalizeInstallationScope: (value: unknown) => 'user' | 'machine'
  isMachineScope: (value: unknown) => boolean
  resolveMachineUserDir: (installationId: string) => string
  ensureMachineUserDir: (seedDir: string | null, userDir: string) => void
}

beforeEach(async () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  fs.mkdirSync(homePath, { recursive: true })
  fs.mkdirSync(userDataPath, { recursive: true })

  vi.resetModules()
  vi.doMock('electron', () => ({
    app: {
      getPath: (name: string) => {
        if (name === 'home') return homePath
        return userDataPath
      },
    },
  }))

  machineInstall = await import('./machine-install')
})

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('machine install helpers', () => {
  it('normalizes unknown scopes to user', () => {
    expect(machineInstall.normalizeInstallationScope(undefined)).toBe('user')
    expect(machineInstall.normalizeInstallationScope('machine')).toBe('machine')
    expect(machineInstall.isMachineScope('machine')).toBe(true)
    expect(machineInstall.isMachineScope('user')).toBe(false)
  })

  it('seeds a per-user directory from a shared install once', () => {
    const seedDir = path.join(tmpRoot, 'seed-user')
    const workflowPath = path.join(seedDir, 'default', 'workflows', 'starter.json')
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true })
    fs.writeFileSync(workflowPath, '{"workflow":true}', 'utf-8')

    const userDir = machineInstall.resolveMachineUserDir('machine-inst-1')
    machineInstall.ensureMachineUserDir(seedDir, userDir)

    expect(fs.readFileSync(path.join(userDir, 'default', 'workflows', 'starter.json'), 'utf-8')).toBe('{"workflow":true}')

    const customFile = path.join(userDir, 'notes.txt')
    fs.writeFileSync(customFile, 'keep-me', 'utf-8')
    machineInstall.ensureMachineUserDir(seedDir, userDir)

    expect(fs.readFileSync(customFile, 'utf-8')).toBe('keep-me')
  })
})
