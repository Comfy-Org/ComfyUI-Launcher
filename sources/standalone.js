const fs = require("fs");
const path = require("path");
const { fetchJSON } = require("../lib/fetch");
const { deleteAction, untrackAction } = require("../lib/actions");
const { cloneComfyUI } = require("../lib/git");
const { downloadAndExtract } = require("../lib/installer");

const RELEASE_REPO = "Kosinkadink/ComfyUI-Launcher-Environments";

const VARIANT_LABELS = {
  "win-nvidia-cu130": "NVIDIA (CUDA 13.0)",
  "win-nvidia-cu128": "NVIDIA (CUDA 12.8)",
  "win-nvidia-cu126": "NVIDIA (CUDA 12.6)",
  "win-intel-xpu": "Intel Arc (XPU)",
  "win-amd": "AMD",
  "win-cpu": "CPU",
  "mac-mps": "Apple Silicon (MPS)",
  "linux-nvidia-cu130": "NVIDIA (CUDA 13.0)",
  "linux-nvidia-cu128": "NVIDIA (CUDA 12.8)",
  "linux-nvidia-cu126": "NVIDIA (CUDA 12.6)",
  "linux-intel-xpu": "Intel Arc (XPU)",
  "linux-amd": "AMD (ROCm)",
  "linux-cpu": "CPU",
};

const PLATFORM_PREFIX = {
  win32: "win-",
  darwin: "mac-",
  linux: "linux-",
};

function parseVariantId(filename) {
  const match = filename.match(/^comfyui-standalone-(.+)\.(7z|tar\.gz)$/);
  return match ? match[1] : null;
}

function getPythonPath(installPath) {
  if (process.platform === "win32") {
    return path.join(installPath, "standalone-env", "python.exe");
  }
  return path.join(installPath, "standalone-env", "bin", "python3");
}

function recommendVariant(variantId, gpu) {
  if (!gpu) return variantId.endsWith("-cpu");
  if (gpu === "nvidia") return variantId.endsWith("-nvidia-cu130");
  if (gpu === "amd") return variantId.includes("-amd");
  if (gpu === "mps") return variantId.includes("-mps");
  if (gpu === "intel") return variantId.endsWith("-intel-xpu");
  return false;
}

module.exports = {
  id: "standalone",
  label: "Standalone Environment",

  fields: [
    { id: "release", label: "Release", type: "select" },
    { id: "variant", label: "Environment Variant", type: "select" },
  ],

  defaultLaunchArgs: "--disable-auto-launch",

  getDefaults() {
    return { launchArgs: this.defaultLaunchArgs, launchMode: "window" };
  },

  buildInstallation(selections) {
    return {
      version: selections.release?.value || "unknown",
      variant: selections.variant?.data?.variantId || "",
      downloadUrl: selections.variant?.value || "",
      launchArgs: this.defaultLaunchArgs,
      launchMode: "window",
    };
  },

  getLaunchCommand(installation) {
    const pythonPath = getPythonPath(installation.installPath);
    if (!fs.existsSync(pythonPath)) return null;
    const mainPy = path.join(installation.installPath, "ComfyUI", "main.py");
    if (!fs.existsSync(mainPy)) return null;
    const userArgs = (installation.launchArgs || this.defaultLaunchArgs).trim();
    const parsed = userArgs.length > 0 ? userArgs.split(/\s+/) : [];
    const portIdx = parsed.indexOf("--port");
    const port = portIdx >= 0 && parsed[portIdx + 1] ? parseInt(parsed[portIdx + 1], 10) || 8188 : 8188;
    return {
      cmd: pythonPath,
      args: ["-s", path.join("ComfyUI", "main.py"), ...parsed],
      cwd: installation.installPath,
      port,
    };
  },

  getListActions(installation) {
    const installed = installation.status === "installed";
    return [
      { id: "launch", label: "Launch", style: "primary", enabled: installed,
        showProgress: true, progressTitle: "Starting ComfyUI…", cancellable: true },
    ];
  },

  getDetailSections(installation) {
    return [
      {
        title: "Installation Info",
        fields: [
          { label: "Install Method", value: installation.sourceLabel },
          { label: "Version", value: installation.version },
          { label: "Variant", value: VARIANT_LABELS[installation.variant] || installation.variant || "—" },
          { label: "Location", value: installation.installPath || "—" },
          { label: "Installed", value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
      {
        title: "Launch Settings",
        fields: [
          { id: "launchArgs", label: "Startup Arguments", value: installation.launchArgs ?? this.defaultLaunchArgs, editable: true },
          { id: "launchMode", label: "Launch Mode", value: installation.launchMode || "window", editable: true,
            editType: "select", options: [
              { value: "window", label: "App window" },
              { value: "console", label: "Console only" },
            ] },
        ],
      },
      {
        title: "Actions",
        actions: [
          { id: "launch", label: "Launch", style: "primary", enabled: installation.status === "installed",
            showProgress: true, progressTitle: "Starting ComfyUI…", cancellable: true },
          { id: "check-update", label: "Check for Update", style: "default", enabled: false },
          deleteAction(installation),
          untrackAction(),
        ],
      },
    ];
  },

  async install(installation, tools) {
    const cacheKey = `${installation.version}_comfyui-standalone-${installation.variant}`;
    await downloadAndExtract(installation.downloadUrl, installation.installPath, cacheKey, tools);

    tools.sendProgress("clone", { percent: -1, status: "Cloning ComfyUI repository…" });
    await cloneComfyUI(getPythonPath(installation.installPath), installation.installPath);

    tools.sendProgress("done", { percent: 100, status: "Complete" });
  },

  probeInstallation(dirPath) {
    const envExists = fs.existsSync(path.join(dirPath, "standalone-env"));
    const mainExists = fs.existsSync(path.join(dirPath, "ComfyUI", "main.py"));
    if (envExists && mainExists) return { version: "unknown", variant: "", launchArgs: this.defaultLaunchArgs, launchMode: "window" };
    return null;
  },

  // Cache settings are shared with portable and rendered once via ipc.js

  async handleAction(actionId, installation) {
    return { ok: false, message: `Action "${actionId}" not yet implemented.` };
  },

  async getFieldOptions(fieldId, selections, context) {
    if (fieldId === "release") {
      const releases = await fetchJSON(
        `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`
      );
      return releases
        .filter((r) => r.assets.some((a) => /^comfyui-standalone-.+\.(7z|tar\.gz)$/.test(a.name)))
        .map((r) => ({
          value: r.tag_name,
          label: r.name && r.name !== r.tag_name ? `${r.tag_name}  —  ${r.name}` : r.tag_name,
          data: r,
        }));
    }

    if (fieldId === "variant") {
      const release = selections.release?.data;
      if (!release) return [];
      const prefix = PLATFORM_PREFIX[process.platform];
      if (!prefix) return [];
      const gpu = context && context.gpu;
      return release.assets
        .filter((a) => {
          const id = parseVariantId(a.name);
          return id && id.startsWith(prefix);
        })
        .map((a) => {
          const variantId = parseVariantId(a.name);
          return {
            value: a.browser_download_url,
            label: `${VARIANT_LABELS[variantId] || variantId}  —  ${(a.size / 1048576).toFixed(0)} MB`,
            data: { ...a, variantId },
            recommended: recommendVariant(variantId, gpu),
          };
        });
    }

    return [];
  },
};
