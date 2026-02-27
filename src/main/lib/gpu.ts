import { execFile } from 'child_process'
import fs from 'fs'
import type { HardwareValidation, NvidiaDriverCheck } from '../../types/ipc'

type GpuId = 'nvidia' | 'amd' | 'intel' | 'mps'

export interface GpuInfo {
  id: GpuId
  label: string
}

const GPU_LABELS: Record<GpuId, string> = {
  nvidia: "NVIDIA",
  amd: "AMD",
  intel: "Intel",
  mps: "Apple Silicon",
}

const NVIDIA_VENDOR_ID = "10DE"
const AMD_VENDOR_ID = "1002"
const INTEL_VENDOR_ID = "8086"

function pickGPU(hasNvidia: boolean, hasAmd: boolean, hasIntel: boolean): GpuId | null {
  if (hasNvidia) return "nvidia"
  if (hasAmd) return "amd"
  if (hasIntel) return "intel"
  return null
}

/**
 * Detect GPU type on the current system (async).
 * Returns { id, label } or null if no supported GPU is found.
 *
 * Detection order (Windows):
 *   1. WMI query — parses PCI vendor IDs from Win32_VideoController
 *   2. nvidia-smi — fallback for NVIDIA driver detection
 *
 * Detection order (Linux / WSL):
 *   1. lspci — parses PCI vendor IDs from VGA/3D controllers
 *   2. /sys/class/drm — reads vendor IDs from sysfs
 *   3. nvidia-smi — fallback for NVIDIA (especially useful on WSL)
 *
 * macOS returns "mps" for Apple Silicon, null for Intel.
 */
async function detectGPU(): Promise<GpuInfo | null> {
  let id: GpuId | null = null
  if (process.platform === "win32") {
    id = await detectWindowsGPU()
  } else if (process.platform === "darwin") {
    id = await detectMacGPU()
  } else if (process.platform === "linux") {
    id = await detectLinuxGPU()
  }
  if (!id) return null
  return { id, label: GPU_LABELS[id] }
}

async function detectWindowsGPU(): Promise<GpuId | null> {
  const wmiResult = await queryWmiVendorIds()
  if (wmiResult) return wmiResult
  if (await hasNvidiaSmi()) return "nvidia"
  return null
}

function queryWmiVendorIds(): Promise<GpuId | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty PNPDeviceID | ConvertTo-Json -Compress'],
      { timeout: 10000, windowsHide: true },
      (err: Error | null, stdout: string) => {
        if (err) return resolve(null)
        try {
          const ids: unknown = JSON.parse(stdout)
          const list: unknown[] = Array.isArray(ids) ? ids : [ids]
          let hasNvidia = false, hasAmd = false, hasIntel = false
          for (const id of list) {
            if (typeof id !== "string") continue
            const match = id.match(/ven_([0-9a-f]{4})/i)
            if (!match || !match[1]) continue
            const vendor = match[1].toUpperCase()
            if (vendor === NVIDIA_VENDOR_ID) hasNvidia = true
            else if (vendor === AMD_VENDOR_ID) hasAmd = true
            else if (vendor === INTEL_VENDOR_ID) hasIntel = true
          }
          resolve(pickGPU(hasNvidia, hasAmd, hasIntel))
        } catch {
          resolve(null)
        }
      },
    )
  })
}

function hasNvidiaSmi(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", { timeout: 5000, windowsHide: true }, (err: Error | null) => {
      resolve(!err)
    })
  })
}

async function detectLinuxGPU(): Promise<GpuId | null> {
  const lspciResult = await queryLspciVendors()
  if (lspciResult) return lspciResult
  const sysfsResult = querySysfsVendors()
  if (sysfsResult) return sysfsResult
  if (await hasNvidiaSmi()) return "nvidia"
  return null
}

function queryLspciVendors(): Promise<GpuId | null> {
  return new Promise((resolve) => {
    execFile("lspci", ["-nn"], { timeout: 5000 }, (err: Error | null, stdout: string) => {
      if (err) return resolve(null)
      let hasNvidia = false, hasAmd = false, hasIntel = false
      for (const line of stdout.split("\n")) {
        if (!/vga|3d|display/i.test(line)) continue
        const match = line.match(/\[([0-9a-f]{4}):[0-9a-f]{4}\]/i)
        if (!match || !match[1]) continue
        const vendor = match[1].toUpperCase()
        if (vendor === NVIDIA_VENDOR_ID) hasNvidia = true
        else if (vendor === AMD_VENDOR_ID) hasAmd = true
        else if (vendor === INTEL_VENDOR_ID) hasIntel = true
      }
      resolve(pickGPU(hasNvidia, hasAmd, hasIntel))
    })
  })
}

