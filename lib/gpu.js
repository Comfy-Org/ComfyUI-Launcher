const { execSync } = require("child_process");
const fs = require("fs");

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
 * Detection order (Linux / WSL):
 *   1. lspci — parses PCI vendor IDs from VGA/3D controllers
 *   2. /sys/class/drm — reads vendor IDs from sysfs
 *   3. nvidia-smi — fallback for NVIDIA (especially useful on WSL)
 *
 * macOS returns "mps" for Apple Silicon, null for Intel.
 */
function detectGPU() {
  let id = null;
  if (process.platform === "win32") {
    id = detectWindowsGPU();
  } else if (process.platform === "darwin") {
    id = detectMacGPU();
  } else if (process.platform === "linux") {
    id = detectLinuxGPU();
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

    // Collect all detected vendors, then pick the best discrete GPU.
    // Priority: NVIDIA > AMD > Intel (iGPUs should not shadow discrete cards).
    let hasNvidia = false;
    let hasAmd = false;
    let hasIntel = false;
    for (const id of list) {
      const match = id.match(/ven_([0-9a-f]{4})/i);
      if (!match) continue;
      const vendor = match[1].toUpperCase();
      if (vendor === NVIDIA_VENDOR_ID) hasNvidia = true;
      else if (vendor === AMD_VENDOR_ID) hasAmd = true;
      else if (vendor === INTEL_VENDOR_ID) hasIntel = true;
    }
    if (hasNvidia) return "nvidia";
    if (hasAmd) return "amd";
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

function detectLinuxGPU() {
  // Method 1: lspci — available on most native Linux installs
  const lspciResult = queryLspciVendors();
  if (lspciResult) return lspciResult;

  // Method 2: sysfs — read PCI vendor IDs from /sys/class/drm
  const sysfsResult = querySysfsVendors();
  if (sysfsResult) return sysfsResult;

  // Method 3: nvidia-smi — fallback, especially useful on WSL where lspci/sysfs are unavailable
  if (hasNvidiaSmi()) return "nvidia";

  return null;
}

function queryLspciVendors() {
  try {
    const raw = execSync('lspci -nn 2>/dev/null', { timeout: 5000, encoding: "utf-8" });
    let hasNvidia = false;
    let hasAmd = false;
    let hasIntel = false;
    for (const line of raw.split("\n")) {
      if (!/vga|3d|display/i.test(line)) continue;
      // PCI vendor IDs appear as [XXXX:YYYY] in lspci -nn output
      const match = line.match(/\[([0-9a-f]{4}):[0-9a-f]{4}\]/i);
      if (!match) continue;
      const vendor = match[1].toUpperCase();
      if (vendor === NVIDIA_VENDOR_ID) hasNvidia = true;
      else if (vendor === AMD_VENDOR_ID) hasAmd = true;
      else if (vendor === INTEL_VENDOR_ID) hasIntel = true;
    }
    if (hasNvidia) return "nvidia";
    if (hasAmd) return "amd";
    if (hasIntel) return "intel";
  } catch {}
  return null;
}

function querySysfsVendors() {
  try {
    const cards = fs.readdirSync("/sys/class/drm").filter((d) => /^card\d+$/.test(d));
    let hasNvidia = false;
    let hasAmd = false;
    let hasIntel = false;
    for (const card of cards) {
      try {
        const vendor = fs.readFileSync(`/sys/class/drm/${card}/device/vendor`, "utf-8").trim().replace(/^0x/i, "").toUpperCase();
        if (vendor === NVIDIA_VENDOR_ID) hasNvidia = true;
        else if (vendor === AMD_VENDOR_ID) hasAmd = true;
        else if (vendor === INTEL_VENDOR_ID) hasIntel = true;
      } catch {}
    }
    if (hasNvidia) return "nvidia";
    if (hasAmd) return "amd";
    if (hasIntel) return "intel";
  } catch {}
  return null;
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
