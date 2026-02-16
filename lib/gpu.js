const { execFile } = require("child_process");
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

function pickGPU(hasNvidia, hasAmd, hasIntel) {
  if (hasNvidia) return "nvidia";
  if (hasAmd) return "amd";
  if (hasIntel) return "intel";
  return null;
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
async function detectGPU() {
  let id = null;
  if (process.platform === "win32") {
    id = await detectWindowsGPU();
  } else if (process.platform === "darwin") {
    id = await detectMacGPU();
  } else if (process.platform === "linux") {
    id = await detectLinuxGPU();
  }
  if (!id) return null;
  return { id, label: GPU_LABELS[id] || id };
}

async function detectWindowsGPU() {
  const wmiResult = await queryWmiVendorIds();
  if (wmiResult) return wmiResult;
  if (await hasNvidiaSmi()) return "nvidia";
  return null;
}

function queryWmiVendorIds() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty PNPDeviceID | ConvertTo-Json -Compress'],
      { timeout: 10000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const ids = JSON.parse(stdout);
          const list = Array.isArray(ids) ? ids : [ids];
          let hasNvidia = false, hasAmd = false, hasIntel = false;
          for (const id of list) {
            const match = id.match(/ven_([0-9a-f]{4})/i);
            if (!match) continue;
            const vendor = match[1].toUpperCase();
            if (vendor === NVIDIA_VENDOR_ID) hasNvidia = true;
            else if (vendor === AMD_VENDOR_ID) hasAmd = true;
            else if (vendor === INTEL_VENDOR_ID) hasIntel = true;
          }
          resolve(pickGPU(hasNvidia, hasAmd, hasIntel));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function hasNvidiaSmi() {
  return new Promise((resolve) => {
    execFile("nvidia-smi", { timeout: 5000, windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

async function detectLinuxGPU() {
  const lspciResult = await queryLspciVendors();
  if (lspciResult) return lspciResult;
  const sysfsResult = querySysfsVendors();
  if (sysfsResult) return sysfsResult;
  if (await hasNvidiaSmi()) return "nvidia";
  return null;
}

function queryLspciVendors() {
  return new Promise((resolve) => {
    execFile("lspci", ["-nn"], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      let hasNvidia = false, hasAmd = false, hasIntel = false;
      for (const line of stdout.split("\n")) {
        if (!/vga|3d|display/i.test(line)) continue;
        const match = line.match(/\[([0-9a-f]{4}):[0-9a-f]{4}\]/i);
        if (!match) continue;
        const vendor = match[1].toUpperCase();
        if (vendor === NVIDIA_VENDOR_ID) hasNvidia = true;
        else if (vendor === AMD_VENDOR_ID) hasAmd = true;
        else if (vendor === INTEL_VENDOR_ID) hasIntel = true;
      }
      resolve(pickGPU(hasNvidia, hasAmd, hasIntel));
    });
  });
}

function querySysfsVendors() {
  try {
    const cards = fs.readdirSync("/sys/class/drm").filter((d) => /^card\d+$/.test(d));
    let hasNvidia = false, hasAmd = false, hasIntel = false;
    for (const card of cards) {
      try {
        const vendor = fs.readFileSync(`/sys/class/drm/${card}/device/vendor`, "utf-8").trim().replace(/^0x/i, "").toUpperCase();
        if (vendor === NVIDIA_VENDOR_ID) hasNvidia = true;
        else if (vendor === AMD_VENDOR_ID) hasAmd = true;
        else if (vendor === INTEL_VENDOR_ID) hasIntel = true;
      } catch {}
    }
    return pickGPU(hasNvidia, hasAmd, hasIntel);
  } catch {}
  return null;
}

async function detectMacGPU() {
  return new Promise((resolve) => {
    execFile("sysctl", ["-n", "machdep.cpu.brand_string"], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.toLowerCase().includes("apple") ? "mps" : null);
    });
  });
}

module.exports = { detectGPU };
