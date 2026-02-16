const fs = require("fs");
const path = require("path");
const { fetchJSON } = require("../lib/fetch");
const { deleteAction, untrackAction } = require("../lib/actions");
const { downloadAndExtract } = require("../lib/installer");

const RELEASE_REPO = "Kosinkadink/ComfyUI-Launcher-Environments";
const ENVS_DIR = "envs";
const DEFAULT_ENV = "default";

const VARIANT_LABELS = {
  "nvidia": "NVIDIA",
  "intel-xpu": "Intel Arc (XPU)",
  "amd": "AMD",
  "cpu": "CPU",
  "mps": "Apple Silicon (MPS)",
};

const PLATFORM_PREFIX = {
  win32: "win-",
  darwin: "mac-",
  linux: "linux-",
};

function getVariantLabel(variantId) {
  // Strip platform prefix (e.g. "win-nvidia-cu128" -> "nvidia-cu128")
  const stripped = variantId.replace(/^(win|mac|linux)-/, "");
  // Try exact match first, then match base key (e.g. "nvidia-cu128" starts with "nvidia")
  if (VARIANT_LABELS[stripped]) return VARIANT_LABELS[stripped];
  for (const [key, label] of Object.entries(VARIANT_LABELS)) {
    if (stripped === key || stripped.startsWith(key + "-")) {
      const suffix = stripped.slice(key.length + 1); // e.g. "cu128"
      return suffix ? `${label} (${suffix.toUpperCase()})` : label;
    }
  }
  return stripped;
}

function getUvPath(installPath) {
  if (process.platform === "win32") {
    return path.join(installPath, "standalone-env", "uv.exe");
  }
  return path.join(installPath, "standalone-env", "bin", "uv");
}

function findSitePackages(envRoot) {
  if (process.platform === "win32") {
    return path.join(envRoot, "Lib", "site-packages");
  }
  const libDir = path.join(envRoot, "lib");
  try {
    const pyDir = fs.readdirSync(libDir).find((d) => d.startsWith("python"));
    if (pyDir) return path.join(libDir, pyDir, "site-packages");
  } catch {}
  return null;
}

