const fs = require("fs");
const path = require("path");
const { fetchJSON } = require("../lib/fetch");
const { deleteAction, untrackAction } = require("../lib/actions");
const { downloadAndExtract, downloadAndExtractMulti } = require("../lib/installer");
const { deleteDir } = require("../lib/delete");
const { parseArgs, formatTime } = require("../lib/util");
const { t } = require("../lib/i18n");
const { scanCustomNodes } = require("../lib/nodes");
const { saveSnapshot, loadSnapshot, listSnapshots, deleteSnapshot, diffCustomNodes, diffSnapshots } = require("../lib/snapshots");
const { pipInstallFromList } = require("../lib/pip");

const RELEASE_REPO = "Kosinkadink/ComfyUI-Launcher-Environments";
const COMFYUI_REPO = "Comfy-Org/ComfyUI";
const ENVS_DIR = "envs";
const DEFAULT_ENV = "default";
const ENV_METHOD = "copy";
const MANIFEST_FILE = "manifest.json";
const PRESERVED_DIRS = ["custom_nodes", "models", "user", "output", "input"];

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

async function fetchLatestStandaloneRelease(track, currentVariant) {
  if (track === "latest") {
    // Track latest commits on ComfyUI main branch
    const [commit, releases] = await Promise.all([
      fetchJSON(`https://api.github.com/repos/${COMFYUI_REPO}/commits/master`),
      fetchJSON(`https://api.github.com/repos/${COMFYUI_REPO}/releases?per_page=10`).catch(() => []),
    ]);
    if (!commit) return null;
    const sha = commit.sha.slice(0, 7);
    const date = commit.commit?.committer?.date;
    const msg = commit.commit?.message?.split("\n")[0] || "";
    const stable = releases.find((r) => !r.draft && !r.prerelease);
    let label = sha;
    if (stable) {
      try {
        const cmp = await fetchJSON(`https://api.github.com/repos/${COMFYUI_REPO}/compare/${stable.tag_name}...master`);
        const ahead = cmp.ahead_by;
        label = ahead > 0
          ? `${stable.tag_name} + ${ahead} commit${ahead !== 1 ? "s" : ""} (${sha})`
          : stable.tag_name;
      } catch {
        label = `${stable.tag_name}+ (${sha})`;
      }
    }
    return { tag_name: sha, name: label, body: msg, published_at: date, _commit: true };
  }

  // Stable: fetch from environments repo, find a release matching the current variant
  const [releases, latest] = await Promise.all([
    fetchJSON(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`),
    fetchJSON(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`).catch(() => null),
  ]);
  if (latest && !releases.some((r) => r.id === latest.id)) {
    releases.unshift(latest);
  }
  const valid = releases.filter((r) => r.assets.some((a) => a.name === "manifests.json"));
  if (valid.length === 0) return null;
  const release = valid[0];
  // Fetch manifests to check variant availability and get comfyui_ref
  let comfyuiRef = null;
  if (currentVariant) {
    try {
      const manifestAsset = release.assets.find((a) => a.name === "manifests.json");
      if (manifestAsset) {
        const manifests = await fetchJSON(manifestAsset.browser_download_url);
        const match = manifests.find((m) => m.id === currentVariant);
        if (match) comfyuiRef = match.comfyui_ref;
      }
    } catch {}
  }
  return {
    tag_name: release.tag_name,
    name: release.name || release.tag_name,
    body: release.body || "",
    published_at: release.published_at,
    comfyui_ref: comfyuiRef,
    _release: release,
  };
}

function truncateNotes(text, maxLen) {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n\n… (truncated)";
}

/**
 * Build a list of pip package specs from snapshot data for restore.
 * Skips nonstandard entries (editable installs, URL-based) and logs warnings.
 */
function buildRestorePackageList(pipPackages, sendOutput) {
  const packages = [];
  for (const [name, version] of Object.entries(pipPackages)) {
    // Skip URL-based or editable installs — can't reliably reinstall
    if (version.includes("://") || version.startsWith("/") || version.startsWith(".")) {
      if (sendOutput) sendOutput(`⚠ Skipped nonstandard package: ${name} @ ${version}\n`);
      continue;
    }
    packages.push(`${name}==${version}`);
  }
  return packages;
}

/**
 * Send a summary of a restore operation via sendOutput.
 */