function querySysfsVendors(): GpuId | null {
  try {
    const cards = fs.readdirSync("/sys/class/drm").filter((d) => /^card\d+$/.test(d))
    let hasNvidia = false, hasAmd = false, hasIntel = false
    for (const card of cards) {
      try {
        const vendor = fs.readFileSync(`/sys/class/drm/${card}/device/vendor`, "utf-8").trim().replace(/^0x/i, "").toUpperCase()
        if (vendor === NVIDIA_VENDOR_ID) hasNvidia = true
        else if (vendor === AMD_VENDOR_ID) hasAmd = true
        else if (vendor === INTEL_VENDOR_ID) hasIntel = true
      } catch {}
    }
    return pickGPU(hasNvidia, hasAmd, hasIntel)
  } catch {}
  return null
}

async function detectMacGPU(): Promise<GpuId | null> {
  return new Promise((resolve) => {
    execFile("sysctl", ["-n", "machdep.cpu.brand_string"], { timeout: 5000 }, (err: Error | null, stdout: string) => {
      if (err) return resolve(null)
      resolve(stdout.toLowerCase().includes("apple") ? "mps" : null)
    })
  })
}

/**
 * Minimum NVIDIA driver version for PyTorch 2.10 with CUDA 13.0 (cu130).
 * Matches desktop's NVIDIA_DRIVER_MIN_VERSION.
 * See: https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/
 */
const NVIDIA_DRIVER_MIN_VERSION = "580"

/**
 * Compare two dotted version strings numerically.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na - nb
  }
  return 0
}

/**
 * Parse the NVIDIA driver version from nvidia-smi standard output.
 * Matches "Driver Version: XXX.XX" from the table header.
 */
export function parseNvidiaDriverVersion(output: string): string | undefined {
  const match = output.match(/driver version\s*:\s*([\d.]+)/i)
  return match?.[1]
}

/**
 * Query nvidia-smi for the driver version using the structured CSV flag.
 * Works on both Windows and Linux.
 */
function getNvidiaDriverVersionQuery(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=driver_version", "--format=csv,noheader"],
      { timeout: 5000, windowsHide: true },
      (err: Error | null, stdout: string) => {
        if (err) return resolve(undefined)
        const version = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)
        resolve(version || undefined)
      },
    )
  })
}

/**
 * Fallback: parse driver version from plain nvidia-smi output.
 */
function getNvidiaDriverVersionFallback(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      { timeout: 5000, windowsHide: true },
      (err: Error | null, stdout: string) => {
        if (err) return resolve(undefined)
        resolve(parseNvidiaDriverVersion(stdout))
      },
    )
  })
}

/**
 * Check whether the installed NVIDIA driver meets the minimum version.
 * Returns null if no NVIDIA driver is detected (e.g. AMD/Intel/macOS).
 * Works on Windows and Linux.
 */
async function checkNvidiaDriver(): Promise<NvidiaDriverCheck | null> {
  if (process.platform === "darwin") return null

  const driverVersion =
    (await getNvidiaDriverVersionQuery()) ?? (await getNvidiaDriverVersionFallback())
  if (!driverVersion) return null

  return {
    driverVersion,
    minimumVersion: NVIDIA_DRIVER_MIN_VERSION,
    supported: compareVersions(driverVersion, NVIDIA_DRIVER_MIN_VERSION) >= 0,
  }
}

/**
 * Validate system hardware requirements for standalone ComfyUI installation.
 * Mirrors the desktop app's validateHardware() — rejects Intel Macs since
 * the MPS backend requires Apple Silicon.
 */
async function validateHardware(): Promise<HardwareValidation> {
  if (process.platform === "darwin") {
    const gpu = await detectMacGPU()
    if (!gpu) {
      return {
        supported: false,
        error: "ComfyUI requires Apple Silicon (M1/M2/M3) Mac. Intel-based Macs are not supported.",
      }
    }
  }
  return { supported: true }
}

export { detectGPU, checkNvidiaDriver, validateHardware }