function createEnv(installPath, envName) {
  const { execFile } = require("child_process");
  const uvPath = getUvPath(installPath);
  const masterPython = getMasterPythonPath(installPath);
  const envPath = path.join(installPath, ENVS_DIR, envName);
  return new Promise((resolve, reject) => {
    execFile(uvPath, ["venv", "--python", masterPython, envPath], { cwd: installPath }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Failed to create environment "${envName}": ${stderr || err.message}`));

      const masterSitePackages = findSitePackages(path.join(installPath, "standalone-env"));
      const envSitePackages = findSitePackages(envPath);
      if (!masterSitePackages || !envSitePackages || !fs.existsSync(masterSitePackages)) {
        return reject(new Error(`Could not locate site-packages for environment "${envName}".`));
      }
      try {
        fs.cpSync(masterSitePackages, envSitePackages, { recursive: true });
      } catch (copyErr) {
        return reject(new Error(`Failed to copy packages to "${envName}": ${copyErr.message}`));
      }
      resolve(envPath);
    });
  });
}

function getMasterPythonPath(installPath) {
  if (process.platform === "win32") {
    return path.join(installPath, "standalone-env", "python.exe");
  }
  return path.join(installPath, "standalone-env", "bin", "python3");
}

function getEnvPythonPath(installPath, envName) {
  const envDir = path.join(installPath, ENVS_DIR, envName);
  if (process.platform === "win32") {
    return path.join(envDir, "Scripts", "python.exe");
  }
  return path.join(envDir, "bin", "python3");
}

function getActivePythonPath(installation) {
  const activeEnv = installation.activeEnv || DEFAULT_ENV;
  const envPython = getEnvPythonPath(installation.installPath, activeEnv);
  if (fs.existsSync(envPython)) return envPython;
  return getMasterPythonPath(installation.installPath);
}

function listEnvs(installPath) {
  const envsPath = path.join(installPath, ENVS_DIR);
  if (!fs.existsSync(envsPath)) return [];
  try {
    return fs.readdirSync(envsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function recommendVariant(variantId, gpu) {
  const stripped = variantId.replace(/^(win|mac|linux)-/, "");
  if (!gpu) return stripped === "cpu";
  if (gpu === "nvidia") return stripped === "nvidia" || stripped.startsWith("nvidia-");
  if (gpu === "amd") return stripped === "amd" || stripped.startsWith("amd-");
  if (gpu === "mps") return stripped === "mps" || stripped.startsWith("mps-");
  if (gpu === "intel") return stripped === "intel-xpu" || stripped.startsWith("intel-xpu-");
  return false;
}

module.exports = {
  id: "standalone",
  label: "Standalone",

  fields: [
    { id: "release", label: "Release", type: "select" },
    { id: "variant", label: "Environment Variant", type: "select" },
  ],

  defaultLaunchArgs: "--disable-auto-launch",

  getDefaults() {
    return { launchArgs: this.defaultLaunchArgs, launchMode: "window" };
  },

  buildInstallation(selections) {
    const manifest = selections.variant?.data?.manifest;
    return {
      version: manifest?.comfyui_ref || selections.release?.value || "unknown",
      releaseTag: selections.release?.value || "unknown",
      variant: selections.variant?.data?.variantId || "",
      downloadUrl: selections.variant?.value || "",
      pythonVersion: manifest?.python_version || "",
      launchArgs: this.defaultLaunchArgs,
      launchMode: "window",
    };
  },

  getLaunchCommand(installation) {
    const pythonPath = getActivePythonPath(installation);
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
    const installed = installation.status === "installed";
    const activeEnv = installation.activeEnv || DEFAULT_ENV;
    const envs = installed && installation.installPath ? listEnvs(installation.installPath) : [];
    const hasEnvs = envs.length > 0;

    const envItems = envs.map((name) => ({
      label: name,
      active: name === activeEnv,
      actions: [
        { id: "env-activate", label: "Set Active", style: "default", enabled: name !== activeEnv, data: { env: name } },
        { id: "env-reset", label: "Reset", style: "danger", enabled: true, data: { env: name },
          confirm: { title: "Reset Environment", message: `Reset "${name}" to the master environment state? All installed packages will be lost.` } },
        { id: "env-delete", label: "Delete", style: "danger", enabled: name !== activeEnv, data: { env: name },
          confirm: { title: "Delete Environment", message: `Delete environment "${name}"? This cannot be undone.` } },
      ],
    }));

    return [
      {
        title: "Installation Info",
        fields: [
          { label: "Install Method", value: installation.sourceLabel },
          { label: "ComfyUI", value: installation.version },
          { label: "Release", value: installation.releaseTag || "—" },
          { label: "Variant", value: installation.variant ? getVariantLabel(installation.variant) : "—" },
          { label: "Python", value: installation.pythonVersion || "—" },
          { label: "Location", value: installation.installPath || "—" },
          { label: "Installed", value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
      {
        title: "Python Environments",
        description: hasEnvs
          ? `Active: ${activeEnv}`
          : "No virtual environments created yet.",
        items: envItems,
        actions: [
          { id: "env-create", label: "New Environment", style: "default", enabled: installed },
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
          { id: "launch", label: "Launch", style: "primary", enabled: installed,
            showProgress: true, progressTitle: "Starting ComfyUI…", cancellable: true },
          { id: "open-folder", label: "Open Directory", style: "default", enabled: !!installation.installPath },
          { id: "check-update", label: "Check for Update", style: "default", enabled: false },
          deleteAction(installation),
          untrackAction(),
        ],
      },
    ];
  },

  async install(installation, tools) {
    const filename = installation.downloadUrl.split("/").pop();
    const cacheKey = `${installation.releaseTag}_${filename}`;
    await downloadAndExtract(installation.downloadUrl, installation.installPath, cacheKey, tools);
  },

  async postInstall(installation, { sendProgress }) {
    sendProgress("setup", { percent: -1, status: "Creating default Python environment…" });
    await createEnv(installation.installPath, DEFAULT_ENV);
  },

  probeInstallation(dirPath) {
    const envExists = fs.existsSync(path.join(dirPath, "standalone-env"));
    const mainExists = fs.existsSync(path.join(dirPath, "ComfyUI", "main.py"));
    if (!envExists || !mainExists) return null;
    const hasGit = fs.existsSync(path.join(dirPath, "ComfyUI", ".git"));
    return {
      version: "unknown",
      variant: "",
      hasGit,
      launchArgs: this.defaultLaunchArgs,
      launchMode: "window",
    };
  },

  async handleAction(actionId, installation, actionData) {
    if (actionId === "env-create") {
      return { ok: false, message: "Environment creation is not yet implemented." };
    }
    if (actionId === "env-activate") {
      return { ok: false, message: "Environment activation is not yet implemented." };
    }
    if (actionId === "env-reset") {
      return { ok: false, message: "Environment reset is not yet implemented." };
    }
    if (actionId === "env-delete") {
      return { ok: false, message: "Environment deletion is not yet implemented." };
    }
    return { ok: false, message: `Action "${actionId}" not yet implemented.` };
  },

  async getFieldOptions(fieldId, selections, context) {
    if (fieldId === "release") {
      const [releases, latest] = await Promise.all([
        fetchJSON(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`),
        fetchJSON(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`).catch(() => null),
      ]);
      // Merge latest into the list in case the list endpoint returns stale data
      if (latest && !releases.some((r) => r.id === latest.id)) {
        releases.unshift(latest);
      }
      return releases
        .filter((r) => r.assets.some((a) => a.name === "manifests.json"))
        .map((r) => {
          const name = r.name && r.name !== r.tag_name ? `${r.tag_name}  —  ${r.name}` : r.tag_name;
          return { value: r.tag_name, label: name, data: r };
        });
    }

    if (fieldId === "variant") {
      const release = selections.release?.data;
      if (!release) return [];
      const prefix = PLATFORM_PREFIX[process.platform];
      if (!prefix) return [];

      const manifestAsset = release.assets.find((a) => a.name === "manifests.json");
      if (!manifestAsset) return [];
      const manifests = await fetchJSON(manifestAsset.browser_download_url);

      const gpu = context && context.gpu;
      return manifests
        .filter((m) => m.id.startsWith(prefix))
        .map((m) => {
          const asset = release.assets.find((a) => a.name === m.filename);
          const sizeMB = asset ? (asset.size / 1048576).toFixed(0) : "?";
          const downloadUrl = asset ? asset.browser_download_url : "";
          return {
            value: downloadUrl,
            label: `${getVariantLabel(m.id)}  —  ComfyUI ${m.comfyui_ref}  ·  Python ${m.python_version}  ·  ${sizeMB} MB`,
            data: { variantId: m.id, manifest: m },
            recommended: recommendVariant(m.id, gpu),
          };
        })
        .filter((opt) => opt.value);
    }

    return [];
  },
};
