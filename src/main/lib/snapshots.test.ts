import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  net: { fetch: vi.fn() },
}))

import { buildExportEnvelope, validateExportEnvelope, importSnapshots, diffSnapshots, listSnapshots } from './snapshots'
import type { Snapshot, SnapshotEntry, SnapshotExportEnvelope } from './snapshots'
import type { ScannedNode } from './nodes'

// --- Helpers ---

function makeNode(overrides?: Partial<ScannedNode>): ScannedNode {
  return {
    id: 'test-node',
    type: 'cnr',
    dirName: 'test-node',
    enabled: true,
    version: '1.0.0',
    ...overrides,
  }
}

function makeSnapshot(overrides?: Partial<Snapshot>): Snapshot {
  return {
    version: 1,
    createdAt: '2026-03-01T12:00:00.000Z',
    trigger: 'boot',
    label: null,
    comfyui: {
      ref: 'v0.3.10',
      commit: 'abc1234',
      releaseTag: 'v0.2.1',
      variant: 'win-nvidia-cu128',
    },
    customNodes: [],
    pipPackages: {},
    ...overrides,
  }
}

function makeEntry(overrides?: Partial<Snapshot>): SnapshotEntry {
  return { filename: 'test-snapshot.json', snapshot: makeSnapshot(overrides) }
}

function makeEnvelope(snapshots?: Snapshot[]): SnapshotExportEnvelope {
  return {
    type: 'comfyui-launcher-snapshot',
    version: 1,
    exportedAt: '2026-03-02T12:00:00.000Z',
    installationName: 'Test Install',
    snapshots: snapshots ?? [makeSnapshot()],
  }
}

// --- validateExportEnvelope ---

