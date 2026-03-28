import { describe, expect, it } from 'vitest'
import { parseNvidiaDriverVersion, isAmdIgpu, pickGPU } from './gpu'
import type { GpuDevice } from './gpu'

describe('parseNvidiaDriverVersion', () => {
  it('parses driver version from nvidia-smi table output', () => {
    const output = `
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 591.59                 Driver Version: 591.59         CUDA Version: 13.1     |
|  GPU  Name                     TCC/WDDM  | Bus-Id          Disp.A | Volatile Uncorr. ECC |
+-----------------------------------------------------------------------------------------+`
    expect(parseNvidiaDriverVersion(output)).toBe('591.59')
  })

  it('parses driver version case-insensitively', () => {
    expect(parseNvidiaDriverVersion('driver version: 535.129.03')).toBe('535.129.03')
    expect(parseNvidiaDriverVersion('DRIVER VERSION: 580.00')).toBe('580.00')
  })

  it('returns undefined for output without driver version', () => {
    expect(parseNvidiaDriverVersion('No devices found')).toBeUndefined()
    expect(parseNvidiaDriverVersion('')).toBeUndefined()
  })

  it('handles Linux-style three-part versions', () => {
    expect(parseNvidiaDriverVersion('Driver Version: 535.183.01')).toBe('535.183.01')
  })
})

describe('isAmdIgpu', () => {
  it('identifies AMD Radeon(TM) Graphics as iGPU', () => {
    expect(isAmdIgpu({ vendor: '1002', name: 'AMD Radeon(TM) Graphics' })).toBe(true)
  })

  it('identifies AMD Radeon Vega 8 Graphics as iGPU', () => {
    expect(isAmdIgpu({ vendor: '1002', name: 'AMD Radeon Vega 8 Graphics' })).toBe(true)
  })

  it('identifies AMD Radeon Graphics as iGPU', () => {
    expect(isAmdIgpu({ vendor: '1002', name: 'AMD Radeon Graphics' })).toBe(true)
  })

  it('identifies AMD Radeon RX 7900 XTX as discrete', () => {
    expect(isAmdIgpu({ vendor: '1002', name: 'AMD Radeon RX 7900 XTX' })).toBe(false)
  })

  it('identifies Radeon RX 580 as discrete', () => {
    expect(isAmdIgpu({ vendor: '1002', name: 'Radeon RX 580' })).toBe(false)
  })

  it('identifies AMD Radeon RX 6800 XT as discrete', () => {
    expect(isAmdIgpu({ vendor: '1002', name: 'AMD Radeon RX 6800 XT' })).toBe(false)
  })

  it('identifies AMD Radeon Pro W6800 as discrete', () => {
    expect(isAmdIgpu({ vendor: '1002', name: 'AMD Radeon Pro W6800' })).toBe(false)
  })

  it('identifies AMD Radeon VII as discrete', () => {
    expect(isAmdIgpu({ vendor: '1002', name: 'AMD Radeon VII' })).toBe(false)
  })

  it('identifies AMD Instinct MI250X as discrete', () => {
    expect(isAmdIgpu({ vendor: '1002', name: 'AMD Instinct MI250X' })).toBe(false)
  })

  it('trusts explicit discrete=true flag', () => {
    expect(isAmdIgpu({ vendor: '1002', name: 'AMD Radeon(TM) Graphics', discrete: true })).toBe(false)
  })

  it('trusts explicit discrete=false flag', () => {
    expect(isAmdIgpu({ vendor: '1002', name: 'AMD Radeon RX 7900 XTX', discrete: false })).toBe(true)
  })

  it('flags low VRAM (<512MB) as iGPU', () => {
    expect(isAmdIgpu({ vendor: '1002', adapterRam: 0 })).toBe(true)
    expect(isAmdIgpu({ vendor: '1002', adapterRam: 256 * 1024 * 1024 })).toBe(true)
  })

  it('does not flag high VRAM as iGPU by VRAM alone', () => {
    expect(isAmdIgpu({ vendor: '1002', adapterRam: 8 * 1024 * 1024 * 1024 })).toBe(false)
  })

  it('does not flag exactly 512MB as iGPU (boundary)', () => {
    expect(isAmdIgpu({ vendor: '1002', adapterRam: 512 * 1024 * 1024 })).toBe(false)
  })

  it('returns false for device with no name and no VRAM info', () => {
    expect(isAmdIgpu({ vendor: '1002' })).toBe(false)
  })
})

describe('pickGPU', () => {
  const nvidia: GpuDevice = { vendor: '10DE', name: 'NVIDIA GeForce RTX 4090' }
  const amdDiscrete: GpuDevice = { vendor: '1002', name: 'AMD Radeon RX 7900 XTX' }
  const amdIgpu: GpuDevice = { vendor: '1002', name: 'AMD Radeon(TM) Graphics' }
  const intel: GpuDevice = { vendor: '8086', name: 'Intel(R) Arc(TM) A770' }

  it('returns null for empty list', () => {
    expect(pickGPU([])).toBeNull()
  })

  it('picks NVIDIA when only NVIDIA present', () => {
    expect(pickGPU([nvidia])).toBe('nvidia')
  })

  it('picks AMD when only discrete AMD present', () => {
    expect(pickGPU([amdDiscrete])).toBe('amd')
  })

  it('picks AMD when only AMD iGPU present (fallback)', () => {
    expect(pickGPU([amdIgpu])).toBe('amd')
  })

  it('picks Intel when only Intel present', () => {
    expect(pickGPU([intel])).toBe('intel')
  })

  it('picks NVIDIA over everything', () => {
    expect(pickGPU([nvidia, amdDiscrete, intel])).toBe('nvidia')
    expect(pickGPU([nvidia, amdIgpu, intel])).toBe('nvidia')
  })

  it('picks discrete AMD over Intel', () => {
    expect(pickGPU([amdDiscrete, intel])).toBe('amd')
  })

  // THE KEY BUG FIX: AMD iGPU + Intel Arc should pick Intel
  it('picks Intel over AMD iGPU (issue #342)', () => {
    expect(pickGPU([amdIgpu, intel])).toBe('intel')
  })

  it('picks Intel over AMD iGPU regardless of order', () => {
    expect(pickGPU([intel, amdIgpu])).toBe('intel')
  })

  it('picks Intel over AMD iGPU detected by low VRAM', () => {
    const amdLowVram: GpuDevice = { vendor: '1002', adapterRam: 0 }
    expect(pickGPU([amdLowVram, intel])).toBe('intel')
  })

  it('picks Intel over AMD iGPU detected by explicit discrete=false', () => {
    const amdExplicitIgpu: GpuDevice = { vendor: '1002', discrete: false }
    expect(pickGPU([amdExplicitIgpu, intel])).toBe('intel')
  })

  it('picks discrete AMD when both discrete AMD and Intel present', () => {
    expect(pickGPU([amdDiscrete, intel])).toBe('amd')
  })

  it('handles mixed: NVIDIA + AMD iGPU + Intel', () => {
    expect(pickGPU([nvidia, amdIgpu, intel])).toBe('nvidia')
  })

  it('handles AMD iGPU + discrete AMD + Intel', () => {
    expect(pickGPU([amdIgpu, amdDiscrete, intel])).toBe('amd')
  })
})
