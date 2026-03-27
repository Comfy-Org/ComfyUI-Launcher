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

/** Info about a single detected GPU device. */
export interface GpuDevice {
  vendor: string          // Uppercase PCI vendor ID (e.g. "10DE")
  name?: string           // Human-readable name (e.g. "Intel(R) Arc(TM) A770")
  adapterRam?: number     // Dedicated VRAM in bytes (Windows WMI only)
  discrete?: boolean      // Explicitly known discrete/integrated status
}

/**
 * Heuristic: returns true if an AMD GPU device looks like an integrated GPU
 * (iGPU built into an AMD CPU) rather than a discrete Radeon card.
 *
 * Integrated AMD GPUs typically have generic names like:
 *   "AMD Radeon(TM) Graphics", "AMD Radeon Vega 8 Graphics"
 * Discrete AMD GPUs have model numbers like:
 *   "AMD Radeon RX 7900 XTX", "Radeon RX 580"
 */
export function isAmdIgpu(device: GpuDevice): boolean {
  // If we explicitly know it's discrete, trust that
  if (device.discrete === true) return false
  if (device.discrete === false) return true

  // Low or zero dedicated VRAM is a strong iGPU signal (Windows WMI)
  if (device.adapterRam !== undefined && device.adapterRam < 512 * 1024 * 1024) {
    return true
  }

  if (!device.name) return false
  const n = device.name.toLowerCase()

  // Discrete AMD GPUs contain model identifiers like "rx", "pro w", "wx", "vii", "fury"
  if (/\brx\b/.test(n)) return false
  if (/\bpro\s+w/i.test(n)) return false
  if (/\bwx\b/.test(n)) return false
  if (/\bradeon\s+vii\b/.test(n)) return false
  if (/\bfury\b/.test(n)) return false
  if (/\binstinct\b/.test(n)) return false

  // Generic names without a model number are iGPUs
  // e.g. "AMD Radeon(TM) Graphics", "AMD Radeon Vega 8 Graphics"
  if (/radeon.*graphics/i.test(n) && !/\brx\b/.test(n)) return true

  return false
}

/**
 * Pick the best GPU from a list of detected devices.
 *
 * Priority: NVIDIA > discrete AMD > Intel (XPU) > integrated AMD > CPU.
 * When both AMD (iGPU) and Intel (discrete Arc) are present, Intel wins.
 */
export function pickGPU(devices: GpuDevice[]): GpuId | null {
  let hasNvidia = false
  let hasDiscreteAmd = false
  let hasAmdIgpu = false
  let hasIntel = false

  for (const d of devices) {
    if (d.vendor === NVIDIA_VENDOR_ID) {
      hasNvidia = true
    } else if (d.vendor === AMD_VENDOR_ID) {
      if (isAmdIgpu(d)) {
        hasAmdIgpu = true
      } else {
        hasDiscreteAmd = true
      }
    } else if (d.vendor === INTEL_VENDOR_ID) {
      hasIntel = true
    }
  }

  if (hasNvidia) return "nvidia"
  if (hasDiscreteAmd) return "amd"
  if (hasIntel) return "intel"
  if (hasAmdIgpu) return "amd"
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
  const wmiResult = await queryWmiDevices()
  if (wmiResult) return wmiResult
  if (await hasNvidiaSmi()) return "nvidia"
  return null
}

/** WMI record shape returned by our PowerShell query. */
interface WmiVideoController {
  PNPDeviceID?: string
  Name?: string
  AdapterRAM?: number
}

function queryWmiDevices(): Promise<GpuId | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_VideoController | Select-Object PNPDeviceID, Name, AdapterRAM | ConvertTo-Json -Compress'],
      { timeout: 10000, windowsHide: true },
      (err: Error | null, stdout: string) => {
        if (err) return resolve(null)
        try {
          const raw: unknown = JSON.parse(stdout)
          const list: WmiVideoController[] = Array.isArray(raw) ? raw : [raw as WmiVideoController]
          const devices: GpuDevice[] = []
          for (const entry of list) {
            const pnp = entry.PNPDeviceID
            if (typeof pnp !== "string") continue
            const match = pnp.match(/ven_([0-9a-f]{4})/i)
            if (!match?.[1]) continue
            devices.push({
              vendor: match[1].toUpperCase(),
              name: typeof entry.Name === "string" ? entry.Name : undefined,
              adapterRam: typeof entry.AdapterRAM === "number" ? entry.AdapterRAM : undefined,
            })
          }
          resolve(pickGPU(devices))
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
  const lspciResult = await queryLspciDevices()
  if (lspciResult) return lspciResult
  const sysfsResult = querySysfsDevices()
  if (sysfsResult) return sysfsResult
  if (await hasNvidiaSmi()) return "nvidia"
  return null
}

/**
 * Parse lspci -nn output into GpuDevice entries.
 * Each VGA/3D/Display line contains the vendor:device ID and a description
 * that serves as the device name for iGPU heuristics.
 */
function queryLspciDevices(): Promise<GpuId | null> {
  return new Promise((resolve) => {
    execFile("lspci", ["-nn"], { timeout: 5000 }, (err: Error | null, stdout: string) => {
      if (err) return resolve(null)
      const devices: GpuDevice[] = []
      for (const line of stdout.split("\n")) {
        if (!/vga|3d|display/i.test(line)) continue
        const match = line.match(/\[([0-9a-f]{4}):[0-9a-f]{4}\]/i)
        if (!match?.[1]) continue
        // Extract the device description (everything after the class label)
        const descMatch = line.match(/(?:VGA|3D|Display)\s+(?:compatible\s+)?controller:\s*(.+?)(?:\s*\[[0-9a-f]{4}:[0-9a-f]{4}\])/i)
        devices.push({
          vendor: match[1].toUpperCase(),
          name: descMatch?.[1]?.trim(),
        })
      }
      resolve(pickGPU(devices))
    })
  })
}

/**
 * Read GPU info from sysfs (/sys/class/drm/cardN/device/).
 * Sysfs only exposes vendor IDs — device names are not available here,
 * so iGPU classification relies on the lspci fallback (which runs first).
 */
function querySysfsDevices(): GpuId | null {
  try {
    const cards = fs.readdirSync("/sys/class/drm").filter((d) => /^card\d+$/.test(d))
    const devices: GpuDevice[] = []
    for (const card of cards) {
      try {
        const vendor = fs.readFileSync(`/sys/class/drm/${card}/device/vendor`, "utf-8").trim().replace(/^0x/i, "").toUpperCase()
        devices.push({ vendor })
      } catch {}
    }
    return pickGPU(devices)
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
