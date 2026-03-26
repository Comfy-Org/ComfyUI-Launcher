import { describe, it, expect } from 'vitest'
import { parseHelpOutput, validateArgs, filterUnsupportedArgs } from './comfy-args'

const SAMPLE_HELP = `usage: main.py [-h] [--listen [IP]] [--port PORT]
               [--cuda-malloc | --disable-cuda-malloc]
               [--force-fp32 | --force-fp16]
               [--gpu-only | --highvram | --normalvram | --lowvram | --novram | --cpu]
               [--preview-method [none,auto,latent2rgb,taesd]]
               [--verbose [{DEBUG,INFO,WARNING,ERROR,CRITICAL}]]
               [--enable-manager]

options:
  -h, --help            show this help message and exit
  --listen [IP]         Specify the IP address to listen on (default:
                        127.0.0.1). If --listen is provided without an
                        argument, it defaults to 0.0.0.0
  --port PORT           Set the listen port.
  --cuda-malloc         Enable cudaMallocAsync.
  --disable-cuda-malloc
                        Disable cudaMallocAsync.
  --force-fp32          Force fp32.
  --force-fp16          Force fp16.
  --gpu-only            Store and run everything on the GPU.
  --highvram            Keep models in GPU memory.
  --normalvram          Force normal vram use.
  --lowvram             Split the unet in parts to use less vram.
  --novram              When lowvram isn't enough.
  --cpu                 To use the CPU for everything (slow).
  --preview-method [none,auto,latent2rgb,taesd]
                        Default preview method for sampler nodes.
  --verbose [{DEBUG,INFO,WARNING,ERROR,CRITICAL}]
                        Set the logging level
  --enable-manager      Enable the ComfyUI-Manager feature.
`

