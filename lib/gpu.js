const { execSync } = require("child_process");

const GPU_LABELS = {
  nvidia: "NVIDIA",
  amd: "AMD",
  intel: "Intel",
  mps: "Apple Silicon",
};

const NVIDIA_VENDOR_ID = "10DE";
const AMD_VENDOR_ID = "1002";
const INTEL_VENDOR_ID = "8086";

/**
 * Detect GPU type on the current system.
 * Returns "nvidia", "amd", "intel", or null if no supported GPU is found.
 *
 * Detection order (Windows):
 *   1. WMI query — parses PCI vendor IDs from Win32_VideoController
 *   2. nvidia-smi — fallback for NVIDIA driver detection
 *
 * macOS returns "mps" for Apple Silicon, null for Intel.
 * Linux is not yet supported (returns null).
 */
function detectGPU() {
  let id = null;
  if (process.platform === "win32") {
    id = detectWindowsGPU();
  } else if (process.platform === "darwin") {
    id = detectMacGPU();
  }
  if (!id) return null;
  return { id, label: GPU_LABELS[id] || id };
}

function detectWindowsGPU() {
  // Method 1: WMI query for PCI vendor IDs
  const wmiResult = queryWmiVendorIds();
  if (wmiResult) return wmiResult;

  // Method 2: nvidia-smi fallback
  if (hasNvidiaSmi()) return "nvidia";

  return null;
}

function queryWmiVendorIds() {
  try {
    const raw = execSync(
      'powershell.exe -NoProfile -NonInteractive -Command "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty PNPDeviceID | ConvertTo-Json -Compress"',
      { timeout: 10000, encoding: "utf-8", windowsHide: true }
    );
    const ids = JSON.parse(raw);
    const list = Array.isArray(ids) ? ids : [ids];

    let hasIntel = false;
    for (const id of list) {
      const match = id.match(/ven_([0-9a-f]{4})/i);
      if (!match) continue;
      const vendor = match[1].toUpperCase();
      if (vendor === NVIDIA_VENDOR_ID) return "nvidia";
      if (vendor === AMD_VENDOR_ID) return "amd";
      if (vendor === INTEL_VENDOR_ID) hasIntel = true;
    }
    if (hasIntel) return "intel";
  } catch {}
  return null;
}

function hasNvidiaSmi() {
  try {
    execSync("nvidia-smi", { timeout: 5000, stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function detectMacGPU() {
  try {
    const info = execSync("sysctl -n machdep.cpu.brand_string", {
      timeout: 5000, encoding: "utf-8", windowsHide: true,
    }).trim();
    // Apple Silicon reports "Apple" in brand string
    if (info.toLowerCase().includes("apple")) return "mps";
  } catch {}
  return null;
}

module.exports = { detectGPU };
