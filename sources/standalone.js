const fs = require("fs");
const path = require("path");
const { fetchJSON } = require("../lib/fetch");
const { deleteAction, untrackAction } = require("../lib/actions");
const { downloadAndExtract, downloadAndExtractMulti } = require("../lib/installer");
const { deleteDir } = require("../lib/delete");
const { parseArgs, formatTime } = require("../lib/util");
const { t } = require("../lib/i18n");

const RELEASE_REPO = "Kosinkadink/ComfyUI-Launcher-Environments";
const ENVS_DIR = "envs";
const DEFAULT_ENV = "default";
const ENV_METHOD = "copy";
const MANIFEST_FILE = "manifest.json";

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

async function collectFiles(dir) {
  const entries = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const items = await fs.promises.readdir(current, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        stack.push(full);
      } else {
        entries.push(path.relative(dir, full));
      }
    }
  }
  return entries;
}

async function copyDirWithProgress(src, dest, onProgress) {
  const files = await collectFiles(src);
  const total = files.length;
  let copied = 0;
  const step = Math.max(1, Math.floor(total / 100));
  const concurrency = 50;
  const dirPromises = new Map();
  const startTime = Date.now();

  const ensureDir = (dir) => {
    if (dirPromises.has(dir)) return dirPromises.get(dir);
    const p = fs.promises.mkdir(dir, { recursive: true });
    dirPromises.set(dir, p);
    return p;
  };

  let i = 0;
  while (i < files.length) {
    const batch = files.slice(i, i + concurrency);
    await Promise.all(batch.map(async (rel) => {
      const destPath = path.join(dest, rel);
      await ensureDir(path.dirname(destPath));
      await fs.promises.copyFile(path.join(src, rel), destPath);
      copied++;
      if (onProgress && (copied % step === 0 || copied === total)) {
        const elapsedSecs = (Date.now() - startTime) / 1000;
        const etaSecs = copied > 0 ? elapsedSecs * ((total - copied) / copied) : -1;
        onProgress(copied, total, elapsedSecs, etaSecs);
      }
    }));
    i += concurrency;
  }
}

async function codesignBinaries(dir) {
  if (process.platform !== "darwin") return;
  const { execFile } = require("child_process");
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let items;
    try { items = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        stack.push(full);
      } else if (item.name.endsWith(".dylib") || item.name.endsWith(".so")) {
        await new Promise((resolve) => {
          execFile("codesign", ["--force", "--sign", "-", full], (err) => resolve());
        });
      }
    }
  }
}