describe('validateExportEnvelope', () => {
  it('accepts a valid envelope', () => {
    const result = validateExportEnvelope(makeEnvelope())
    expect(result.type).toBe('comfyui-launcher-snapshot')
    expect(result.snapshots).toHaveLength(1)
  })

  it('accepts envelope with multiple snapshots', () => {
    const result = validateExportEnvelope(makeEnvelope([
      makeSnapshot({ trigger: 'boot' }),
      makeSnapshot({ trigger: 'manual', createdAt: '2026-02-28T10:00:00.000Z' }),
    ]))
    expect(result.snapshots).toHaveLength(2)
  })

  it('rejects null', () => {
    expect(() => validateExportEnvelope(null)).toThrow('not a JSON object')
  })

  it('rejects non-object', () => {
    expect(() => validateExportEnvelope('string')).toThrow('not a JSON object')
  })

  it('rejects wrong type field', () => {
    expect(() => validateExportEnvelope({ ...makeEnvelope(), type: 'wrong' })).toThrow('not a ComfyUI Launcher snapshot export')
  })

  it('rejects missing type field', () => {
    const env = makeEnvelope()
    const { type: _, ...rest } = env
    expect(() => validateExportEnvelope(rest)).toThrow('not a ComfyUI Launcher snapshot export')
  })

  it('rejects wrong version', () => {
    expect(() => validateExportEnvelope({ ...makeEnvelope(), version: 2 })).toThrow('Unsupported snapshot version')
  })

  it('rejects empty snapshots array', () => {
    expect(() => validateExportEnvelope({ ...makeEnvelope(), snapshots: [] })).toThrow('no snapshots')
  })

  it('rejects non-array snapshots', () => {
    expect(() => validateExportEnvelope({ ...makeEnvelope(), snapshots: 'not-array' })).toThrow('no snapshots')
  })

  it('rejects missing snapshots field', () => {
    const env = makeEnvelope()
    const { snapshots: _, ...rest } = env
    expect(() => validateExportEnvelope(rest)).toThrow('no snapshots')
  })

  // Snapshot-level validation

  it('rejects snapshot with wrong version', () => {
    expect(() => validateExportEnvelope(makeEnvelope([
      { ...makeSnapshot(), version: 2 as never },
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('rejects snapshot with invalid trigger', () => {
    expect(() => validateExportEnvelope(makeEnvelope([
      { ...makeSnapshot(), trigger: 'invalid' as never },
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('rejects snapshot with unparseable createdAt', () => {
    expect(() => validateExportEnvelope(makeEnvelope([
      { ...makeSnapshot(), createdAt: 'not-a-date' },
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('rejects snapshot with missing comfyui', () => {
    const { comfyui: _, ...rest } = makeSnapshot()
    expect(() => validateExportEnvelope(makeEnvelope([
      { ...rest, comfyui: null } as unknown as Snapshot,
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('rejects snapshot with non-array customNodes', () => {
    const { customNodes: _, ...rest } = makeSnapshot()
    expect(() => validateExportEnvelope(makeEnvelope([
      { ...rest, customNodes: 'not-array' } as unknown as Snapshot,
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('rejects snapshot with missing pipPackages', () => {
    const { pipPackages: _, ...rest } = makeSnapshot()
    expect(() => validateExportEnvelope(makeEnvelope([
      { ...rest, pipPackages: null } as unknown as Snapshot,
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('accepts all valid trigger types', () => {
    const triggers = ['boot', 'restart', 'manual', 'pre-update', 'post-update', 'post-restore'] as const
    for (const trigger of triggers) {
      const result = validateExportEnvelope(makeEnvelope([makeSnapshot({ trigger })]))
      expect(result.snapshots[0]!.trigger).toBe(trigger)
    }
  })

  // Custom node validation

  it('rejects custom node with path traversal in dirName', () => {
    expect(() => validateExportEnvelope(makeEnvelope([
      makeSnapshot({ customNodes: [makeNode({ dirName: '../escape' })] }),
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('rejects custom node with slash in dirName', () => {
    expect(() => validateExportEnvelope(makeEnvelope([
      makeSnapshot({ customNodes: [makeNode({ dirName: 'foo/bar' })] }),
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('rejects custom node with empty id', () => {
    expect(() => validateExportEnvelope(makeEnvelope([
      makeSnapshot({ customNodes: [makeNode({ id: '' })] }),
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('rejects custom node with unknown type', () => {
    expect(() => validateExportEnvelope(makeEnvelope([
      makeSnapshot({ customNodes: [makeNode({ type: 'unknown' as never })] }),
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('accepts valid custom node types', () => {
    for (const type of ['cnr', 'git', 'file'] as const) {
      const result = validateExportEnvelope(makeEnvelope([
        makeSnapshot({ customNodes: [makeNode({ type })] }),
      ]))
      expect(result.snapshots[0]!.customNodes[0]!.type).toBe(type)
    }
  })

  // Pip package name validation

  it('rejects pip name starting with hyphen (argument injection)', () => {
    expect(() => validateExportEnvelope(makeEnvelope([
      makeSnapshot({ pipPackages: { '-e evil': '1.0' } }),
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('rejects pip name with shell metacharacters', () => {
    expect(() => validateExportEnvelope(makeEnvelope([
      makeSnapshot({ pipPackages: { 'pkg;rm -rf /': '1.0' } }),
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('rejects pip package with non-string version', () => {
    expect(() => validateExportEnvelope(makeEnvelope([
      makeSnapshot({ pipPackages: { numpy: 42 } as unknown as Record<string, string> }),
    ]))).toThrow('Invalid snapshot at index 0')
  })

  it('accepts valid pip package names', () => {
    const result = validateExportEnvelope(makeEnvelope([
      makeSnapshot({ pipPackages: {
        numpy: '1.24.0',
        'Pillow': '10.0.0',
        'my.package': '2.0',
        'my-package': '3.0',
        'my_package': '4.0',
        'A123': '0.1',
      } }),
    ]))
    expect(Object.keys(result.snapshots[0]!.pipPackages)).toHaveLength(6)
  })

  it('reports correct index for invalid snapshot in multi-snapshot envelope', () => {
    expect(() => validateExportEnvelope(makeEnvelope([
      makeSnapshot(),
      makeSnapshot(),
      { ...makeSnapshot(), version: 99 as never },
    ]))).toThrow('Invalid snapshot at index 2')
  })
})

// --- buildExportEnvelope ---

describe('buildExportEnvelope', () => {
  it('wraps a single snapshot', () => {
    const entry = makeEntry()
    const result = buildExportEnvelope('My Install', [entry])
    expect(result.type).toBe('comfyui-launcher-snapshot')
    expect(result.version).toBe(1)
    expect(result.installationName).toBe('My Install')
    expect(result.snapshots).toHaveLength(1)
    expect(result.snapshots[0]).toBe(entry.snapshot)
    expect(new Date(result.exportedAt).getTime()).not.toBeNaN()
  })

  it('wraps multiple snapshots preserving order', () => {
    const entries = [
      makeEntry({ trigger: 'boot' }),
      makeEntry({ trigger: 'manual', createdAt: '2026-02-28T10:00:00.000Z' }),
    ]
    const result = buildExportEnvelope('Install', entries)
    expect(result.snapshots).toHaveLength(2)
    expect(result.snapshots[0]!.trigger).toBe('boot')
    expect(result.snapshots[1]!.trigger).toBe('manual')
  })

  it('produces a valid envelope (round-trip through validate)', () => {
    const result = buildExportEnvelope('Test', [makeEntry()])
    expect(() => validateExportEnvelope(result)).not.toThrow()
  })
})

// --- diffSnapshots ---

describe('diffSnapshots', () => {
  it('returns empty diff for identical snapshots', () => {
    const snap = makeSnapshot()
    const diff = diffSnapshots(snap, snap)
    expect(diff.comfyuiChanged).toBe(false)
    expect(diff.nodesAdded).toHaveLength(0)
    expect(diff.nodesRemoved).toHaveLength(0)
    expect(diff.nodesChanged).toHaveLength(0)
    expect(diff.pipsAdded).toHaveLength(0)
    expect(diff.pipsRemoved).toHaveLength(0)
    expect(diff.pipsChanged).toHaveLength(0)
  })

  it('detects comfyui ref change', () => {
    const a = makeSnapshot({ comfyui: { ref: 'v0.3.9', commit: 'aaa', releaseTag: 'v0.2.0', variant: 'win-nvidia-cu128' } })
    const b = makeSnapshot({ comfyui: { ref: 'v0.3.10', commit: 'bbb', releaseTag: 'v0.2.1', variant: 'win-nvidia-cu128' } })
    const diff = diffSnapshots(a, b)
    expect(diff.comfyuiChanged).toBe(true)
    expect(diff.comfyui!.from.ref).toBe('v0.3.9')
    expect(diff.comfyui!.to.ref).toBe('v0.3.10')
  })

  it('detects comfyui commit change with same ref', () => {
    const a = makeSnapshot({ comfyui: { ref: 'v0.3.10', commit: 'aaa', releaseTag: 'v0.2.1', variant: 'win-nvidia-cu128' } })
    const b = makeSnapshot({ comfyui: { ref: 'v0.3.10', commit: 'bbb', releaseTag: 'v0.2.1', variant: 'win-nvidia-cu128' } })
    const diff = diffSnapshots(a, b)
    expect(diff.comfyuiChanged).toBe(true)
  })

  it('does not flag comfyui change when ref and commit are same', () => {
    const comfyui = { ref: 'v0.3.10', commit: 'abc', releaseTag: 'v0.2.1', variant: 'win-nvidia-cu128' }
    const diff = diffSnapshots(makeSnapshot({ comfyui }), makeSnapshot({ comfyui }))
    expect(diff.comfyuiChanged).toBe(false)
    expect(diff.comfyui).toBeUndefined()
  })

  // Node diffs

  it('detects added nodes', () => {
    const a = makeSnapshot({ customNodes: [] })
    const b = makeSnapshot({ customNodes: [makeNode({ id: 'new-node', dirName: 'new-node' })] })
    const diff = diffSnapshots(a, b)
    expect(diff.nodesAdded).toHaveLength(1)
    expect(diff.nodesAdded[0]!.id).toBe('new-node')
    expect(diff.nodesRemoved).toHaveLength(0)
  })

  it('detects removed nodes', () => {
    const a = makeSnapshot({ customNodes: [makeNode({ id: 'old-node', dirName: 'old-node' })] })
    const b = makeSnapshot({ customNodes: [] })
    const diff = diffSnapshots(a, b)
    expect(diff.nodesRemoved).toHaveLength(1)
    expect(diff.nodesRemoved[0]!.id).toBe('old-node')
    expect(diff.nodesAdded).toHaveLength(0)
  })

  it('detects node version change', () => {
    const a = makeSnapshot({ customNodes: [makeNode({ version: '1.0.0' })] })
    const b = makeSnapshot({ customNodes: [makeNode({ version: '2.0.0' })] })
    const diff = diffSnapshots(a, b)
    expect(diff.nodesChanged).toHaveLength(1)
    expect(diff.nodesChanged[0]!.from.version).toBe('1.0.0')
    expect(diff.nodesChanged[0]!.to.version).toBe('2.0.0')
  })

  it('detects node enabled/disabled toggle', () => {
    const a = makeSnapshot({ customNodes: [makeNode({ enabled: true })] })
    const b = makeSnapshot({ customNodes: [makeNode({ enabled: false })] })
    const diff = diffSnapshots(a, b)
    expect(diff.nodesChanged).toHaveLength(1)
    expect(diff.nodesChanged[0]!.from.enabled).toBe(true)
    expect(diff.nodesChanged[0]!.to.enabled).toBe(false)
  })

  it('detects node commit change (git nodes)', () => {
    const a = makeSnapshot({ customNodes: [makeNode({ type: 'git', commit: 'aaa' })] })
    const b = makeSnapshot({ customNodes: [makeNode({ type: 'git', commit: 'bbb' })] })
    const diff = diffSnapshots(a, b)
    expect(diff.nodesChanged).toHaveLength(1)
    expect(diff.nodesChanged[0]!.from.commit).toBe('aaa')
    expect(diff.nodesChanged[0]!.to.commit).toBe('bbb')
  })

  it('does not flag unchanged nodes', () => {
    const nodes = [makeNode({ id: 'stable', dirName: 'stable', version: '1.0.0' })]
    const diff = diffSnapshots(makeSnapshot({ customNodes: nodes }), makeSnapshot({ customNodes: nodes }))
    expect(diff.nodesAdded).toHaveLength(0)
    expect(diff.nodesRemoved).toHaveLength(0)
    expect(diff.nodesChanged).toHaveLength(0)
  })

  // Pip diffs

  it('detects added pip packages', () => {
    const a = makeSnapshot({ pipPackages: {} })
    const b = makeSnapshot({ pipPackages: { numpy: '1.24.0' } })
    const diff = diffSnapshots(a, b)
    expect(diff.pipsAdded).toHaveLength(1)
    expect(diff.pipsAdded[0]).toEqual({ name: 'numpy', version: '1.24.0' })
  })

  it('detects removed pip packages', () => {
    const a = makeSnapshot({ pipPackages: { numpy: '1.24.0' } })
    const b = makeSnapshot({ pipPackages: {} })
    const diff = diffSnapshots(a, b)
    expect(diff.pipsRemoved).toHaveLength(1)
    expect(diff.pipsRemoved[0]).toEqual({ name: 'numpy', version: '1.24.0' })
  })

  it('detects pip version changes', () => {
    const a = makeSnapshot({ pipPackages: { numpy: '1.24.0' } })
    const b = makeSnapshot({ pipPackages: { numpy: '1.25.0' } })
    const diff = diffSnapshots(a, b)
    expect(diff.pipsChanged).toHaveLength(1)
    expect(diff.pipsChanged[0]).toEqual({ name: 'numpy', from: '1.24.0', to: '1.25.0' })
  })

  it('does not flag unchanged pip packages', () => {
    const pips = { numpy: '1.24.0', torch: '2.0.0' }
    const diff = diffSnapshots(makeSnapshot({ pipPackages: pips }), makeSnapshot({ pipPackages: pips }))
    expect(diff.pipsAdded).toHaveLength(0)
    expect(diff.pipsRemoved).toHaveLength(0)
    expect(diff.pipsChanged).toHaveLength(0)
  })

  // Mixed changes

  it('detects all change types simultaneously', () => {
    const a = makeSnapshot({
      comfyui: { ref: 'v1', commit: 'c1', releaseTag: 'r1', variant: 'v' },
      customNodes: [
        makeNode({ id: 'removed', dirName: 'removed' }),
        makeNode({ id: 'changed', dirName: 'changed', version: '1.0' }),
      ],
      pipPackages: { removed_pkg: '1.0', changed_pkg: '1.0' },
    })
    const b = makeSnapshot({
      comfyui: { ref: 'v2', commit: 'c2', releaseTag: 'r2', variant: 'v' },
      customNodes: [
        makeNode({ id: 'added', dirName: 'added' }),
        makeNode({ id: 'changed', dirName: 'changed', version: '2.0' }),
      ],
      pipPackages: { added_pkg: '2.0', changed_pkg: '2.0' },
    })
    const diff = diffSnapshots(a, b)
    expect(diff.comfyuiChanged).toBe(true)
    expect(diff.nodesAdded).toHaveLength(1)
    expect(diff.nodesRemoved).toHaveLength(1)
    expect(diff.nodesChanged).toHaveLength(1)
    expect(diff.pipsAdded).toHaveLength(1)
    expect(diff.pipsRemoved).toHaveLength(1)
    expect(diff.pipsChanged).toHaveLength(1)
  })
})

// --- importSnapshots ---

describe('importSnapshots', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'snapshot-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  it('imports snapshots into an empty directory', async () => {
    const envelope = makeEnvelope([
      makeSnapshot({ createdAt: '2026-03-01T12:00:00.000Z', trigger: 'boot' }),
      makeSnapshot({ createdAt: '2026-03-02T12:00:00.000Z', trigger: 'manual' }),
    ])
    const result = await importSnapshots(tmpDir, envelope)
    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(0)

    const entries = await listSnapshots(tmpDir)
    expect(entries).toHaveLength(2)
  })

  it('deduplicates by createdAt + trigger', async () => {
    const envelope = makeEnvelope([
      makeSnapshot({ createdAt: '2026-03-01T12:00:00.000Z', trigger: 'boot' }),
    ])
    await importSnapshots(tmpDir, envelope)
    const result = await importSnapshots(tmpDir, envelope)
    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(1)

    const entries = await listSnapshots(tmpDir)
    expect(entries).toHaveLength(1)
  })

  it('imports new snapshots while skipping duplicates', async () => {
    const first = makeEnvelope([
      makeSnapshot({ createdAt: '2026-03-01T12:00:00.000Z', trigger: 'boot' }),
    ])
    await importSnapshots(tmpDir, first)

    const second = makeEnvelope([
      makeSnapshot({ createdAt: '2026-03-01T12:00:00.000Z', trigger: 'boot' }),
      makeSnapshot({ createdAt: '2026-03-02T12:00:00.000Z', trigger: 'manual' }),
    ])
    const result = await importSnapshots(tmpDir, second)
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(1)
  })

  it('treats same createdAt with different trigger as distinct', async () => {
    const envelope = makeEnvelope([
      makeSnapshot({ createdAt: '2026-03-01T12:00:00.000Z', trigger: 'boot' }),
      makeSnapshot({ createdAt: '2026-03-01T12:00:00.000Z', trigger: 'manual' }),
    ])
    const result = await importSnapshots(tmpDir, envelope)
    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(0)
  })

  it('preserves snapshot content through round-trip', async () => {
    const original = makeSnapshot({
      createdAt: '2026-03-01T12:00:00.000Z',
      trigger: 'boot',
      customNodes: [makeNode({ id: 'my-node', dirName: 'my-node', version: '1.0.0' })],
      pipPackages: { numpy: '1.24.0', pillow: '10.0.0' },
    })
    await importSnapshots(tmpDir, makeEnvelope([original]))

    const entries = await listSnapshots(tmpDir)
    expect(entries).toHaveLength(1)
    const loaded = entries[0]!.snapshot
    expect(loaded.createdAt).toBe(original.createdAt)
    expect(loaded.trigger).toBe(original.trigger)
    expect(loaded.customNodes).toHaveLength(1)
    expect(loaded.customNodes[0]!.id).toBe('my-node')
    expect(loaded.pipPackages).toEqual({ numpy: '1.24.0', pillow: '10.0.0' })
  })

  it('lists imported snapshots newest-first', async () => {
    const envelope = makeEnvelope([
      makeSnapshot({ createdAt: '2026-03-01T12:00:00.000Z', trigger: 'boot' }),
      makeSnapshot({ createdAt: '2026-03-03T12:00:00.000Z', trigger: 'manual' }),
      makeSnapshot({ createdAt: '2026-03-02T12:00:00.000Z', trigger: 'restart' }),
    ])
    await importSnapshots(tmpDir, envelope)

    const entries = await listSnapshots(tmpDir)
    expect(entries).toHaveLength(3)
    expect(entries[0]!.snapshot.createdAt).toBe('2026-03-03T12:00:00.000Z')
    expect(entries[1]!.snapshot.createdAt).toBe('2026-03-02T12:00:00.000Z')
    expect(entries[2]!.snapshot.createdAt).toBe('2026-03-01T12:00:00.000Z')
  })

  it('deduplicates within a single envelope', async () => {
    const envelope = makeEnvelope([
      makeSnapshot({ createdAt: '2026-03-01T12:00:00.000Z', trigger: 'boot' }),
      makeSnapshot({ createdAt: '2026-03-01T12:00:00.000Z', trigger: 'boot' }),
    ])
    const result = await importSnapshots(tmpDir, envelope)
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(1)
  })
})