function sendRestoreSummary(sendOutput, snapshot, nodeDiff, packageCount) {
  if (!sendOutput) return;
  const lines = [`\n── Restore Summary ──\n`];
  lines.push(`Snapshot: ${snapshot.label} (${snapshot.createdAt})`);
  lines.push(`Packages restored: ${packageCount}`);
  if (nodeDiff.added.length > 0) {
    lines.push(`\nCustom nodes added since snapshot (${nodeDiff.added.length}):`);
    for (const n of nodeDiff.added) lines.push(`  + ${n.id}`);
  }
  if (nodeDiff.removed.length > 0) {
    lines.push(`\nCustom nodes removed since snapshot (${nodeDiff.removed.length}):`);
    for (const n of nodeDiff.removed) lines.push(`  - ${n.id}`);
  }
  if (nodeDiff.changed.length > 0) {
    lines.push(`\nCustom nodes changed since snapshot (${nodeDiff.changed.length}):`);
    for (const c of nodeDiff.changed) {
      const details = c.changes.map((ch) => `${ch.field}: ${ch.from} → ${ch.to}`).join(", ");
      lines.push(`  ~ ${c.id} (${details})`);
    }
  }
  if (nodeDiff.added.length === 0 && nodeDiff.removed.length === 0 && nodeDiff.changed.length === 0) {
    lines.push(`\nCustom nodes: no changes since snapshot.`);
  }
  lines.push(``);
  sendOutput(lines.join("\n"));
}

/**
 * Perform a soft restore: install snapshot pip packages into an existing env,
 * then compare custom nodes and send a summary.
 */
async function performSoftRestore(installPath, envName, snapshot, { sendProgress, sendOutput }) {
  sendProgress("pip", { percent: -1, status: t("standalone.restoreInstallingPackages") });
  const packages = buildRestorePackageList(snapshot.pipPackages, sendOutput);
  if (packages.length > 0) {
    const uvPath = getUvPath(installPath);
    const pythonPath = getEnvPythonPath(installPath, envName);
    try {
      await pipInstallFromList(uvPath, pythonPath, packages);
    } catch (err) {
      if (sendOutput) sendOutput(`\n⚠ Package installation failed: ${err.message}\n`);
      if (sendOutput) sendOutput(`The environment may be in a partially updated state. Consider using "Clean restore" to create a fresh environment.\n`);
      throw err;
    }
  }

  sendProgress("nodes", { percent: -1, status: t("standalone.restoreComparingNodes") });
  const currentNodes = await scanCustomNodes(installPath).catch(() => []);
  const nodeDiff = diffCustomNodes(snapshot.customNodes || [], currentNodes);
  sendRestoreSummary(sendOutput, snapshot, nodeDiff, packages.length);
}

/**
 * Move preserved directories back into a target ComfyUI directory.
 * Returns an array of directories that failed to restore.
 */
async function restorePreservedDirs(preservedTmp, targetDir) {
  const failed = [];
  for (const dir of PRESERVED_DIRS) {
    const src = path.join(preservedTmp, dir);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(targetDir, dir);
    try {
      await fs.promises.rm(dest, { recursive: true, force: true }).catch(() => {});
      await fs.promises.rename(src, dest);
    } catch (err) {
      failed.push({ dir, src, error: err.message });
    }
  }
  return failed;
}

/**
 * Format a snapshot diff for display via sendOutput.
 */
function formatSnapshotDiff(snapshotA, snapshotB, diff) {
  const lines = [`\n── Snapshot Comparison ──\n`];
  lines.push(`A: ${snapshotA.label} (${snapshotA.createdAt})`);
  lines.push(`B: ${snapshotB.label} (${snapshotB.createdAt})\n`);

  // Pip differences
  const { pip, nodes } = diff;
  if (pip.added.length === 0 && pip.removed.length === 0 && pip.changed.length === 0) {
    lines.push(`Packages: identical`);
  } else {
    lines.push(`Package differences:`);
    for (const p of pip.added) lines.push(`  + ${p.name}==${p.version}`);
    for (const p of pip.removed) lines.push(`  - ${p.name}==${p.version}`);
    for (const p of pip.changed) lines.push(`  ~ ${p.name}: ${p.from} → ${p.to}`);
  }

  // Node differences
  if (nodes.added.length === 0 && nodes.removed.length === 0 && nodes.changed.length === 0) {
    lines.push(`\nCustom nodes: identical`);
  } else {
    lines.push(`\nCustom node differences:`);
    for (const n of nodes.added) lines.push(`  + ${n.id}`);
    for (const n of nodes.removed) lines.push(`  - ${n.id}`);
    for (const c of nodes.changed) {
      const details = c.changes.map((ch) => `${ch.field}: ${ch.from} → ${ch.to}`).join(", ");
      lines.push(`  ~ ${c.id} (${details})`);
    }
  }

  lines.push(``);
  return lines.join("\n");
}