async function createEnv(installPath, envName, onProgress) {
  const { execFile } = require("child_process");
  const uvPath = getUvPath(installPath);
  const masterPython = getMasterPythonPath(installPath);
  const envPath = path.join(installPath, ENVS_DIR, envName);
  await new Promise((resolve, reject) => {
    execFile(uvPath, ["venv", "--python", masterPython, envPath], { cwd: installPath }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Failed to create environment "${envName}": ${stderr || err.message}`));
      resolve();
    });
  });

  try {
    const masterSitePackages = findSitePackages(path.join(installPath, "standalone-env"));
    const envSitePackages = findSitePackages(envPath);
    if (!masterSitePackages || !envSitePackages || !fs.existsSync(masterSitePackages)) {
      throw new Error(`Could not locate site-packages for environment "${envName}".`);
    }
    await copyDirWithProgress(masterSitePackages, envSitePackages, onProgress);
    await codesignBinaries(envSitePackages);
  } catch (err) {
    await fs.promises.rm(envPath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
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

function resolveActiveEnv(installation) {
  const preferred = installation.activeEnv || DEFAULT_ENV;
  const envs = listEnvs(installation.installPath);
  if (envs.includes(preferred)) return preferred;
  return envs.length > 0 ? envs[0] : null;
}

function getActivePythonPath(installation) {
  const env = resolveActiveEnv(installation);
  if (!env) return null;
  const envPython = getEnvPythonPath(installation.installPath, env);
  if (fs.existsSync(envPython)) return envPython;
  return null;
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
  get label() { return t("standalone.label"); },

  get fields() {
    return [
      { id: "release", label: t("standalone.release"), type: "select" },
      { id: "variant", label: t("standalone.variant"), type: "select" },
    ];
  },

  defaultLaunchArgs: "--enable-manager",

  get installSteps() {
    return [
      { phase: "download", label: t("standalone.download") },
      { phase: "extract", label: t("standalone.extract") },
      { phase: "setup", label: t("standalone.setupEnv") },
    ];
  },

  getDefaults() {
    return { launchArgs: this.defaultLaunchArgs, launchMode: "window", browserPartition: "unique" };
  },

  buildInstallation(selections) {
    const manifest = selections.variant?.data?.manifest;
    return {
      version: manifest?.comfyui_ref || selections.release?.value || "unknown",
      releaseTag: selections.release?.value || "unknown",
      variant: selections.variant?.data?.variantId || "",
      downloadUrl: selections.variant?.data?.downloadUrl || "",
      downloadFiles: selections.variant?.data?.downloadFiles || [],
      pythonVersion: manifest?.python_version || "",
      launchArgs: this.defaultLaunchArgs,
      launchMode: "window",
      browserPartition: "unique",
    };
  },

  getLaunchCommand(installation) {
    const pythonPath = getActivePythonPath(installation);
    if (!pythonPath || !fs.existsSync(pythonPath)) return null;
    const mainPy = path.join(installation.installPath, "ComfyUI", "main.py");
    if (!fs.existsSync(mainPy)) return null;
    const userArgs = (installation.launchArgs || this.defaultLaunchArgs).trim();
    const parsed = userArgs.length > 0 ? parseArgs(userArgs) : [];
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
      { id: "launch", label: t("actions.launch"), style: "primary", enabled: installed,
        showProgress: true, progressTitle: t("standalone.startingComfyUI"), cancellable: true },
    ];
  },

  getDetailSections(installation) {
    const installed = installation.status === "installed";
    const envs = installed && installation.installPath ? listEnvs(installation.installPath) : [];
    const activeEnv = resolveActiveEnv(installation) || DEFAULT_ENV;
    const hasEnvs = envs.length > 0;

    const envItems = envs.map((name) => ({
      label: name,
      active: name === activeEnv,
      actions: [
        ...(name !== activeEnv ? [{ id: "env-activate", label: t("standalone.setActive"), style: "default", data: { env: name } }] : []),
        { id: "env-delete", label: t("standalone.deleteEnv"), style: "danger", enabled: name !== activeEnv, data: { env: name },
          showProgress: true, progressTitle: t("standalone.deletingEnv", { env: name }),
          disabledMessage: t("standalone.cannotDeleteActive"),
          confirm: { title: t("standalone.deleteEnvConfirmTitle"), message: t("standalone.deleteEnvConfirmMessage", { env: name }) } },
      ],
    }));

    return [
      {
        title: t("standalone.installInfo"),
        fields: [
          { label: t("standalone.installMethod"), value: installation.sourceLabel },
          { label: t("standalone.comfyui"), value: installation.version },
          { label: t("standalone.release"), value: installation.releaseTag || "—" },
          { label: t("standalone.variant"), value: installation.variant ? getVariantLabel(installation.variant) : "—" },
          { label: t("standalone.python"), value: installation.pythonVersion || "—" },
          { label: t("standalone.location"), value: installation.installPath || "—" },
          { label: t("standalone.installed"), value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
      {
        title: t("standalone.pythonEnvs"),
        description: hasEnvs
          ? t("standalone.activeEnv", { env: activeEnv })
          : t("standalone.noEnvs"),
        items: envItems,
        actions: [
          { id: "env-create", label: t("standalone.newEnv"), style: "default", enabled: installed,
            showProgress: true, progressTitle: t("standalone.creatingEnv"),
            prompt: { title: t("standalone.newEnvTitle"), message: t("standalone.newEnvMessage"), placeholder: t("standalone.newEnvPlaceholder"), field: "env", confirmLabel: t("standalone.newEnvCreate"), required: t("standalone.newEnvRequired") } },
        ],
      },
      {
        title: t("standalone.launchSettings"),
        fields: [
          { id: "launchArgs", label: t("standalone.startupArgs"), value: installation.launchArgs ?? this.defaultLaunchArgs, editable: true },
          { id: "launchMode", label: t("standalone.launchMode"), value: installation.launchMode || "window", editable: true,
            editType: "select", options: [
              { value: "window", label: t("standalone.launchModeWindow") },
              { value: "console", label: t("standalone.launchModeConsole") },
            ] },
          { id: "browserPartition", label: t("standalone.browserPartition"), value: installation.browserPartition || "shared", editable: true,
            editType: "select", options: [
              { value: "shared", label: t("standalone.partitionShared") },
              { value: "unique", label: t("standalone.partitionUnique") },
            ] },
        ],
      },
      {
        title: "Actions",
        actions: [
          { id: "launch", label: t("actions.launch"), style: "primary", enabled: installed,
            showProgress: true, progressTitle: t("standalone.startingComfyUI"), cancellable: true },
          { id: "open-folder", label: t("actions.openDirectory"), style: "default", enabled: !!installation.installPath },
          { id: "check-update", label: t("actions.checkForUpdate"), style: "default", enabled: false },
          deleteAction(installation),
          untrackAction(),
        ],
      },
    ];
  },

  async install(installation, tools) {
    const files = installation.downloadFiles;
    if (files && files.length > 0) {
      const cacheDir = `${installation.releaseTag}_${installation.variant}`;
      await downloadAndExtractMulti(files, installation.installPath, cacheDir, tools);
    } else if (installation.downloadUrl) {
      const filename = installation.downloadUrl.split("/").pop();
      const cacheKey = `${installation.releaseTag}_${filename}`;
      await downloadAndExtract(installation.downloadUrl, installation.installPath, cacheKey, tools);
    }
  },

  async postInstall(installation, { sendProgress, update }) {
    // Ensure binaries have execute permission on non-Windows platforms
    if (process.platform !== "win32") {
      const binDir = path.join(installation.installPath, "standalone-env", "bin");
      try {
        const entries = fs.readdirSync(binDir);
        for (const entry of entries) {
          const fullPath = path.join(binDir, entry);
          try { fs.chmodSync(fullPath, 0o755); } catch {}
        }
      } catch {}
    }
    sendProgress("setup", { percent: 0, status: "Creating default Python environment…" });
    await createEnv(installation.installPath, DEFAULT_ENV, (copied, total, elapsedSecs, etaSecs) => {
      const percent = Math.round((copied / total) * 100);
      const elapsed = formatTime(elapsedSecs);
      const eta = etaSecs >= 0 ? formatTime(etaSecs) : "—";
      sendProgress("setup", { percent, status: `Copying packages… ${copied} / ${total} files  ·  ${elapsed} elapsed  ·  ${eta} remaining` });
    });
    const envMethods = { ...installation.envMethods, [DEFAULT_ENV]: ENV_METHOD };
    await update({ envMethods });
  },

  probeInstallation(dirPath) {
    const envExists = fs.existsSync(path.join(dirPath, "standalone-env"));
    const mainExists = fs.existsSync(path.join(dirPath, "ComfyUI", "main.py"));
    if (!envExists || !mainExists) return null;
    const hasGit = fs.existsSync(path.join(dirPath, "ComfyUI", ".git"));

    let version = "unknown";
    let releaseTag = "";
    let variant = "";
    let pythonVersion = "";
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dirPath, MANIFEST_FILE), "utf8"));
      version = data.comfyui_ref || version;
      releaseTag = data.version || releaseTag;
      variant = data.id || variant;
      pythonVersion = data.python_version || pythonVersion;
    } catch {}

    return {
      version,
      releaseTag,
      variant,
      pythonVersion,
      hasGit,
      launchArgs: this.defaultLaunchArgs,
      launchMode: "window",
    };
  },

  async handleAction(actionId, installation, actionData, { update, sendProgress }) {
    if (actionId === "env-create") {
      const envName = actionData?.env;
      if (!envName) return { ok: false, message: "No environment name provided." };
      if (!/^[a-zA-Z0-9_-]+$/.test(envName)) return { ok: false, message: "Environment name may only contain letters, numbers, hyphens, and underscores." };
      const envPath = path.join(installation.installPath, ENVS_DIR, envName);
      if (fs.existsSync(envPath)) return { ok: false, message: `Environment "${envName}" already exists.` };
      sendProgress("setup", { percent: 0, status: "Creating virtual environment…" });
      await createEnv(installation.installPath, envName, (copied, total, elapsedSecs, etaSecs) => {
        const percent = Math.round((copied / total) * 100);
        const elapsed = formatTime(elapsedSecs);
        const eta = etaSecs >= 0 ? formatTime(etaSecs) : "—";
        sendProgress("setup", { percent, status: `Copying packages… ${copied} / ${total} files  ·  ${elapsed} elapsed  ·  ${eta} remaining` });
      });
      const envMethods = { ...installation.envMethods, [envName]: ENV_METHOD };
      await update({ envMethods });
      return { ok: true, navigate: "detail" };
    }
    if (actionId === "env-activate") {
      const envName = actionData?.env;
      if (!envName) return { ok: false, message: "No environment specified." };
      await update({ activeEnv: envName });
      return { ok: true, navigate: "detail" };
    }
    if (actionId === "env-delete") {
      const envName = actionData?.env;
      if (!envName) return { ok: false, message: "No environment specified." };
      if (envName === (installation.activeEnv || DEFAULT_ENV)) return { ok: false, message: "Cannot delete the active environment." };
      const envPath = path.join(installation.installPath, ENVS_DIR, envName);
      if (fs.existsSync(envPath)) {
        sendProgress("delete", { percent: 0, status: "Counting files…" });
        await deleteDir(envPath, (p) => {
          const elapsed = formatTime(p.elapsedSecs);
          const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : "—";
          sendProgress("delete", {
            percent: p.percent,
            status: `Deleting… ${p.deleted} / ${p.total} items  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
          });
        });
      }
      const envMethods = { ...installation.envMethods };
      delete envMethods[envName];
      await update({ envMethods });
      return { ok: true, navigate: "detail" };
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
          const files = m.files || [];
          const assets = files.map((f) => release.assets.find((a) => a.name === f)).filter(Boolean);
          if (assets.length === 0) return null;
          const totalBytes = assets.reduce((sum, a) => sum + a.size, 0);
          const sizeMB = (totalBytes / 1048576).toFixed(0);
          const downloadFiles = assets.map((a) => ({ url: a.browser_download_url, filename: a.name, size: a.size }));
          const downloadUrl = downloadFiles.length === 1 ? downloadFiles[0].url : "";
          return {
            value: downloadFiles.length > 0 ? m.id : "",
            label: `${getVariantLabel(m.id)}  —  ComfyUI ${m.comfyui_ref}  ·  Python ${m.python_version}  ·  ${sizeMB} MB`,
            data: { variantId: m.id, manifest: m, downloadFiles, downloadUrl },
            recommended: recommendVariant(m.id, gpu),
          };
        })
        .filter(Boolean);
    }

    return [];
  },
};
