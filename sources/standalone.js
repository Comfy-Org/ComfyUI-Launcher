const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { fetchJSON } = require("../lib/fetch");
const { truncateNotes } = require("../lib/comfyui-releases");
const releaseCache = require("../lib/release-cache");
const { deleteAction, untrackAction } = require("../lib/actions");
const { downloadAndExtract, downloadAndExtractMulti } = require("../lib/installer");
const { copyDirWithProgress } = require("../lib/copy");
const { deleteDir } = require("../lib/delete");
const { parseArgs, formatTime } = require("../lib/util");
const { t } = require("../lib/i18n");

const COMFYUI_REPO = "Comfy-Org/ComfyUI";
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
  category: "local",

  get fields() {
    return [
      { id: "release", label: t("common.release"), type: "select" },
      { id: "variant", label: t("standalone.variant"), type: "select" },
    ];
  },

  defaultLaunchArgs: "--enable-manager",

  get installSteps() {
    return [
      { phase: "download", label: t("common.download") },
      { phase: "extract", label: t("common.extract") },
      { phase: "setup", label: t("standalone.setupEnv") },
    ];
  },

  getDefaults() {
    return { launchArgs: this.defaultLaunchArgs, launchMode: "window", portConflict: "auto" };
  },

  getStatusTag(installation) {
    const track = installation.updateTrack || "stable";
    const info = releaseCache.getEffectiveInfo(COMFYUI_REPO, track, installation);
    if (info && releaseCache.isUpdateAvailable(installation, track, info)) {
      return { label: t("standalone.updateAvailableTag", { version: info.releaseName || info.latestTag }), style: "update" };
    }
    return undefined;
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
    const userArgs = (installation.launchArgs ?? this.defaultLaunchArgs).trim();
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
        ...(!installed && { disabledMessage: t("errors.installNotReady") }),
        showProgress: true, progressTitle: t("common.startingComfyUI"), cancellable: true },
    ];
  },

  getDetailSections(installation) {
    const installed = installation.status === "installed";

    const sections = [
      {
        title: t("common.installInfo"),
        fields: [
          { label: t("common.installMethod"), value: installation.sourceLabel },
          { label: t("standalone.comfyui"), value: installation.version },
          { label: t("common.release"), value: installation.releaseTag || "—" },
          { label: t("standalone.variant"), value: installation.variant ? getVariantLabel(installation.variant) : "—" },
          { label: t("standalone.python"), value: installation.pythonVersion || "—" },
          { label: t("common.location"), value: installation.installPath || "—" },
          { label: t("common.installed"), value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
    ];

    // Updates section
    const hasGit = installed && installation.installPath && fs.existsSync(path.join(installation.installPath, "ComfyUI", ".git"));
    const track = installation.updateTrack || "stable";
    const info = releaseCache.getEffectiveInfo(COMFYUI_REPO, track, installation);
    const updateFields = [
      { id: "updateTrack", label: t("standalone.updateTrack"), value: track, editable: true,
        refreshSection: true, onChangeAction: "check-update", editType: "select", options: [
          { value: "stable", label: t("standalone.trackStable") },
          { value: "latest", label: t("standalone.trackLatest") },
        ] },
    ];
    if (info) {
      const installedDisplay = installation.version || info.installedTag || "unknown";
      const latestDisplay = info.releaseName || info.latestTag || "—";
      const updateAvail = releaseCache.isUpdateAvailable(installation, track, info);
      updateFields.push(
        { label: t("standalone.installedVersion"), value: installedDisplay },
        { label: t("standalone.latestVersion"), value: latestDisplay },
        { label: t("standalone.lastChecked"), value: info.checkedAt ? new Date(info.checkedAt).toLocaleString() : "—" },
        { label: t("standalone.updateStatus"), value: updateAvail ? t("standalone.updateAvailable") : t("standalone.upToDate") },
      );
    }
    const updateActions = [];
    if (info && releaseCache.isUpdateAvailable(installation, track, info) && hasGit) {
      const installedDisplay = installation.version || info.installedTag || "unknown";
      const latestDisplay = info.releaseName || info.latestTag;
      // Detect downgrade: installed is ahead of target (e.g. "v0.14.2 + 5 commits" → "v0.14.2")
      const isDowngrade = track === "stable" && installedDisplay.includes(latestDisplay + " +");
      const msgKey = isDowngrade ? "standalone.updateConfirmMessageDowngrade"
        : track === "latest" ? "standalone.updateConfirmMessageLatest"
        : "standalone.updateConfirmMessage";
      const notes = truncateNotes(info.releaseNotes, 2000);
      updateActions.push({
        id: "update-comfyui", label: t("standalone.updateNow"), style: "primary", enabled: installed,
        showProgress: true, progressTitle: t("standalone.updatingTitle", { version: latestDisplay }),
        confirm: {
          title: t("standalone.updateConfirmTitle"),
          message: t(msgKey, {
            installed: installedDisplay,
            latest: latestDisplay,
            commit: notes || "",
            notes: notes || "(none)",
          }),
        },
      });
      updateActions.push({
        id: "copy-update", label: t("standalone.copyAndUpdate"), style: "default", enabled: installed,
        showProgress: true, progressTitle: t("standalone.copyUpdatingTitle", { version: latestDisplay }),
        cancellable: true,
        prompt: {
          title: t("standalone.copyAndUpdateTitle"),
          message: t("standalone.copyAndUpdateMessage", { installed: installedDisplay, latest: latestDisplay }),
          defaultValue: `${installation.name} (${latestDisplay})`,
          confirmLabel: t("standalone.copyAndUpdateConfirm"),
          required: true,
          field: "name",
        },
      });
    }
    updateActions.push({
      id: "check-update", label: t("actions.checkForUpdate"), style: "default", enabled: installed,
    });
    sections.push({
      title: t("standalone.updates"),
      fields: updateFields,
      actions: updateActions,
    });

    sections.push(
      {
        title: t("common.launchSettings"),
        fields: [
          { id: "useSharedPaths", label: t("common.useSharedPaths"), value: installation.useSharedPaths !== false, editable: true, editType: "boolean" },
          { id: "launchArgs", label: t("common.startupArgs"), value: installation.launchArgs ?? this.defaultLaunchArgs, editable: true },
          { id: "launchMode", label: t("common.launchMode"), value: installation.launchMode || "window", editable: true,
            editType: "select", options: [
              { value: "window", label: t("common.launchModeWindow") },
              { value: "console", label: t("common.launchModeConsole") },
            ] },
          { id: "browserPartition", label: t("common.browserPartition"), value: installation.browserPartition || "shared", editable: true,
            editType: "select", options: [
              { value: "shared", label: t("common.partitionShared") },
              { value: "unique", label: t("common.partitionUnique") },
            ] },
          { id: "portConflict", label: t("common.portConflict"), value: installation.portConflict || "ask", editable: true,
            editType: "select", options: [
              { value: "ask", label: t("common.portConflictAsk") },
              { value: "auto", label: t("common.portConflictAuto") },
            ] },
        ],
      },
      {
        title: "Actions",
        pinBottom: true,
        actions: [
          { id: "launch", label: t("actions.launch"), style: "primary", enabled: installed,
            ...(!installed && { disabledMessage: t("errors.installNotReady") }),
            showProgress: true, progressTitle: t("common.startingComfyUI"), cancellable: true },
          { id: "copy", label: t("actions.copyInstallation"), style: "default", enabled: installed,
            showProgress: true, progressTitle: t("actions.copyingInstallation"), cancellable: true,
            prompt: {
              title: t("actions.copyInstallationTitle"),
              message: t("actions.copyInstallationMessage"),
              defaultValue: `${installation.name} (Copy)`,
              confirmLabel: t("actions.copyInstallationConfirm"),
              required: true,
              field: "name",
            } },
          { id: "open-folder", label: t("actions.openDirectory"), style: "default", enabled: !!installation.installPath },
          deleteAction(installation),
          untrackAction(),
        ],
      },
      {
        title: t("common.advanced"),
        collapsed: true,
        actions: [
          { id: "release-update", label: t("standalone.releaseUpdate"), style: "default", enabled: installed,
            showProgress: true, progressTitle: t("standalone.releaseUpdatingTitle"), cancellable: true,
            fieldSelects: [
              { sourceId: "standalone", fieldId: "release", field: "releaseSelection",
                title: t("standalone.releaseUpdateSelectRelease"),
                message: t("standalone.releaseUpdateSelectReleaseMessage") },
              { sourceId: "standalone", fieldId: "variant", field: "variantSelection",
                title: t("standalone.releaseUpdateSelectVariant"),
                message: t("standalone.releaseUpdateSelectVariantMessage") },
            ],
            prompt: {
              title: t("standalone.releaseUpdateTitle"),
              message: t("standalone.releaseUpdateNameMessage"),
              defaultValue: `${installation.name} (Release Update)`,
              confirmLabel: t("standalone.releaseUpdateConfirm"),
              required: true,
              field: "name",
            } },
          { id: "migrate-from", label: t("migrate.migrateFrom"), style: "default", enabled: installed,
            showProgress: true, progressTitle: t("migrate.migrating"), cancellable: true,
            select: {
              title: t("migrate.selectSource"),
              message: t("migrate.selectSourceMessage"),
              emptyMessage: t("migrate.noInstallations"),
              source: "installations",
              field: "sourceInstallationId",
              excludeSelf: true,
              filters: { status: "installed", sourceCategory: "local" },
            },
            confirm: {
              title: t("migrate.confirmTitle"),
              message: t("migrate.confirmMessage"),
              confirmLabel: t("migrate.migrateConfirm"),
              options: [
                { id: "customNodes", label: t("migrate.optCustomNodes"), checked: true },
                { id: "workflows", label: t("migrate.optWorkflows"), checked: false },
                { id: "userSettings", label: t("migrate.optUserSettings"), checked: false },
                { id: "models", label: t("migrate.optModels"), checked: false },
                { id: "input", label: t("migrate.optInput"), checked: false },
                { id: "output", label: t("migrate.optOutput"), checked: false },
              ],
            } },
        ],
      },
    );

    return sections;
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

  async handleAction(actionId, installation, actionData, { update, sendProgress, sendOutput, signal }) {
    if (actionId === "check-update") {
      const track = installation.updateTrack || "stable";
      return releaseCache.checkForUpdate(COMFYUI_REPO, track, installation, update);
    }

    if (actionId === "update-comfyui") {
      const installPath = installation.installPath;
      const comfyuiDir = path.join(installPath, "ComfyUI");
      const gitDir = path.join(comfyuiDir, ".git");

      if (!fs.existsSync(gitDir)) {
        return { ok: false, message: t("standalone.updateNoGit") };
      }

      const masterPython = getMasterPythonPath(installPath);
      if (!fs.existsSync(masterPython)) {
        return { ok: false, message: "Master Python not found." };
      }

      const track = installation.updateTrack || "stable";
      const stableArgs = track === "stable" ? ["--stable"] : [];

      // Capture pre-update requirements for comparison
      const reqPath = path.join(comfyuiDir, "requirements.txt");
      let preReqs = "";
      try { preReqs = await fs.promises.readFile(reqPath, "utf-8"); } catch {}

      sendProgress("steps", { steps: [
        { phase: "prepare", label: t("standalone.updatePrepare") },
        { phase: "run", label: t("standalone.updateRun") },
        { phase: "deps", label: t("standalone.updateDeps") },
      ] });

      // Phase 1: Prepare
      sendProgress("prepare", { percent: -1, status: t("standalone.updatePrepare") });

      // Phase 2: Run launcher-owned update script with master Python (has pygit2)
      sendProgress("run", { percent: -1, status: t("standalone.updateRun") });

      const updateScript = path.join(__dirname, "..", "lib", "update_comfyui.py");
      const markers = {};
      let stdoutBuf = "";
      const exitCode = await new Promise((resolve) => {
        const proc = spawn(masterPython, ["-s", updateScript, comfyuiDir, ...stableArgs], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        if (signal) {
          const onAbort = () => proc.kill();
          signal.addEventListener("abort", onAbort, { once: true });
          proc.on("exit", () => signal.removeEventListener("abort", onAbort));
        }
        proc.stdout.on("data", (chunk) => {
          const text = chunk.toString("utf-8");
          stdoutBuf += text;
          const lines = stdoutBuf.split(/\r?\n/);
          stdoutBuf = lines.pop();
          for (const line of lines) {
            const match = line.match(/^\[(\w+)\]\s*(.+)$/);
            if (match) markers[match[1]] = match[2].trim();
          }
          sendOutput(text);
        });
        proc.stderr.on("data", (chunk) => sendOutput(chunk.toString("utf-8")));
        proc.on("error", (err) => {
          sendOutput(`Error: ${err.message}\n`);
          resolve(1);
        });
        proc.on("exit", (code) => resolve(code ?? 1));
      });
      if (stdoutBuf) {
        const match = stdoutBuf.match(/^\[(\w+)\]\s*(.+)$/);
        if (match) markers[match[1]] = match[2].trim();
      }

      if (exitCode !== 0) {
        return { ok: false, message: t("standalone.updateFailed", { code: exitCode }) };
      }

      // Phase 3: Requirements sync via uv against active env
      if (signal?.aborted) return { ok: false, message: "Cancelled" };
      sendProgress("deps", { percent: -1, status: t("standalone.updateDepsChecking") });

      let postReqs = "";
      try { postReqs = await fs.promises.readFile(reqPath, "utf-8"); } catch {}

      if (preReqs !== postReqs && postReqs.length > 0) {
        const uvPath = getUvPath(installPath);
        const activeEnvPython = getActivePythonPath(installation);

        if (fs.existsSync(uvPath) && activeEnvPython) {
          // Filter out PyTorch packages — they are tied to the Standalone release
          // and must never be modified by a commit-based update.
          const PYTORCH_RE = /^(torch|torchvision|torchaudio|torchsde)(\s*[<>=!~;\[#]|$)/i;
          const filteredReqs = postReqs.split("\n").filter((l) => !PYTORCH_RE.test(l.trim())).join("\n");
          const filteredReqPath = path.join(installPath, ".comfyui-reqs-filtered.txt");
          await fs.promises.writeFile(filteredReqPath, filteredReqs, "utf-8");

          try {
            // Dry-run to check for conflicts
            sendProgress("deps", { percent: -1, status: t("standalone.updateDepsDryRun") });
            if (signal?.aborted) return { ok: false, message: "Cancelled" };
            const dryRunResult = await new Promise((resolve) => {
              const proc = spawn(uvPath, ["pip", "install", "--dry-run", "-r", filteredReqPath, "--python", activeEnvPython], {
                cwd: installPath,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
              });
              if (signal) {
                const onAbort = () => proc.kill();
                signal.addEventListener("abort", onAbort, { once: true });
                proc.on("exit", () => signal.removeEventListener("abort", onAbort));
              }
              let stdout = "";
              let stderr = "";
              proc.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
              proc.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
              proc.on("error", (err) => resolve({ code: 1, stdout: "", stderr: err.message }));
              proc.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
            });

            if (dryRunResult.code !== 0) {
              sendOutput(`\n⚠ Requirements dry-run detected potential conflicts:\n${dryRunResult.stderr || dryRunResult.stdout}\n`);
              sendOutput("Proceeding with install attempt — some conflicts may be benign.\nTip: Use \"Copy & Update\" for a risk-free update that leaves this installation untouched.\n");
            } else if (dryRunResult.stderr) {
              sendOutput(dryRunResult.stderr);
            }

            // Install requirements
            if (signal?.aborted) return { ok: false, message: "Cancelled" };
            sendProgress("deps", { percent: -1, status: t("standalone.updateDepsInstalling") });
            const installResult = await new Promise((resolve) => {
              const proc = spawn(uvPath, ["pip", "install", "-r", filteredReqPath, "--python", activeEnvPython], {
                cwd: installPath,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
              });
              if (signal) {
                const onAbort = () => proc.kill();
                signal.addEventListener("abort", onAbort, { once: true });
                proc.on("exit", () => signal.removeEventListener("abort", onAbort));
              }
              proc.stdout.on("data", (chunk) => sendOutput(chunk.toString("utf-8")));
              proc.stderr.on("data", (chunk) => sendOutput(chunk.toString("utf-8")));
              proc.on("error", (err) => {
                sendOutput(`Error: ${err.message}\n`);
                resolve(1);
              });
              proc.on("exit", (code) => resolve(code ?? 1));
            });

            if (installResult !== 0) {
              sendOutput(`\nWarning: requirements install exited with code ${installResult}\n`);
            }
          } finally {
            try { await fs.promises.unlink(filteredReqPath); } catch {}
          }
        }
      } else {
        sendProgress("deps", { percent: -1, status: t("standalone.updateDepsUpToDate") });
      }

      // Update installation metadata
      const cachedRelease = releaseCache.get(COMFYUI_REPO, track) || {};
      // For stable: use the checked-out tag; for latest: use the post-update commit sha
      const postHead = markers.POST_UPDATE_HEAD ? markers.POST_UPDATE_HEAD.slice(0, 7) : null;
      const installedTag = markers.CHECKED_OUT_TAG || postHead || cachedRelease.latestTag || installation.version;
      // For display: use releaseName (e.g. "v0.14.2 + 5 commits (abc1234)") for latest
      const displayVersion = markers.CHECKED_OUT_TAG || cachedRelease.releaseName || installedTag;
      const rollback = {
        preUpdateHead: markers.PRE_UPDATE_HEAD || null,
        postUpdateHead: markers.POST_UPDATE_HEAD || null,
        backupBranch: markers.BACKUP_BRANCH || null,
        track,
        updatedAt: Date.now(),
      };
      const existing = installation.updateInfoByTrack || {};
      await update({
        version: displayVersion,
        lastRollback: rollback,
        updateInfoByTrack: {
          ...existing,
          [track]: { installedTag },
        },
      });

      sendProgress("done", { percent: 100, status: "Complete" });
      return { ok: true, navigate: "detail" };
    }

    if (actionId === "migrate-from") {
      const sourceId = actionData?.sourceInstallationId;
      if (!sourceId) return { ok: false, message: "No source installation specified." };

      const wantNodes = actionData?.customNodes === true;
      const wantAllUserData = actionData?.allUserData === true;
      const wantWorkflows = !wantAllUserData && actionData?.workflows === true;
      const wantSettings = !wantAllUserData && actionData?.userSettings === true;
      const wantModels = actionData?.models === true;
      const wantInput = actionData?.input === true;
      const wantOutput = actionData?.output === true;

      const installations = require("../installations");
      const srcInst = await installations.get(sourceId);
      if (!srcInst) return { ok: false, message: "Source installation not found." };

      const { listCustomNodes, findComfyUIDir, backupDir, mergeDirFlat } = require("../lib/migrate");

      const srcComfyUI = findComfyUIDir(srcInst.installPath);
      const dstComfyUI = path.join(installation.installPath, "ComfyUI");

      if (!srcComfyUI) {
        return { ok: false, message: t("migrate.noComfyUIDir") };
      }

      // Resolve shared vs local destinations for models/input/output
      const settings = require("../settings");
      const useShared = installation.useSharedPaths !== false;

      const srcModels = path.join(srcComfyUI, "models");
      const dstModels = useShared
        ? (settings.get("modelsDirs") || settings.defaults.modelsDirs)[0]
        : path.join(dstComfyUI, "models");
      const srcInput = path.join(srcComfyUI, "input");
      const dstInput = useShared
        ? (settings.get("inputDir") || settings.defaults.inputDir)
        : path.join(dstComfyUI, "input");
      const srcOutput = path.join(srcComfyUI, "output");
      const dstOutput = useShared
        ? (settings.get("outputDir") || settings.defaults.outputDir)
        : path.join(dstComfyUI, "output");

      const srcCustomNodes = path.join(srcComfyUI, "custom_nodes");
      const dstCustomNodes = path.join(dstComfyUI, "custom_nodes");
      const srcWorkflows = path.join(srcComfyUI, "user", "default", "workflows");
      const dstWorkflows = path.join(dstComfyUI, "user", "default", "workflows");
      const srcUserDir = path.join(srcComfyUI, "user");

      // Build step list based on selected categories
      const steps = [{ phase: "migrate", label: t("migrate.filePhase") }];
      if (wantNodes) steps.push({ phase: "deps", label: t("migrate.depsPhase") });
      sendProgress("steps", { steps });

      // Phase 1: File migration
      sendProgress("migrate", { percent: 0, status: t("migrate.scanning") });

      const srcNodes = wantNodes ? listCustomNodes(srcCustomNodes) : [];
      const hasAllUserData = wantAllUserData && fs.existsSync(srcUserDir);
      const hasWorkflows = wantWorkflows && fs.existsSync(srcWorkflows);
      const hasModels = wantModels && fs.existsSync(srcModels);
      const hasInput = wantInput && fs.existsSync(srcInput);
      const hasOutput = wantOutput && fs.existsSync(srcOutput);

      // Collect user profile settings files (e.g. user/default/comfy.settings.json)
      const settingsFiles = [];
      if (wantSettings && fs.existsSync(srcUserDir)) {
        try {
          for (const d of fs.readdirSync(srcUserDir, { withFileTypes: true })) {
            if (d.isDirectory() && !d.name.startsWith("_")) {
              const src = path.join(srcUserDir, d.name, "comfy.settings.json");
              if (fs.existsSync(src)) {
                settingsFiles.push({ profile: d.name, src, dst: path.join(dstComfyUI, "user", d.name, "comfy.settings.json") });
              }
            }
          }
        } catch {}
      }

      // Each category counts as one unit for overall progress
      const total = srcNodes.length + (hasAllUserData ? 1 : 0) + (hasWorkflows ? 1 : 0) + (settingsFiles.length > 0 ? 1 : 0) + (hasModels ? 1 : 0) + (hasInput ? 1 : 0) + (hasOutput ? 1 : 0);

      if (total === 0) {
        sendProgress("migrate", { percent: 100, status: t("migrate.nothingToMigrate") });
        if (wantNodes) sendProgress("deps", { percent: 100, status: t("migrate.noDeps") });
        sendProgress("done", { percent: 100, status: "Complete" });
        return { ok: true, navigate: "detail" };
      }

      let migrated = 0;
      const migratedNodes = [];
      const backedUp = [];
      const summary = [];

      // Custom nodes (additive with backup per-node)
      if (srcNodes.length > 0) {
        fs.mkdirSync(dstCustomNodes, { recursive: true });
        for (const node of srcNodes) {
          const dstNodeDir = path.join(dstCustomNodes, node.name);
          if (fs.existsSync(dstNodeDir)) {
            const bak = backupDir(dstNodeDir);
            if (bak) backedUp.push(node.name);
          }
          await copyDirWithProgress(node.dir, dstNodeDir, (copied, fileTotal) => {
            const sub = fileTotal > 0 ? copied / fileTotal : 1;
            const percent = Math.round(((migrated + sub) / total) * 100);
            sendProgress("migrate", { percent, status: t("migrate.copyingNode", { name: node.name, current: migrated + 1, total }) });
          });
          migratedNodes.push(node);
          migrated++;
        }
        summary.push(t("migrate.summaryNodes", { count: migratedNodes.length }));
        if (backedUp.length > 0) summary.push(t("migrate.summaryBackedUp", { count: backedUp.length }));
      }

      // Full user directory (flat merge — replaces individual workflows/settings)
      if (hasAllUserData) {
        sendProgress("migrate", { percent: Math.round((migrated / total) * 100), status: t("migrate.mergingUserData") });
        const dstUserDir = path.join(dstComfyUI, "user");
        const result = await mergeDirFlat(srcUserDir, dstUserDir, (copied, skipped, fileTotal) => {
          const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1;
          const percent = Math.round(((migrated + sub) / total) * 100);
          sendProgress("migrate", { percent, status: t("migrate.mergingUserData") });
        });
        migrated++;
        summary.push(t("migrate.summaryUserData", { copied: result.copied, skipped: result.skipped }));
      }

      // Workflows only (flat merge, skipped when full user data is selected)
      if (hasWorkflows) {
        sendProgress("migrate", { percent: Math.round((migrated / total) * 100), status: t("migrate.mergingWorkflows") });
        const result = await mergeDirFlat(srcWorkflows, dstWorkflows, (copied, skipped, fileTotal) => {
          const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1;
          const percent = Math.round(((migrated + sub) / total) * 100);
          sendProgress("migrate", { percent, status: t("migrate.mergingWorkflows") });
        });
        migrated++;
        summary.push(t("migrate.summaryWorkflows", { copied: result.copied, skipped: result.skipped }));
      }

      // User settings (copy comfy.settings.json per profile)
      if (settingsFiles.length > 0) {
        sendProgress("migrate", { percent: Math.round((migrated / total) * 100), status: t("migrate.copyingSettings") });
        let copied = 0;
        for (const sf of settingsFiles) {
          await fs.promises.mkdir(path.dirname(sf.dst), { recursive: true });
          await fs.promises.copyFile(sf.src, sf.dst);
          copied++;
        }
        migrated++;
        summary.push(t("migrate.summarySettings", { count: copied }));
      }

      // Models (flat merge — skip existing files)
      if (hasModels) {
        sendProgress("migrate", { percent: Math.round((migrated / total) * 100), status: t("migrate.mergingModels") });
        const result = await mergeDirFlat(srcModels, dstModels, (copied, skipped, fileTotal) => {
          const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1;
          const percent = Math.round(((migrated + sub) / total) * 100);
          sendProgress("migrate", { percent, status: t("migrate.mergingModels") });
        });
        migrated++;
        summary.push(t("migrate.summaryModels", { copied: result.copied, skipped: result.skipped }));
      }

      // Input (flat merge)
      if (hasInput) {
        sendProgress("migrate", { percent: Math.round((migrated / total) * 100), status: t("migrate.mergingInput") });
        const result = await mergeDirFlat(srcInput, dstInput, (copied, skipped, fileTotal) => {
          const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1;
          const percent = Math.round(((migrated + sub) / total) * 100);
          sendProgress("migrate", { percent, status: t("migrate.mergingInput") });
        });
        migrated++;
        summary.push(t("migrate.summaryInput", { copied: result.copied, skipped: result.skipped }));
      }

      // Output (flat merge)
      if (hasOutput) {
        sendProgress("migrate", { percent: Math.round((migrated / total) * 100), status: t("migrate.mergingOutput") });
        const result = await mergeDirFlat(srcOutput, dstOutput, (copied, skipped, fileTotal) => {
          const sub = fileTotal > 0 ? (copied + skipped) / fileTotal : 1;
          const percent = Math.round(((migrated + sub) / total) * 100);
          sendProgress("migrate", { percent, status: t("migrate.mergingOutput") });
        });
        migrated++;
        summary.push(t("migrate.summaryOutput", { copied: result.copied, skipped: result.skipped }));
      }

      sendProgress("migrate", { percent: 100, status: t("common.done") });

      // Phase 2: Dependency reconciliation (only if custom nodes were migrated)
      if (wantNodes) {
        sendProgress("deps", { percent: 0, status: t("migrate.checkingDeps") });

        const nodesWithReqs = migratedNodes.filter((n) => n.hasRequirements);
        if (nodesWithReqs.length === 0) {
          sendProgress("deps", { percent: 100, status: t("migrate.noDeps") });
        } else {
          const uvPath = getUvPath(installation.installPath);
          const activePython = getActivePythonPath(installation);

          if (!fs.existsSync(uvPath) || !activePython) {
            sendOutput(t("migrate.noUvOrPython") + "\n");
            sendProgress("deps", { percent: 100, status: t("migrate.depsSkipped") });
          } else {
            const PYTORCH_RE = /^(torch|torchvision|torchaudio|torchsde)(\s*[<>=!~;\[#]|$)/i;
            let installed = 0;

            for (const node of nodesWithReqs) {
              const reqPath = path.join(dstCustomNodes, node.name, "requirements.txt");
              sendProgress("deps", {
                percent: Math.round((installed / nodesWithReqs.length) * 100),
                status: t("migrate.installingNodeDeps", { name: node.name }),
              });

              try {
                const reqContent = await fs.promises.readFile(reqPath, "utf-8");
                const filtered = reqContent.split("\n").filter((l) => !PYTORCH_RE.test(l.trim())).join("\n");
                const filteredReqPath = path.join(installation.installPath, `.migrate-reqs-${node.name}.txt`);
                await fs.promises.writeFile(filteredReqPath, filtered, "utf-8");

                try {
                  const result = await new Promise((resolve) => {
                    const proc = spawn(uvPath, ["pip", "install", "-r", filteredReqPath, "--python", activePython], {
                      cwd: installation.installPath,
                      stdio: ["ignore", "pipe", "pipe"],
                      windowsHide: true,
                    });
                    proc.stdout.on("data", (chunk) => sendOutput(chunk.toString("utf-8")));
                    proc.stderr.on("data", (chunk) => sendOutput(chunk.toString("utf-8")));
                    proc.on("error", (err) => {
                      sendOutput(`Error: ${err.message}\n`);
                      resolve(1);
                    });
                    proc.on("exit", (code) => resolve(code ?? 1));
                  });

                  if (result !== 0) {
                    sendOutput(`\n⚠ ${node.name}: dependency install exited with code ${result}\n`);
                  }
                } finally {
                  try { await fs.promises.unlink(filteredReqPath); } catch {}
                }
              } catch (err) {
                sendOutput(`⚠ ${node.name}: ${err.message}\n`);
              }

              installed++;
            }

            sendProgress("deps", { percent: 100, status: t("migrate.depsComplete") });
            summary.push(t("migrate.summaryDeps", { count: nodesWithReqs.length }));
          }
        }
      }

      sendProgress("done", { percent: 100, status: "Complete" });
      sendOutput(`\n✓ ${t("migrate.complete")}: ${summary.join(", ")}\n`);

      return { ok: true, navigate: "detail" };
    }

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

  async fixupCopy(srcPath, destPath) {
    const envsDir = path.join(destPath, ENVS_DIR);
    if (!fs.existsSync(envsDir)) return;

    for (const envName of listEnvs(destPath)) {
      const envPath = path.join(envsDir, envName);

      // Rewrite absolute paths in pyvenv.cfg to point to the new location
      const cfgPath = path.join(envPath, "pyvenv.cfg");
      if (fs.existsSync(cfgPath)) {
        let content = await fs.promises.readFile(cfgPath, "utf-8");
        content = content.replaceAll(srcPath, destPath);
        await fs.promises.writeFile(cfgPath, content, "utf-8");
      }

      // Fix shebangs in bin/ scripts (Unix only)
      if (process.platform !== "win32") {
        const binDir = path.join(envPath, "bin");
        if (fs.existsSync(binDir)) {
          const entries = await fs.promises.readdir(binDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isFile()) continue;
            const filePath = path.join(binDir, entry.name);
            try {
              let content = await fs.promises.readFile(filePath, "utf-8");
              if (content.startsWith("#!") && content.includes(srcPath)) {
                content = content.replaceAll(srcPath, destPath);
                await fs.promises.writeFile(filePath, content, "utf-8");
              }
            } catch {}
          }
        }
      }
    }
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
