import { describe, expect, it } from 'vitest'
import { parseNvidiaDriverVersion } from './gpu'

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