const standaloneSource = {
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

  getStatusTag(installation) {
    const track = installation.updateTrack || "stable";
    const info = installation.updateInfoByTrack && installation.updateInfoByTrack[track];
    if (info && info.available) {
      return { label: t("standalone.updateAvailableTag", { version: info.releaseName || info.latestTag }), style: "update" };
    }
    return undefined;
  },

  async getDetailSections(installation) {
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

    // Scan custom nodes and snapshots (only when installed)
    let nodes = [];
    let snapshots = [];
    if (installed && installation.installPath) {
      [nodes, snapshots] = await Promise.all([
        scanCustomNodes(installation.installPath).catch((err) => { console.error("Failed to scan custom nodes:", err.message); return []; }),
        listSnapshots(installation.installPath).catch((err) => { console.error("Failed to list snapshots:", err.message); return []; }),
      ]);
    }

    const nodeTypeLabels = { cnr: "CNR", git: "Git", file: t("standalone.nodeTypeFile"), unknown: t("standalone.nodeTypeUnknown") };
    const nodeItems = nodes.map((node) => ({
      label: node.id,
      badges: [
        { text: nodeTypeLabels[node.type] || node.type, style: node.type === "cnr" ? "info" : "default" },
        { text: node.version || (node.commit ? node.commit.slice(0, 7) : "—") },
        ...(!node.enabled ? [{ text: t("standalone.nodeDisabled"), style: "muted" }] : []),
      ],
    }));

    const snapshotItems = snapshots.map((s, idx) => ({
      label: `${s.label}  ·  ${new Date(s.createdAt).toLocaleString()}`,
      sublabel: t("standalone.snapshotSublabel", { nodes: s.nodeCount, packages: s.packageCount }),
      actions: [
        { id: "snapshot-restore", label: t("standalone.restoreSnapshot"), style: "default",
          enabled: installed && hasEnvs, data: { file: s.filename },
          showProgress: true, progressTitle: t("standalone.restoringSnapshot"),
          confirm: {
            title: t("standalone.restoreSnapshotTitle"),
            message: t("standalone.restoreSnapshotMessage"),
            fields: [
              { id: "mode", label: t("standalone.restoreMode"), editType: "select", value: "soft", options: [
                { value: "soft", label: t("standalone.restoreModeSoft") },
                { value: "clean", label: t("standalone.restoreModeClean") },
              ] },
            ],
          } },
        ...(snapshots.length > 1 ? [{
          id: "snapshot-diff", label: t("standalone.compareSnapshot"), style: "default",
          data: { fileA: s.filename },
          confirm: {
            title: t("standalone.compareSnapshotTitle"),
            message: t("standalone.compareSnapshotMessage"),
            fields: [
              { id: "fileB", label: t("standalone.compareWith"), editType: "select",
                value: snapshots[idx === 0 ? 1 : 0].filename,
                options: snapshots.filter((o) => o.filename !== s.filename).map((o) => ({
                  value: o.filename,
                  label: `${o.label}  ·  ${new Date(o.createdAt).toLocaleString()}`,
                })),
              },
            ],
          },
        }] : []),
        { id: "snapshot-delete", label: t("common.delete"), style: "danger",
          data: { file: s.filename },
          confirm: { title: t("standalone.deleteSnapshotConfirmTitle"), message: t("standalone.deleteSnapshotConfirmMessage") } },
      ],
    }));

    return [
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
        title: t("standalone.customNodes"),
        description: nodes.length > 0
          ? t("standalone.customNodesDesc", { count: nodes.length })
          : t("standalone.customNodesNone"),
        items: nodeItems,
      },
      {
        title: t("standalone.snapshots"),
        description: snapshots.length > 0
          ? t("standalone.snapshotsDesc")
          : t("standalone.snapshotsNone"),
        items: snapshotItems,
        actions: [
          { id: "snapshot-save", label: t("standalone.saveSnapshot"), style: "default", enabled: installed && hasEnvs,
            showProgress: true, progressTitle: t("standalone.savingSnapshot"),
            prompt: { title: t("standalone.saveSnapshotTitle"), message: t("standalone.saveSnapshotMessage"), placeholder: t("standalone.saveSnapshotPlaceholder"), field: "label", confirmLabel: t("standalone.saveSnapshotCreate"), required: t("standalone.saveSnapshotRequired") } },
        ],
      },
      // Updates section
      (() => {
        const track = installation.updateTrack || "stable";
        const info = installation.updateInfoByTrack && installation.updateInfoByTrack[track];
        const updateFields = [
          { id: "updateTrack", label: t("standalone.updateTrack"), value: track, editable: true,
            refreshSection: true, editType: "select", options: [
              { value: "stable", label: t("standalone.trackStable") },
              { value: "latest", label: t("standalone.trackLatest") },
            ] },
        ];
        if (info) {
          updateFields.push(
            { label: t("standalone.installedVersion"), value: info.installedTag || installation.releaseTag || installation.version },
            { label: t("standalone.latestVersion"), value: info.releaseName || info.latestTag || "—" },
            { label: t("standalone.lastChecked"), value: info.checkedAt ? new Date(info.checkedAt).toLocaleString() : "—" },
            { label: t("standalone.updateStatus"), value: info.available ? t("standalone.updateAvailable") : t("standalone.upToDate") },
          );
        }
        const updateActions = [];
        if (info && info.available && track === "stable") {
          updateActions.push({
            id: "update-standalone", label: t("standalone.updateNow"), style: "primary", enabled: installed,
            showProgress: true, progressTitle: t("standalone.updatingTitle", { version: info.latestTag }),
            confirm: {
              title: t("standalone.updateConfirmTitle"),
              message: t("standalone.updateConfirmMessage", {
                installed: info.installedTag || installation.releaseTag || installation.version,
                latest: info.releaseName || info.latestTag,
              }),
            },
          });
        }
        updateActions.push(
          { id: "check-update", label: t("actions.checkForUpdate"), style: "default", enabled: installed,
            showProgress: true, progressTitle: t("standalone.checkingForUpdate") },
        );
        // "Undo last update" — enabled when an auto-snapshot exists for the active env
        const undoSnapshot = installation.envSnapshots && installation.envSnapshots[activeEnv];
        if (undoSnapshot) {
          updateActions.push({
            id: "undo-last-update", label: t("standalone.undoLastUpdate"), style: "default", enabled: installed,
            showProgress: true, progressTitle: t("standalone.restoringSnapshot"),
            confirm: {
              title: t("standalone.undoLastUpdateTitle"),
              message: t("standalone.undoLastUpdateMessage", { snapshot: undoSnapshot }),
              fields: [
                { id: "mode", label: t("standalone.restoreMode"), editType: "select", value: "soft", options: [
                  { value: "soft", label: t("standalone.restoreModeSoft") },
                  { value: "clean", label: t("standalone.restoreModeClean") },
                ] },
              ],
            },
          });
        }
        return { title: t("standalone.updates"), fields: updateFields, actions: updateActions };
      })(),
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
          { id: "open-folder", label: t("actions.openDirectory"), style: "default", enabled: !!installation.installPath },
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

  async handleAction(actionId, installation, actionData, { update, sendProgress, download, cache, extract }) {
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
    if (actionId === "check-update") {
      const track = installation.updateTrack || "stable";
      sendProgress("check", { percent: -1, status: t("standalone.checkingForUpdate") });
      const release = await fetchLatestStandaloneRelease(track, installation.variant);
      if (!release) {
        return { ok: false, message: "Could not fetch releases." };
      }
      const installedTag = installation.releaseTag || installation.version || "unknown";
      const latestTag = release.tag_name;
      const available = installedTag !== latestTag;
      const existing = installation.updateInfoByTrack || {};
      await update({
        updateInfoByTrack: {
          ...existing,
          [track]: {
            checkedAt: Date.now(),
            installedTag,
            latestTag,
            available,
            releaseName: release.name || latestTag,
            releaseNotes: truncateNotes(release.body, 4000),
            publishedAt: release.published_at,
            comfyuiRef: release.comfyui_ref || null,
            ...(release._release ? { releaseData: { tag_name: release._release.tag_name } } : {}),
          },
        },
      });
      return { ok: true, navigate: "detail" };
    }
    if (actionId === "update-standalone") {
      const track = installation.updateTrack || "stable";
      if (track !== "stable") {
        return { ok: false, message: "Only stable track updates are supported for now." };
      }
      const existing = installation.updateInfoByTrack || {};
      const trackInfo = existing[track] || {};
      if (!trackInfo.available) {
        return { ok: false, message: "No update available." };
      }

      sendProgress("steps", { steps: [
        { phase: "snapshot", label: t("standalone.snapshots") },
        { phase: "download", label: t("standalone.updateDownload") },
        { phase: "extract", label: t("standalone.updateExtract") },
        { phase: "apply", label: t("standalone.updateApply") },
        { phase: "setup", label: t("standalone.updateEnv") },
      ] });

      // Step 1: Auto-snapshot before update
      const envName = resolveActiveEnv(installation) || DEFAULT_ENV;
      sendProgress("snapshot", { percent: -1, status: t("standalone.snapshotSaving") });
      let snapshotOk = false;
      try {
        const snapshotFile = await saveSnapshot(installation.installPath, envName, "auto-pre-update", { getUvPath, getEnvPythonPath });
        await update({ envSnapshots: { ...installation.envSnapshots, [envName]: snapshotFile } });
        snapshotOk = true;
      } catch (err) {
        console.error("Pre-update snapshot failed:", err.message);
      }
      if (!snapshotOk) {
        await update({
          updateInfoByTrack: {
            ...existing,
            [track]: { ...trackInfo, snapshotFailed: true },
          },
        });
      }

      // Step 2: Fetch the specific release recorded at check-update time
      sendProgress("download", { percent: 0, status: t("standalone.updateFetchingRelease") });
      const targetTag = trackInfo.releaseData?.tag_name || trackInfo.latestTag;
      let ghRelease;
      if (targetTag) {
        try {
          ghRelease = await fetchJSON(`https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${targetTag}`);
        } catch {
          ghRelease = null;
        }
      }
      if (!ghRelease) {
        // Fall back to fetching latest if the specific tag fetch fails
        const release = await fetchLatestStandaloneRelease("stable", installation.variant);
        ghRelease = release?._release;
      }
      if (!ghRelease) {
        return { ok: false, message: "Could not fetch release data for update." };
      }
      const manifestAsset = ghRelease.assets.find((a) => a.name === "manifests.json");
      if (!manifestAsset) {
        return { ok: false, message: "Release has no manifests.json." };
      }
      const manifests = await fetchJSON(manifestAsset.browser_download_url);
      const variantManifest = manifests.find((m) => m.id === installation.variant);
      if (!variantManifest) {
        return { ok: false, message: `Variant "${installation.variant}" not found in this release.` };
      }
      const files = (variantManifest.files || [])
        .map((f) => ghRelease.assets.find((a) => a.name === f))
        .filter(Boolean)
        .map((a) => ({ url: a.browser_download_url, filename: a.name, size: a.size }));
      if (files.length === 0) {
        return { ok: false, message: "No download files found for this variant." };
      }

      // Step 3: Download and extract to a temp directory
      const tmpDir = path.join(installation.installPath, ".launcher", "update-tmp");
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.promises.mkdir(tmpDir, { recursive: true });
      try {
        const updateCacheDir = `${ghRelease.tag_name}_${installation.variant}`;
        await downloadAndExtractMulti(files, tmpDir, updateCacheDir, {
          sendProgress, download, cache, extract,
        });

        // Step 4: Apply — replace standalone-env/ and ComfyUI/ while preserving user data
        sendProgress("apply", { percent: 0, status: t("standalone.updateApplying") });
        const installPath = installation.installPath;

        // Replace standalone-env/ using backup-and-swap for rollback safety
        const oldStandaloneEnv = path.join(installPath, "standalone-env");
        const bakStandaloneEnv = path.join(installPath, "standalone-env.bak");
        const newStandaloneEnv = path.join(tmpDir, "standalone-env");
        if (fs.existsSync(newStandaloneEnv)) {
          await fs.promises.rm(bakStandaloneEnv, { recursive: true, force: true }).catch(() => {});
          await fs.promises.rename(oldStandaloneEnv, bakStandaloneEnv);
          try {
            await fs.promises.rename(newStandaloneEnv, oldStandaloneEnv);
          } catch (swapErr) {
            // Restore backup if swap fails (e.g. file locks on Windows)
            await fs.promises.rename(bakStandaloneEnv, oldStandaloneEnv).catch(() => {});
            throw new Error(`Failed to apply standalone-env update: ${swapErr.message}`);
          }
          await fs.promises.rm(bakStandaloneEnv, { recursive: true, force: true }).catch(() => {});
        }
        sendProgress("apply", { percent: 30, status: t("standalone.updateApplyingCode") });

        // Replace ComfyUI/ — preserve user directories, using backup-and-swap
        const oldComfyUI = path.join(installPath, "ComfyUI");
        const bakComfyUI = path.join(installPath, "ComfyUI.bak");
        const newComfyUI = path.join(tmpDir, "ComfyUI");
        if (fs.existsSync(newComfyUI)) {
          // Move preserved dirs out temporarily
          const preservedTmp = path.join(installPath, ".launcher", "preserved-tmp");
          await fs.promises.mkdir(preservedTmp, { recursive: true });
          for (const dir of PRESERVED_DIRS) {
            const src = path.join(oldComfyUI, dir);
            if (fs.existsSync(src)) {
              await fs.promises.rename(src, path.join(preservedTmp, dir));
            }
          }
          // Backup-and-swap ComfyUI/
          await fs.promises.rm(bakComfyUI, { recursive: true, force: true }).catch(() => {});
          await fs.promises.rename(oldComfyUI, bakComfyUI);
          try {
            await fs.promises.rename(newComfyUI, oldComfyUI);
          } catch (swapErr) {
            // Restore backup
            await fs.promises.rename(bakComfyUI, oldComfyUI).catch(() => {});
            // Restore preserved dirs back into the restored ComfyUI/
            const rollbackFailed = await restorePreservedDirs(preservedTmp, oldComfyUI);
            if (rollbackFailed.length > 0) {
              const dirs = rollbackFailed.map((f) => f.dir).join(", ");
              throw new Error(`Failed to apply ComfyUI update: ${swapErr.message}\n\nAdditionally, some user data could not be restored automatically: ${dirs}\nYour data is preserved in: ${preservedTmp}\nPlease move these directories back into ComfyUI/ manually.`);
            }
            await fs.promises.rm(preservedTmp, { recursive: true, force: true }).catch(() => {});
            throw new Error(`Failed to apply ComfyUI update: ${swapErr.message}`);
          }
          // Restore preserved dirs into the new ComfyUI/
          const restoreFailed = await restorePreservedDirs(preservedTmp, oldComfyUI);
          if (restoreFailed.length > 0) {
            const dirs = restoreFailed.map((f) => f.dir).join(", ");
            // Don't delete preservedTmp — user data is still in there
            throw new Error(`Update applied but some user data could not be moved: ${dirs}\nYour data is preserved in: ${preservedTmp}\nPlease move these directories into ComfyUI/ manually.`);
          }
          await fs.promises.rm(preservedTmp, { recursive: true, force: true }).catch(() => {});
          await fs.promises.rm(bakComfyUI, { recursive: true, force: true }).catch(() => {});
        }
        sendProgress("apply", { percent: 60, status: t("standalone.updateApplyingManifest") });

        // Update manifest.json
        const newManifest = path.join(tmpDir, MANIFEST_FILE);
        if (fs.existsSync(newManifest)) {
          await fs.promises.copyFile(newManifest, path.join(installPath, MANIFEST_FILE));
        }
        sendProgress("apply", { percent: 100 });

        // Step 5: Recreate the active env from new master
        sendProgress("setup", { percent: 0, status: t("standalone.updateRecreatingEnv") });
        const envPath = path.join(installPath, ENVS_DIR, envName);
        await fs.promises.rm(envPath, { recursive: true, force: true }).catch(() => {});
        let envCreateFailed = false;
        try {
          await createEnv(installPath, envName, (copied, total, elapsedSecs, etaSecs) => {
            const percent = Math.round((copied / total) * 100);
            const elapsed = formatTime(elapsedSecs);
            const eta = etaSecs >= 0 ? formatTime(etaSecs) : "—";
            sendProgress("setup", { percent, status: `${t("standalone.updateCopyingPackages")} ${copied} / ${total}  ·  ${elapsed} elapsed  ·  ${eta} remaining` });
          });
        } catch (envErr) {
          envCreateFailed = true;
          console.error("Env recreation failed, attempting recovery:", envErr.message);
          // Code and standalone-env are updated successfully, but the venv is broken.
          // Try creating a minimal env so the install is at least launchable.
          sendProgress("setup", { percent: -1, status: t("standalone.updateEnvRetry") });
          try {
            await fs.promises.rm(envPath, { recursive: true, force: true }).catch(() => {});
            await createEnv(installPath, envName);
          } catch (retryErr) {
            // Update metadata so the user sees the install was partially updated
            const newManifestData = JSON.parse(await fs.promises.readFile(path.join(installPath, MANIFEST_FILE), "utf-8").catch(() => "{}"));
            await update({
              version: newManifestData.comfyui_ref || trackInfo.latestTag,
              releaseTag: ghRelease.tag_name,
              pythonVersion: newManifestData.python_version || installation.pythonVersion,
              updateInfoByTrack: {
                ...existing,
                [track]: {
                  ...trackInfo,
                  available: false,
                  installedTag: ghRelease.tag_name,
                  checkedAt: Date.now(),
                  lastError: t("standalone.updateEnvFailed"),
                  lastErrorAt: Date.now(),
                },
              },
            }).catch(() => {});
            throw new Error(t("standalone.updateEnvFailed") + ` ${retryErr.message}`);
          }
        }

        // Update installation metadata
        const newManifestData = JSON.parse(await fs.promises.readFile(path.join(installPath, MANIFEST_FILE), "utf-8").catch(() => "{}"));
        await update({
          version: newManifestData.comfyui_ref || trackInfo.latestTag,
          releaseTag: ghRelease.tag_name,
          pythonVersion: newManifestData.python_version || installation.pythonVersion,
          updateInfoByTrack: {
            ...existing,
            [track]: {
              ...trackInfo,
              available: false,
              installedTag: ghRelease.tag_name,
              checkedAt: Date.now(),
              snapshotFailed: undefined,
              ...(envCreateFailed ? { lastError: t("standalone.updateEnvPartial"), lastErrorAt: Date.now() } : { lastError: undefined, lastErrorAt: undefined }),
            },
          },
        });
      } catch (err) {
        // Record failure state so UI reflects the partial update
        await update({
          updateInfoByTrack: {
            ...existing,
            [track]: {
              ...trackInfo,
              lastError: err.message,
              lastErrorAt: Date.now(),
            },
          },
        }).catch(() => {});
        throw err;
      } finally {
        // Clean up temp directory and any leftover backups
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }

      return { ok: true, navigate: "detail" };
    }
    if (actionId === "snapshot-save") {
      const label = actionData?.label;
      if (!label) return { ok: false, message: "No snapshot label provided." };
      const envName = resolveActiveEnv(installation) || DEFAULT_ENV;
      sendProgress("snapshot", { percent: -1, status: "Saving snapshot…" });
      await saveSnapshot(installation.installPath, envName, label, { getUvPath, getEnvPythonPath });
      return { ok: true, navigate: "detail" };
    }
    if (actionId === "snapshot-restore" || actionId === "undo-last-update") {
      const installPath = installation.installPath;
      const envName = resolveActiveEnv(installation) || DEFAULT_ENV;
      let mode, snapshotPath;

      if (actionId === "undo-last-update") {
        mode = actionData?.mode || "soft";
        const snapshotFile = installation.envSnapshots && installation.envSnapshots[envName];
        if (!snapshotFile) {
          return { ok: false, message: "No auto-snapshot found for the active environment." };
        }
        snapshotPath = path.join(installPath, ".launcher", "snapshots", path.basename(snapshotFile));
        try {
          await fs.promises.access(snapshotPath);
        } catch {
          return { ok: false, message: "Auto-snapshot file not found on disk." };
        }
      } else {
        const filename = actionData?.file;
        if (!filename) return { ok: false, message: "No snapshot file specified." };
        mode = actionData?.mode || "soft";
        snapshotPath = path.join(installPath, ".launcher", "snapshots", path.basename(filename));
      }

      const snapshot = await loadSnapshot(snapshotPath);
      if (!snapshot || !snapshot.pipPackages) {
        return { ok: false, message: "Invalid or corrupt snapshot file." };
      }

      if (mode === "clean") {
        // Clean restore: create new env from master, then apply snapshot packages
        const baseName = path.basename(snapshotPath, ".json").slice(0, 30);
        const newEnvName = `restored-${baseName}`;

        sendProgress("steps", { steps: [
          { phase: "snapshot", label: t("standalone.snapshots") },
          { phase: "create-env", label: t("standalone.pythonEnvs") },
          { phase: "pip", label: t("standalone.restorePip") },
          { phase: "nodes", label: t("standalone.customNodes") },
        ] });

        // Auto-snapshot current state first
        sendProgress("snapshot", { percent: -1, status: t("standalone.snapshotSaving") });
        try {
          await saveSnapshot(installPath, envName, "auto-pre-restore", { getUvPath, getEnvPythonPath });
        } catch (err) {
          console.error("Pre-restore snapshot failed:", err.message);
        }

        // Create new env
        sendProgress("create-env", { percent: 0, status: t("standalone.updateRecreatingEnv") });
        const newEnvPath = path.join(installPath, ENVS_DIR, newEnvName);
        await fs.promises.rm(newEnvPath, { recursive: true, force: true }).catch(() => {});
        await createEnv(installPath, newEnvName, (copied, total, elapsedSecs, etaSecs) => {
          const percent = Math.round((copied / total) * 100);
          const elapsed = formatTime(elapsedSecs);
          const eta = etaSecs >= 0 ? formatTime(etaSecs) : "—";
          sendProgress("create-env", { percent, status: `${t("standalone.updateCopyingPackages")} ${copied} / ${total}  ·  ${elapsed} elapsed  ·  ${eta} remaining` });
        });

        // Install snapshot packages + compare nodes (reuses performSoftRestore)
        await performSoftRestore(installPath, newEnvName, snapshot, { sendProgress, sendOutput });

        // Activate the new env
        const envMethods = { ...(installation.envMethods || {}), [newEnvName]: ENV_METHOD };
        await update({ activeEnv: newEnvName, envMethods });

        return { ok: true, navigate: "detail" };
      }

      // Soft restore: install snapshot packages into current env
      sendProgress("steps", { steps: [
        { phase: "snapshot", label: t("standalone.snapshots") },
        { phase: "pip", label: t("standalone.restorePip") },
        { phase: "nodes", label: t("standalone.customNodes") },
      ] });

      // Auto-snapshot current state first
      sendProgress("snapshot", { percent: -1, status: t("standalone.snapshotSaving") });
      try {
        await saveSnapshot(installPath, envName, "auto-pre-restore", { getUvPath, getEnvPythonPath });
      } catch (err) {
        console.error("Pre-restore snapshot failed:", err.message);
      }

      await performSoftRestore(installPath, envName, snapshot, { sendProgress, sendOutput });

      return { ok: true, navigate: "detail" };
    }
    if (actionId === "snapshot-delete") {
      const filename = actionData?.file;
      if (!filename) return { ok: false, message: "No snapshot file specified." };
      await deleteSnapshot(installation.installPath, path.basename(filename));
      return { ok: true, navigate: "detail" };
    }
    if (actionId === "snapshot-diff") {
      const fileA = actionData?.fileA;
      const fileB = actionData?.fileB;
      if (!fileA || !fileB) return { ok: false, message: "Two snapshot files required for comparison." };
      const installPath = installation.installPath;
      const snapshotA = await loadSnapshot(path.join(installPath, ".launcher", "snapshots", path.basename(fileA)));
      const snapshotB = await loadSnapshot(path.join(installPath, ".launcher", "snapshots", path.basename(fileB)));

      const diff = diffSnapshots(snapshotA, snapshotB);
      sendOutput(formatSnapshotDiff(snapshotA, snapshotB, diff));
      return { ok: true };
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

module.exports = standaloneSource;
module.exports.getUvPath = getUvPath;
module.exports.getEnvPythonPath = getEnvPythonPath;
module.exports.getMasterPythonPath = getMasterPythonPath;
module.exports.findSitePackages = findSitePackages;
