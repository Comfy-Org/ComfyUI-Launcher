import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyui-launcher-installations-'))
const homePath = path.join(tmpRoot, 'home')
const userDataPath = path.join(tmpRoot, 'user-data')

let installations: {
  add: (installation: Record<string, unknown>, scope?: 'user' | 'machine') => Promise<{ id: string; name: string; scope?: 'user' | 'machine' }>
  get: (id: string) => Promise<{ id: string; name: string; scope?: 'user' | 'machine' } | null>
  list: (scope?: 'user' | 'machine' | 'all') => Promise<Array<{ id: string; name: string; scope?: 'user' | 'machine' }>>
  remove: (id: string) => Promise<void>
  update: (id: string, data: Record<string, unknown>) => Promise<{ id: string; name: string; scope?: 'user' | 'machine' } | null>
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

  installations = await import('./installations')
})

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('installation scopes', () => {
  it('stores user and machine installations separately while listing both together', async () => {
    const userEntry = await installations.add({
      name: 'User Install',
      installPath: '/tmp/user-install',
      sourceId: 'standalone',
    }, 'user')

    const machineEntry = await installations.add({
      name: 'Machine Install',
      installPath: '/tmp/machine-install',
      sourceId: 'standalone',
    }, 'machine')

    expect((await installations.list('user')).map((entry) => entry.id)).toEqual([userEntry.id])
    expect((await installations.list('machine')).map((entry) => entry.id)).toEqual([machineEntry.id])
    expect((await installations.list()).map((entry) => entry.id)).toEqual([userEntry.id, machineEntry.id])
    expect((await installations.get(machineEntry.id))?.scope).toBe('machine')
  })

  it('updates and removes machine-scoped installations without touching user installs', async () => {
    const userEntry = await installations.add({
      name: 'User Install',
      installPath: '/tmp/user-install',
      sourceId: 'standalone',
    }, 'user')

    const machineEntry = await installations.add({
      name: 'Machine Install',
      installPath: '/tmp/machine-install',
      sourceId: 'standalone',
    }, 'machine')

    await installations.update(machineEntry.id, { name: 'Machine Install Updated' })
    expect((await installations.get(machineEntry.id))?.name).toBe('Machine Install Updated')
    expect((await installations.get(userEntry.id))?.name).toBe('User Install')

    await installations.remove(machineEntry.id)
    expect(await installations.get(machineEntry.id)).toBeNull()
    expect((await installations.list('user')).map((entry) => entry.id)).toEqual([userEntry.id])
  })
})
