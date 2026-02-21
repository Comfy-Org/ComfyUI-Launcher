const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { fetchJSON } = require("../lib/fetch");
const { deleteAction, untrackAction } = require("../lib/actions");
const { downloadAndExtract } = require("../lib/installer");
const { parseArgs } = require("../lib/util");
const { t } = require("../lib/i18n");
const { fetchLatestRelease, truncateNotes } = require("../lib/comfyui-releases");

function findPortableRoot(installPath) {
  // Content may be directly in installPath (tracked existing)
  // or in a subdirectory from .7z extraction (e.g. ComfyUI_windows_portable/)
  if (fs.existsSync(path.join(installPath, "python_embeded"))) return installPath;
  const entries = fs.readdirSync(installPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sub = path.join(installPath, entry.name);
      if (fs.existsSync(path.join(sub, "python_embeded"))) return sub;
    }
  }
  return null;
}

module.exports = {
  id: "portable",
  get label() { return t("portable.label"); },
  category: "local",

  get fields() {
    return [
      { id: "release", label: t("common.release"), type: "select" },
      { id: "asset", label: t("portable.package"), type: "select" },
    ];
  },

  defaultLaunchArgs: "--windows-standalone-build --disable-auto-launch",

  get installSteps() {
    return [
      { phase: "download", label: t("common.download") },
      { phase: "extract", label: t("common.extract") },
    ];
  },

  getDefaults() {
    return { launchArgs: this.defaultLaunchArgs, launchMode: "window", portConflict: "auto" };
  },

  getStatusTag(installation) {
    const track = installation.updateTrack || "stable";
    const info = installation.updateInfoByTrack && installation.updateInfoByTrack[track];
    if (info && info.available) {
      return { label: t("portable.updateAvailableTag", { version: info.releaseName || info.latestTag }), style: "update" };
    }
    return undefined;
  },

  buildInstallation(selections) {
    return {
      version: selections.release?.value || "unknown",
      asset: selections.asset?.data?.name || "",
      downloadUrl: selections.asset?.value || "",
      launchArgs: this.defaultLaunchArgs,
      launchMode: "window",
      browserPartition: "unique",
    };
  },

  getLaunchCommand(installation) {
    const root = findPortableRoot(installation.installPath);
    if (!root) return null;
    const userArgs = (installation.launchArgs ?? this.defaultLaunchArgs).trim();
    const parsed = userArgs.length > 0 ? parseArgs(userArgs) : [];
    const portIdx = parsed.indexOf("--port");
    const port = portIdx >= 0 && parsed[portIdx + 1] ? parseInt(parsed[portIdx + 1], 10) || 8188 : 8188;
    return {
      cmd: path.join(root, "python_embeded", "python.exe"),
      args: ["-s", path.join(root, "ComfyUI", "main.py"), ...parsed],
      cwd: root,
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
          { label: t("portable.version"), value: installation.version },
          { label: t("portable.packageLabel"), value: installation.asset || "—" },
          { label: t("common.location"), value: installation.installPath || "—" },
          { label: t("common.installed"), value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
    ];

    // Updates section
    const track = installation.updateTrack || "stable";
    const info = installation.updateInfoByTrack && installation.updateInfoByTrack[track];
    const updateFields = [
      { id: "updateTrack", label: t("portable.updateTrack"), value: track, editable: true,
        refreshSection: true, editType: "select", options: [
          { value: "stable", label: t("portable.trackStable") },
          { value: "latest", label: t("portable.trackLatest") },
        ] },
    ];
    if (info) {
      updateFields.push(
        { label: t("portable.installedVersion"), value: info.installedTag || installation.version },
        { label: t("portable.latestVersion"), value: info.releaseName || info.latestTag || "—" },
        { label: t("portable.lastChecked"), value: info.checkedAt ? new Date(info.checkedAt).toLocaleString() : "—" },
        { label: t("portable.updateStatus"), value: info.available ? t("portable.updateAvailable") : t("portable.upToDate") },
      );
    }
    const updateActions = [];
    if (info && info.available) {
      const msgKey = track === "latest" ? "portable.updateConfirmMessageLatest" : "portable.updateConfirmMessage";
      const notes = truncateNotes(info.releaseNotes, 2000);
      updateActions.push({
        id: "update-comfyui", label: t("portable.updateNow"), style: "primary", enabled: installed,
        showProgress: true, progressTitle: t("portable.updatingTitle", { version: info.latestTag }),
        confirm: {
          title: t("portable.updateConfirmTitle"),
          message: t(msgKey, {
            installed: info.installedTag || installation.version,
            latest: info.latestTag,
            commit: notes || "",
            notes: notes || "(none)",
          }),
        },
      });
    }
    updateActions.push({
      id: "check-update", label: t("actions.checkForUpdate"), style: "default", enabled: installed,
    });
    sections.push({
      title: t("portable.updates"),
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
          { id: "open-folder", label: t("actions.openDirectory"), style: "default", enabled: !!installation.installPath },
          deleteAction(installation),
          untrackAction(),
        ],
      },
    );

    return sections;
  },

  async install(installation, tools) {
    const cacheKey = `${installation.version}_${installation.asset}`;
    await downloadAndExtract(installation.downloadUrl, installation.installPath, cacheKey, tools);
  },

  probeInstallation(dirPath) {
    if (findPortableRoot(dirPath)) return { version: "unknown", asset: "", launchArgs: this.defaultLaunchArgs, launchMode: "window", browserPartition: "unique" };
    return null;
  },

  async handleAction(actionId, installation, actionData, { update, sendProgress, sendOutput }) {
    if (actionId === "check-update") {
      const track = installation.updateTrack || "stable";
      const release = await fetchLatestRelease(track);
      if (!release) {
        return { ok: false, message: "Could not fetch releases from GitHub." };
      }
      const installedTag = installation.version || "unknown";
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
            releaseUrl: release.html_url,
            publishedAt: release.published_at,
          },
        },
      });
      return { ok: true, navigate: "detail" };
    }

    if (actionId === "update-comfyui") {
      const root = findPortableRoot(installation.installPath);
      if (!root) {
        return { ok: false, message: t("portable.noUpdateDir") };
      }
      const updateDir = path.join(root, "update");
      const pythonExe = path.join(root, "python_embeded", "python.exe");
      const updateScript = path.join(updateDir, "update.py");
      const comfyuiDir = path.join(root, "ComfyUI") + path.sep;

      if (!fs.existsSync(updateScript)) {
        return { ok: false, message: t("portable.noUpdateDir") };
      }

      const track = installation.updateTrack || "stable";
      const stableArgs = track === "stable" ? ["--stable"] : [];

      sendProgress("steps", { steps: [
        { phase: "prepare", label: t("portable.updatePrepare") },
        { phase: "run", label: t("portable.updateRun") },
        { phase: "deps", label: t("portable.updateDeps") },
      ] });

      // Phase 1: Prepare — self-update check
      sendProgress("prepare", { percent: -1, status: "Checking for updater updates…" });

      // Phase 2: Run the update script
      sendProgress("run", { percent: -1, status: "Running update…" });

      const runUpdateScript = (extraArgs) => {
        return new Promise((resolve) => {
          const proc = spawn(pythonExe, ["-s", updateScript, comfyuiDir, ...extraArgs, ...stableArgs], {
            cwd: updateDir,
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
      };

      const exitCode = await runUpdateScript([]);

      if (exitCode !== 0) {
        const updateNewPy = path.join(updateDir, "update_new.py");
        if (!fs.existsSync(updateNewPy)) {
          return { ok: false, message: t("portable.updateFailed", { code: exitCode }) };
        }
      }

      // Handle updater self-update: if update_new.py was written, replace and re-run
      const updateNewPy = path.join(updateDir, "update_new.py");
      if (fs.existsSync(updateNewPy)) {
        try {
          fs.renameSync(updateNewPy, updateScript);
          sendOutput("\nUpdater script updated — re-running…\n\n");
        } catch (err) {
          sendOutput(`Warning: could not replace updater: ${err.message}\n`);
        }
        const exitCode2 = await runUpdateScript(["--skip_self_update"]);
        if (exitCode2 !== 0) {
          return { ok: false, message: t("portable.updateFailed", { code: exitCode2 }) };
        }
      }

      // Phase 3: Dependency sync (update.py handles this internally, but show the phase)
      sendProgress("deps", { percent: -1, status: "Dependencies checked." });

      // Update installation metadata
      const existing = installation.updateInfoByTrack || {};
      const trackInfo = existing[track] || {};
      const latestTag = trackInfo.latestTag || installation.version;
      await update({
        version: latestTag,
        updateInfoByTrack: {
          ...existing,
          [track]: {
            ...trackInfo,
            available: false,
            installedTag: latestTag,
            checkedAt: Date.now(),
          },
        },
      });

      sendProgress("done", { percent: 100, status: "Complete" });
      return { ok: true, navigate: "detail" };
    }

    return { ok: false, message: `Action "${actionId}" not yet implemented.` };
  },

  async getFieldOptions(fieldId, selections, context) {
    if (fieldId === "release") {
      const releases = await fetchJSON(
        "https://api.github.com/repos/Comfy-Org/ComfyUI/releases?per_page=30"
      );
      return releases.map((r) => ({
        value: r.tag_name,
        label: r.name && r.name !== r.tag_name ? `${r.tag_name}  —  ${r.name}` : r.tag_name,
        data: r,
      }));
    }

    if (fieldId === "asset") {
      const release = selections.release?.data;
      if (!release) return [];
      const gpu = context && context.gpu;
      return release.assets
        .filter((a) => a.name.endsWith(".7z"))
        .map((a) => ({
          value: a.browser_download_url,
          label: `${a.name}  (${(a.size / 1048576).toFixed(0)} MB)`,
          data: a,
          recommended: gpu ? a.name.toLowerCase().includes(gpu) : false,
        }));
    }

    return [];
  },
};