describe('parseHelpOutput', () => {
  it('parses flags with correct types', () => {
    const schema = parseHelpOutput(SAMPLE_HELP)
    const byName = new Map(schema.args.map((a) => [a.name, a]))

    // Boolean flags
    expect(byName.get('enable-manager')?.type).toBe('boolean')
    expect(byName.get('cuda-malloc')?.type).toBe('boolean')
    expect(byName.get('force-fp32')?.type).toBe('boolean')
    expect(byName.get('gpu-only')?.type).toBe('boolean')

    // Value flag
    expect(byName.get('port')?.type).toBe('value')
    expect(byName.get('port')?.metavar).toBe('PORT')

    // Optional-value flag
    expect(byName.get('listen')?.type).toBe('optional-value')

    // -h/--help should be excluded
    expect(byName.has('h')).toBe(false)
    expect(byName.has('help')).toBe(false)
  })

  it('extracts choices for select-style args', () => {
    const schema = parseHelpOutput(SAMPLE_HELP)
    const byName = new Map(schema.args.map((a) => [a.name, a]))

    expect(byName.get('preview-method')?.choices).toEqual(['none', 'auto', 'latent2rgb', 'taesd'])
    expect(byName.get('verbose')?.choices).toEqual(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'])
  })

  it('detects mutually exclusive groups from usage line', () => {
    const schema = parseHelpOutput(SAMPLE_HELP)
    const byName = new Map(schema.args.map((a) => [a.name, a]))

    // cuda-malloc and disable-cuda-malloc should be in the same group
    const g1 = byName.get('cuda-malloc')?.exclusiveGroup
    const g2 = byName.get('disable-cuda-malloc')?.exclusiveGroup
    expect(g1).toBeDefined()
    expect(g1).toBe(g2)

    // VRAM group
    const vramNames = ['gpu-only', 'highvram', 'normalvram', 'lowvram', 'novram', 'cpu']
    const vramGroups = vramNames.map((n) => byName.get(n)?.exclusiveGroup)
    expect(vramGroups.every((g) => g !== undefined)).toBe(true)
    expect(new Set(vramGroups).size).toBe(1)

    // force-fp32 and force-fp16 should be exclusive
    expect(byName.get('force-fp32')?.exclusiveGroup).toBe(byName.get('force-fp16')?.exclusiveGroup)
  })

  it('populates knownFlags set', () => {
    const schema = parseHelpOutput(SAMPLE_HELP)
    expect(schema.knownFlags.has('port')).toBe(true)
    expect(schema.knownFlags.has('listen')).toBe(true)
    expect(schema.knownFlags.has('enable-manager')).toBe(true)
    expect(schema.knownFlags.has('nonexistent')).toBe(false)
  })

  it('assigns categories', () => {
    const schema = parseHelpOutput(SAMPLE_HELP)
    const byName = new Map(schema.args.map((a) => [a.name, a]))

    expect(byName.get('port')?.category).toBe('Network')
    expect(byName.get('listen')?.category).toBe('Network')
    expect(byName.get('gpu-only')?.category).toBe('GPU & VRAM')
    expect(byName.get('enable-manager')?.category).toBe('Manager')
  })

  it('handles Windows \\r\\n line endings', () => {
    const windowsHelp = SAMPLE_HELP.replace(/\n/g, '\r\n')
    const schema = parseHelpOutput(windowsHelp)
    expect(schema.args.length).toBeGreaterThan(0)
    const byName = new Map(schema.args.map((a) => [a.name, a]))
    expect(byName.get('port')?.type).toBe('value')
    expect(byName.get('listen')?.type).toBe('optional-value')
    expect(byName.get('enable-manager')?.type).toBe('boolean')
  })
})

describe('validateArgs', () => {
  it('identifies unsupported flags', () => {
    const schema = parseHelpOutput(SAMPLE_HELP)
    const unsupported = validateArgs(['--port', '8188', '--fake-flag', '--enable-manager'], schema)
    expect(unsupported).toEqual(['fake-flag'])
  })

  it('returns empty for all valid args', () => {
    const schema = parseHelpOutput(SAMPLE_HELP)
    const unsupported = validateArgs(['--port', '8188', '--enable-manager'], schema)
    expect(unsupported).toEqual([])
  })
})

describe('filterUnsupportedArgs', () => {
  it('removes unsupported flags and their values', () => {
    const schema = parseHelpOutput(SAMPLE_HELP)
    const filtered = filterUnsupportedArgs(
      ['--port', '8188', '--fake-flag', 'value', '--enable-manager'],
      schema
    )
    expect(filtered).toEqual(['--port', '8188', '--enable-manager'])
  })

  it('removes unsupported boolean flags', () => {
    const schema = parseHelpOutput(SAMPLE_HELP)
    const filtered = filterUnsupportedArgs(
      ['--enable-manager', '--windows-standalone-build', '--lowvram'],
      schema
    )
    expect(filtered).toEqual(['--enable-manager', '--lowvram'])
  })

  it('preserves all args when all are valid', () => {
    const schema = parseHelpOutput(SAMPLE_HELP)
    const filtered = filterUnsupportedArgs(
      ['--port', '8188', '--listen', '--enable-manager'],
      schema
    )
    expect(filtered).toEqual(['--port', '8188', '--listen', '--enable-manager'])
  })

  it('does not consume next token when skipping --unknown=value', () => {
    const schema = parseHelpOutput(SAMPLE_HELP)
    const filtered = filterUnsupportedArgs(
      ['--unknown=foo', 'positional', '--enable-manager'],
      schema
    )
    expect(filtered).toEqual(['positional', '--enable-manager'])
  })

  it('does not double-consume value after --known=value', () => {
    const schema = parseHelpOutput(SAMPLE_HELP)
    const filtered = filterUnsupportedArgs(
      ['--port=8188', '--enable-manager'],
      schema
    )
    expect(filtered).toEqual(['--port=8188', '--enable-manager'])
  })
})

describe('parseExclusiveGroups via parseHelpOutput', () => {
  it('detects required exclusive groups with parentheses', () => {
    const help = `usage: main.py (--aaa | --bbb)

options:
  --aaa                 Option A.
  --bbb                 Option B.
`
    const schema = parseHelpOutput(help)
    const byName = new Map(schema.args.map((a) => [a.name, a]))
    expect(byName.get('aaa')?.exclusiveGroup).toBeDefined()
    expect(byName.get('aaa')?.exclusiveGroup).toBe(byName.get('bbb')?.exclusiveGroup)
  })
})
