const path = require("path");
const fs = require("fs");
const { app, ipcMain, dialog, shell, BrowserWindow, nativeTheme } = require("electron");
const sources = require("../sources");
const installations = require("../installations");
const settings = require("../settings");
const { defaultInstallDir } = require("./paths");
const { download } = require("./download");
const { createCache } = require("./cache");
const { extractNested: extract } = require("./extract");
const { deleteDir } = require("./delete");
const os = require("os");
const { spawnProcess, waitForPort, waitForUrl, killProcessTree, killByPort, findPidsByPort, getProcessInfo, looksLikeComfyUI, setPortArg, findAvailablePort, writePortLock, readPortLock, removePortLock } = require("./process");
const { detectGPU } = require("./gpu");
const { formatTime } = require("./util");
const releaseCache = require("./release-cache");
const i18n = require("./i18n");
const { ensureModelPathsConfig } = require("./models");

const MARKER_FILE = ".comfyui-launcher";
const IGNORE_FILES = new Set([MARKER_FILE, ".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * Check if an install directory is effectively empty (only marker/OS metadata files).
 * Returns true if the directory doesn't exist or contains only ignorable files.
 */
function isEffectivelyEmptyInstallDir(dirPath) {
  if (!dirPath) return true;
  try {
    const entries = fs.readdirSync(dirPath);
    return entries.every((name) => IGNORE_FILES.has(name));
  } catch (e) {
    if (e && e.code === "ENOENT") return true;
    return false;
  }
}

// shell.openPath on Linux can open the wrong app (e.g. Disk Usage Analyzer instead of a file
// manager) when the default handler for inode/directory is misconfigured. Use the freedesktop
// FileManager1 D-Bus interface to open folders reliably, falling back to xdg-open.
function openPath(targetPath) {
  if (process.platform === "linux") {
    const { execFile } = require("child_process");
    return new Promise((resolve) => {
      execFile("dbus-send", [
        "--session", "--print-reply", "--type=method_call",
        "--dest=org.freedesktop.FileManager1",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1.ShowFolders",
        `array:string:file://${targetPath}`, "string:",
      ], (err) => {
        if (!err) return resolve("");
        const child = require("child_process").spawn("xdg-open", [targetPath], { stdio: "ignore", detached: true });
        child.unref();
        resolve("");
      });
    });
  }
  return shell.openPath(targetPath);
}

const sourceMap = Object.fromEntries(sources.map((s) => [s.id, s]));

function resolveSource(sourceId) {
  const source = sourceMap[sourceId];
  if (!source) throw new Error(`Unknown source: ${sourceId}`);
  return source;
}

async function resolveInstallation(id) {
  const inst = await installations.get(id);
  if (!inst) throw new Error(`Unknown installation: ${id}`);
  return inst;
}

async function findDuplicatePath(installPath) {
  const normalized = path.resolve(installPath);
  return (await installations.list()).find((i) => path.resolve(i.installPath) === normalized) || null;
}

/**
 * Copy an installation to a new directory, run fixups, register the copy,
 * and write the marker file.  On failure the partial copy is cleaned up.
 * Returns { entry, destPath } on success.
 */
async function performCopy(inst, name, sendProgress, signal) {
  const parentDir = path.dirname(inst.installPath);
  const dirName = name.replace(/[<>:"/\\|?*]+/g, "_").trim() || "ComfyUI";
  let destPath = path.join(parentDir, dirName);
  let suffix = 1;
  while (fs.existsSync(destPath)) {
    destPath = path.join(parentDir, `${dirName} (${suffix})`);
    suffix++;
  }

  const duplicate = await findDuplicatePath(destPath);
  if (duplicate) {
    throw new Error(`That directory is already used by "${duplicate.name}".`);
  }

  try {
    const { copyDirWithProgress } = require("./copy");

    sendProgress("copy", { percent: 0, status: i18n.t("actions.copyingFiles") });
    await copyDirWithProgress(inst.installPath, destPath, (copied, total, elapsedSecs, etaSecs) => {
      const percent = Math.round((copied / total) * 100);
      const elapsed = formatTime(elapsedSecs);
      const eta = etaSecs >= 0 ? formatTime(etaSecs) : "—";
      sendProgress("copy", {
        percent,
        status: `${i18n.t("actions.copyingFiles")}  ${copied} / ${total}  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
      });
    }, { signal });

    // Run source-specific fixups (e.g. rewrite pyvenv.cfg paths)
    const source = resolveSource(inst.sourceId);
    if (source.fixupCopy) {
      await source.fixupCopy(inst.installPath, destPath);
    }

    // Build the new installation record, inheriting source metadata
    const { id: _id, name: _name, installPath: _path, createdAt: _created, seen: _seen, status: _status, ...inherited } = inst;
    const entry = await installations.add({
      ...inherited,
      name,
      installPath: destPath,
      status: "installed",
      seen: false,
      browserPartition: "unique",
    });

    // Write marker file with the new installation's ID
    try { fs.writeFileSync(path.join(destPath, MARKER_FILE), entry.id); } catch {}

    return { entry, destPath };
  } catch (err) {
    // Clean up partial copy on failure
    try { await fs.promises.rm(destPath, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

function createSessionPath() {
  return path.join(os.tmpdir(), `comfyui-launcher-${Date.now()}`);
}

function checkRebootMarker(sessionPath) {
  const marker = sessionPath + ".reboot";
  if (fs.existsSync(marker)) {
    try { fs.unlinkSync(marker); } catch {}
    return true;
  }
  return false;
}

let _onLaunch = null;
let _onStop = null;
let _onComfyExited = null;
let _onComfyRestarted = null;
let _onLocaleChanged = null;
let _detectedGPU = undefined;

// Per-operation AbortController registry — tracks cancellable operations by installationId
const _operationAborts = new Map(); // installationId -> AbortController

// Session registry — tracks all running ComfyUI instances
const _runningSessions = new Map(); // installationId -> { proc, port, url, mode, installationName, startedAt }

function _broadcastToRenderer(channel, data) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, data);
  });
}

function _addSession(installationId, { proc, port, url, mode, installationName }) {
  _runningSessions.set(installationId, { proc, port, url, mode, installationName, startedAt: Date.now() });
  _broadcastToRenderer("instance-started", { installationId, port, url, mode, installationName });
}

function _removeSession(installationId) {
  const session = _runningSessions.get(installationId);
  if (!session) return;
  if (session.port) removePortLock(session.port);
  _runningSessions.delete(installationId);
  _broadcastToRenderer("instance-stopped", { installationId });
}

function _getPublicSessions() {
  return Array.from(_runningSessions.entries()).map(([id, s]) => ({
    installationId: id,
    port: s.port,
    url: s.url,
    mode: s.mode,
    installationName: s.installationName,
    startedAt: s.startedAt,
  }));
}

async function migrateDefaults() {
  const all = await installations.list();
  let changed = false;
  for (const inst of all) {
    const source = sourceMap[inst.sourceId];
    if (!source || !source.getDefaults) continue;
    const defaults = source.getDefaults();
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in inst)) {
        inst[key] = value;
        changed = true;
      }
    }
    // Migrate legacy updateInfo → updateInfoByTrack
    if (inst.updateInfo && !inst.updateInfoByTrack) {
      const track = inst.updateInfo.track || inst.updateTrack || "stable";
      const { track: _t, ...rest } = inst.updateInfo;
      inst.updateInfoByTrack = { [track]: rest };
      delete inst.updateInfo;
      changed = true;
    }
    // Migrate old updateInfoByTrack format: extract shared release info into
    // the release cache and slim down to per-install installedTag only.
    if (inst.updateInfoByTrack) {
      const repo = "Comfy-Org/ComfyUI";
      for (const [track, info] of Object.entries(inst.updateInfoByTrack)) {
        if (info.latestTag && !releaseCache.get(repo, track)) {
          const { installedTag, available, ...releaseFields } = info;
          releaseCache.set(repo, track, releaseFields);
        }
        if (info.latestTag || info.releaseName || info.releaseNotes) {
          inst.updateInfoByTrack[track] = { installedTag: info.installedTag };
          changed = true;
        }
      }
    }
  }
  if (changed) {
    for (const inst of all) await installations.update(inst.id, inst);
  }
}

function resolveTheme() {
  const theme = settings.get("theme") || "system";
  return theme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : theme;
}

function register({ onLaunch, onStop, onComfyExited, onComfyRestarted, onLocaleChanged } = {}) {
  _onLaunch = onLaunch;
  _onStop = onStop;
  _onComfyExited = onComfyExited;
  _onComfyRestarted = onComfyRestarted;
  _onLocaleChanged = onLocaleChanged;

  installations.seedDefaults([
    {
      name: "Comfy Cloud",
      sourceId: "cloud",
      version: "cloud",
      remoteUrl: "https://cloud.comfy.org/",
      launchMode: "window",
      browserPartition: "shared",
    },
  ]);
  migrateDefaults();

  // Sweep empty/broken local installations on startup
  void (async () => {
    try {
      const all = await installations.list();
      for (const inst of all) {
        const source = sourceMap[inst.sourceId];
        if (!source || source.skipInstall) continue;
        if (!inst.installPath) continue;
        if (!isEffectivelyEmptyInstallDir(inst.installPath)) continue;
        try { fs.rmSync(inst.installPath, { recursive: true, force: true }); } catch {}
        await installations.remove(inst.id);
      }
    } catch {}
  })();

  // Pre-warm the ETag cache for GitHub API URLs used by the New Installation menu.
  // This runs in the background so the data is already cached (or at least ETag'd)
  // by the time the user navigates there, reducing rate-limit pressure.
  void (async () => {
    try {
      const { fetchJSON } = require("./fetch");
      await Promise.allSettled([
        fetchJSON("https://api.github.com/repos/Kosinkadink/ComfyUI-Launcher-Environments/releases?per_page=30"),
        fetchJSON("https://api.github.com/repos/Kosinkadink/ComfyUI-Launcher-Environments/releases/latest"),
        fetchJSON("https://api.github.com/repos/Comfy-Org/ComfyUI/releases?per_page=30"),
      ]);
    } catch {}
  })();

  // Sources
  ipcMain.handle("get-sources", () =>
    sources.map((s) => ({ id: s.id, label: s.label, fields: s.fields, skipInstall: !!s.skipInstall, hideInstallPath: !!s.skipInstall }))
  );

  ipcMain.handle("get-field-options", async (_event, sourceId, fieldId, selections) => {
    const gpu = _detectedGPU === undefined ? null : _detectedGPU;
    const options = await resolveSource(sourceId).getFieldOptions(fieldId, selections, { gpu: gpu && gpu.id });
    return options;
  });

  ipcMain.handle("detect-gpu", async () => {
    if (_detectedGPU === undefined) _detectedGPU = await detectGPU();
    return _detectedGPU;
  });

  ipcMain.handle("build-installation", (_event, sourceId, selections) => {
    const source = resolveSource(sourceId);
    return {
      sourceId: source.id,
      sourceLabel: source.label,
      ...source.buildInstallation(selections),
    };
  });

  // Paths
  ipcMain.handle("get-default-install-dir", () => defaultInstallDir());

  ipcMain.handle("browse-folder", async (_event, defaultPath) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      defaultPath: defaultPath || defaultInstallDir(),
      properties: ["openDirectory", "createDirectory"],
    });
    if (canceled || filePaths.length === 0) return null;
    return filePaths[0];
  });

  ipcMain.handle("open-path", (_event, targetPath) => openPath(targetPath));
  ipcMain.handle("open-external", (_event, url) => shell.openExternal(url));

  // Installations
  ipcMain.handle("get-installations", async () => {
    const list = await installations.list();
    return list.map((inst) => {
      const source = sourceMap[inst.sourceId];
      if (!source) return inst;
      const listPreview = source.getListPreview ? source.getListPreview(inst) : undefined;
      const statusTag = inst.status === "partial-delete"
        ? { label: i18n.t("errors.deleteInterrupted"), style: "danger" }
        : inst.status === "failed"
        ? { label: i18n.t("errors.installFailed"), style: "danger" }
        : (source.getStatusTag ? source.getStatusTag(inst) : undefined);
      return { ...inst, sourceLabel: source.label, sourceCategory: source.category, hasConsole: source.hasConsole !== false, ...(listPreview != null ? { listPreview } : {}), ...(statusTag ? { statusTag } : {}) };
    });
  });

  ipcMain.handle("add-installation", async (_event, data) => {
    if (data.installPath) {
      // Always install into a dedicated subdirectory named after the installation
      const dirName = data.name.replace(/[<>:"/\\|?*]+/g, "_").trim() || "ComfyUI";
      let installPath = path.join(data.installPath, dirName);
      // Avoid collisions by appending a suffix
      let suffix = 1;
      while (fs.existsSync(installPath)) {
        installPath = path.join(data.installPath, `${dirName} (${suffix})`);
        suffix++;
      }
      data.installPath = installPath;
      const duplicate = await findDuplicatePath(data.installPath);
      if (duplicate) {
        return { ok: false, message: `That directory is already used by "${duplicate.name}".` };
      }
    }
    return { ok: true, entry: await installations.add({ ...data, seen: false }) };
  });

  ipcMain.handle("reorder-installations", async (_event, orderedIds) => {
    await installations.reorder(orderedIds);
  });

  ipcMain.handle("probe-installation", (_event, dirPath) => {
    const results = [];
    for (const source of sources) {
      if (source.probeInstallation) {
        const data = source.probeInstallation(dirPath);
        if (data) {
          results.push({ sourceId: source.id, sourceLabel: source.label, ...data });
        }
      }
    }
    return results;
  });

  ipcMain.handle("track-installation", async (_event, data) => {
    const duplicate = await findDuplicatePath(data.installPath);
    if (duplicate) {
      return { ok: false, message: `That directory is already used by "${duplicate.name}".` };
    }
    if (!fs.existsSync(data.installPath)) {
      return { ok: false, message: "That directory does not exist." };
    }
    try {
      fs.writeFileSync(path.join(data.installPath, MARKER_FILE), "tracked");
    } catch (err) {
      return { ok: false, message: `Cannot write to directory: ${err.message}` };
    }
    const entry = await installations.add({ ...data, status: "installed", seen: false });
    return { ok: true, entry };
  });

  ipcMain.handle("install-instance", async (_event, installationId) => {
    const inst = await resolveInstallation(installationId);
    if (_operationAborts.has(installationId)) {
      return { ok: false, message: "Another operation is already running for this installation." };
    }
    const source = resolveSource(inst.sourceId);
    const sender = _event.sender;

    const sendProgress = (phase, detail) => {
      if (!sender.isDestroyed()) {
        sender.send("install-progress", { installationId, phase, ...detail });
      }
    };

    if (source.install) {
      fs.mkdirSync(inst.installPath, { recursive: true });
      fs.writeFileSync(path.join(inst.installPath, MARKER_FILE), installationId);
      if (source.installSteps) {
        sendProgress("steps", { steps: source.installSteps });
      }
      const abort = new AbortController();
      _operationAborts.set(installationId, abort);
      const cache = createCache(settings.get("cacheDir"), settings.get("maxCachedFiles"));
      try {
        await source.install(inst, { sendProgress, download, cache, extract, signal: abort.signal });
        if (source.postInstall) {
          const update = (data) => installations.update(installationId, data);
          await source.postInstall(inst, { sendProgress, update });
        }
        sendProgress("done", { percent: 100, status: "Complete" });
      } catch (err) {
        _operationAborts.delete(installationId);
        if (abort.signal.aborted) {
          // Try quick cleanup first (works if cancelled during download)
          let cleaned = !fs.existsSync(inst.installPath);
          if (!cleaned) {
            try {
              fs.rmSync(inst.installPath, { recursive: true, force: true });
              cleaned = true;
            } catch {}
          }
          if (cleaned) {
            await installations.remove(installationId);
            return { ok: true, navigate: "list" };
          }
          // Quick cleanup failed (locked files after extraction) — switch to
          // a full delete task with progress reporting
          const markerPath = path.join(inst.installPath, MARKER_FILE);
          try { fs.writeFileSync(markerPath, installationId); } catch {}
          await installations.update(installationId, { status: "partial-delete" });
          const deleteAbort = new AbortController();
          _operationAborts.set(installationId, deleteAbort);
          sendProgress("delete", { percent: 0, status: "Counting files…" });
          try {
            await deleteDir(inst.installPath, (p) => {
              const elapsed = formatTime(p.elapsedSecs);
              const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : "—";
              sendProgress("delete", {
                percent: p.percent,
                status: `Deleting… ${p.deleted} / ${p.total} items  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
              });
            }, { signal: deleteAbort.signal });
            _operationAborts.delete(installationId);
            await installations.remove(installationId);
          } catch (delErr) {
            _operationAborts.delete(installationId);
            if (deleteAbort.signal.aborted) {
              if (isEffectivelyEmptyInstallDir(inst.installPath)) {
                try { fs.rmSync(inst.installPath, { recursive: true, force: true }); } catch {}
                await installations.remove(installationId);
              } else {
                try { fs.writeFileSync(markerPath, installationId); } catch {}
                await installations.update(installationId, { status: "partial-delete" });
              }
            }
          }
          return { ok: true, navigate: "list" };
        }
        await installations.update(installationId, { status: "failed" });
        return { ok: false, message: err.message };
      }
      _operationAborts.delete(installationId);
      await installations.update(installationId, { status: "installed" });
      return { ok: true };
    }

    await installations.update(installationId, { status: "failed" });
    return { ok: false, message: "This source does not support installation." };
  });

  // List actions
  ipcMain.handle("get-list-actions", async (_event, installationId) => {
    const inst = await resolveInstallation(installationId);
    const source = resolveSource(inst.sourceId);
    return source.getListActions ? source.getListActions(inst) : [];
  });

  // Detail — validate editable fields dynamically from source schema
  ipcMain.handle("update-installation", async (_event, installationId, data) => {
    const inst = await resolveInstallation(installationId);
    const source = resolveSource(inst.sourceId);
    const sections = source.getDetailSections(inst);
    const allowedIds = new Set(["name", "seen"]);
    for (const section of sections) {
      if (!section.fields) continue;
      for (const f of section.fields) {
        if (f.editable && f.id) allowedIds.add(f.id);
      }
    }
    const filtered = {};
    for (const key of Object.keys(data)) {
      if (allowedIds.has(key)) filtered[key] = data[key];
    }
    // Reject duplicate names
    if (filtered.name && filtered.name !== inst.name) {
      const all = await installations.list();
      if (all.some((i) => i.id !== installationId && i.name === filtered.name)) {
        return { ok: false, message: i18n.t("errors.duplicateName", { name: filtered.name }) };
      }
    }
    await installations.update(installationId, filtered);
    return { ok: true };
  });

  ipcMain.handle("get-detail-sections", async (_event, installationId) => {
    const inst = await resolveInstallation(installationId);
    return resolveSource(inst.sourceId).getDetailSections(inst);
  });

  // Settings
  ipcMain.handle("get-settings-sections", () => {
    const s = settings.getAll();
    const appSections = [
      {
        title: i18n.t("settings.general"),
        fields: [
          { id: "language", label: i18n.t("settings.language"), type: "select", value: s.language || i18n.getLocale(),
            options: i18n.getAvailableLocales() },
          { id: "theme", label: i18n.t("settings.theme"), type: "select", value: s.theme || "system",
            options: [
              { value: "system", label: i18n.t("settings.themeSystem") },
              { value: "dark", label: i18n.t("settings.themeDark") },
              { value: "light", label: i18n.t("settings.themeLight") },
            ] },
          { id: "autoUpdate", label: i18n.t("settings.autoUpdate"), type: "boolean", value: s.autoUpdate !== false },
          { id: "onLauncherClose", label: i18n.t("settings.onLauncherClose"), type: "select", value: s.onLauncherClose || "quit",
            options: [
              { value: "quit", label: i18n.t("settings.closeQuit") },
              { value: "tray", label: i18n.t("settings.closeTray") },
            ] },
        ],
      },
      {
        title: i18n.t("settings.sharedDirs"),
        fields: [
          { id: "inputDir", label: i18n.t("settings.inputDir"), type: "path", value: s.inputDir || settings.defaults.inputDir, openable: true },
          { id: "outputDir", label: i18n.t("settings.outputDir"), type: "path", value: s.outputDir || settings.defaults.outputDir, openable: true },
        ],
      },
      {
        title: i18n.t("settings.downloads"),
        fields: [
          { id: "cacheDir", label: i18n.t("settings.cacheDir"), type: "path", value: s.cacheDir, openable: true },
          { id: "maxCachedFiles", label: i18n.t("settings.maxCachedFiles"), type: "number", value: s.maxCachedFiles, min: 1, max: 50 },
        ],
      },
    ];
    const sourceSections = sources.flatMap((src) =>
      src.getSettingsSections ? src.getSettingsSections(s) : []
    );
    let version = app.getVersion();
    if (!app.isPackaged) {
      try {
        version = require("child_process").execFileSync("git", ["describe", "--tags", "--always"], { cwd: __dirname, encoding: "utf8" }).trim() || version;
      } catch {}
    }
    const aboutSection = {
      title: i18n.t("settings.about"),
      fields: [
        { label: i18n.t("settings.version"), value: version, readonly: true },
        { label: i18n.t("settings.platform"), value: `${process.platform} (${process.arch})`, readonly: true },
      ],
      actions: [
        { id: "github", label: "GitHub", url: "https://github.com/Kosinkadink/ComfyUI-Launcher" },
      ],
    };
    return [...appSections, ...sourceSections, aboutSection];
  });

  ipcMain.handle("get-models-sections", () => {
    const s = settings.getAll();
    return {
      systemDefault: settings.defaults.modelsDirs[0],
      sections: [
        {
          title: i18n.t("models.directories"),
          fields: [
            { id: "modelsDirs", label: i18n.t("models.directoriesDesc"), type: "pathList", value: s.modelsDirs || [] },
          ],
        },
      ],
    };
  });

  ipcMain.handle("set-setting", (_event, key, value) => {
    settings.set(key, value);
    // Broadcast resolved theme when theme setting changes
    if (key === "theme") {
      const resolved = resolveTheme();
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send("theme-changed", resolved);
      });
    }
    // Re-init i18n and broadcast new messages when language changes
    if (key === "language") {
      i18n.init(value);
      const msgs = i18n.getMessages();
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send("locale-changed", msgs);
      });
      if (_onLocaleChanged) _onLocaleChanged();
    }
  });

  ipcMain.handle("get-setting", (_event, key) => {
    return settings.get(key);
  });

  ipcMain.handle("get-locale-messages", () => i18n.getMessages());
  ipcMain.handle("get-available-locales", () => i18n.getAvailableLocales());

  ipcMain.handle("get-resolved-theme", () => resolveTheme());

  nativeTheme.on("updated", () => {
    if ((settings.get("theme") || "system") !== "system") return;
    const resolved = resolveTheme();
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send("theme-changed", resolved);
    });
  });

  ipcMain.handle("stop-comfyui", async (_event, installationId) => {
    if (installationId) {
      await stopRunning(installationId);
    } else {
      await stopRunning();
    }
    if (_onStop) _onStop({ installationId });
  });

  ipcMain.handle("get-running-instances", () => _getPublicSessions());

  ipcMain.handle("cancel-launch", () => {
    // Legacy — cancel all operations (kept for backwards compatibility)
    for (const [id, abort] of _operationAborts) {
      abort.abort();
    }
    _operationAborts.clear();
  });

  ipcMain.handle("cancel-operation", (_event, installationId) => {
    const abort = _operationAborts.get(installationId);
    if (abort) {
      abort.abort();
      _operationAborts.delete(installationId);
    }
  });

  ipcMain.handle("kill-port-process", async (_event, port) => {
    removePortLock(port);
    await killByPort(port);
    // Brief delay to let the OS release the port
    await new Promise((r) => setTimeout(r, 500));
    const remaining = await findPidsByPort(port);
    return { ok: remaining.length === 0 };
  });

  ipcMain.handle("run-action", async (_event, installationId, actionId, actionData) => {
    const inst = await resolveInstallation(installationId);
    if (actionId === "remove") {
      await installations.remove(installationId);
      return { ok: true, navigate: "list" };
    }
    if (actionId === "delete") {
      // If the directory is already gone, just remove the record
      if (!fs.existsSync(inst.installPath)) {
        await installations.remove(installationId);
        return { ok: true, navigate: "list" };
      }
      if (_operationAborts.has(installationId)) {
        return { ok: false, message: "Another operation is already running for this installation." };
      }
      const markerPath = path.join(inst.installPath, MARKER_FILE);
      let markerContent;
      try { markerContent = fs.readFileSync(markerPath, "utf-8").trim(); } catch { markerContent = null; }
      if (!markerContent) {
        return { ok: false, message: "Safety check failed: this directory was not created by ComfyUI Launcher. Use Untrack to remove it from the list, then delete the files manually." };
      }
      if (markerContent !== inst.id && markerContent !== "tracked") {
        return { ok: false, message: "Safety check failed: the marker file does not match this installation. Use Untrack instead." };
      }
      const sender = _event.sender;
      const sendProgress = (phase, detail) => {
        if (!sender.isDestroyed()) {
          sender.send("install-progress", { installationId, phase, ...detail });
        }
      };
      const abort = new AbortController();
      _operationAborts.set(installationId, abort);
      sendProgress("delete", { percent: 0, status: "Counting files…" });
      try {
        await deleteDir(inst.installPath, (p) => {
          const elapsed = formatTime(p.elapsedSecs);
          const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : "—";
          sendProgress("delete", {
            percent: p.percent,
            status: `Deleting… ${p.deleted} / ${p.total} items  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
          });
        }, { signal: abort.signal });
      } catch (err) {
        _operationAborts.delete(installationId);
        if (abort.signal.aborted) {
          // Restore the marker file so the safety check passes on retry
          try {
            fs.mkdirSync(inst.installPath, { recursive: true });
            fs.writeFileSync(markerPath, markerContent);
          } catch {}
          await installations.update(installationId, { status: "partial-delete" });
        }
        return { ok: false, message: err.message };
      }
      _operationAborts.delete(installationId);
      await installations.remove(installationId);
      return { ok: true, navigate: "list" };
    }
    if (actionId === "open-folder") {
      if (inst.installPath) {
        if (fs.existsSync(inst.installPath)) {
          const err = await openPath(inst.installPath);
          if (err) return { ok: false, message: i18n.t("errors.cannotOpenDir", { error: err }) };
        } else {
          return { ok: false, message: i18n.t("errors.dirNotExist", { path: inst.installPath }) };
        }
      }
      return { ok: true };
    }
    if (actionId === "copy") {
      const name = actionData?.name;
      if (!name) return { ok: false, message: "No name provided." };
      if (!inst.installPath || !fs.existsSync(inst.installPath)) {
        return { ok: false, message: i18n.t("errors.dirNotExist", { path: inst.installPath || "" }) };
      }
      if (_operationAborts.has(installationId)) {
        return { ok: false, message: "Another operation is already running for this installation." };
      }

      const sender = _event.sender;
      const sendProgress = (phase, detail) => {
        if (!sender.isDestroyed()) {
          sender.send("install-progress", { installationId, phase, ...detail });
        }
      };

      const abort = new AbortController();
      _operationAborts.set(installationId, abort);

      try {
        await performCopy(inst, name, sendProgress, abort.signal);
        _operationAborts.delete(installationId);
        sendProgress("done", { percent: 100, status: "Complete" });
        return { ok: true, navigate: "list" };
      } catch (err) {
        _operationAborts.delete(installationId);
        if (abort.signal.aborted) return { ok: true, navigate: "detail" };
        return { ok: false, message: err.message };
      }
    }
    if (actionId === "copy-update") {
      const name = actionData?.name;
      if (!name) return { ok: false, message: "No name provided." };
      if (!inst.installPath || !fs.existsSync(inst.installPath)) {
        return { ok: false, message: i18n.t("errors.dirNotExist", { path: inst.installPath || "" }) };
      }
      if (_operationAborts.has(installationId)) {
        return { ok: false, message: "Another operation is already running for this installation." };
      }

      const sender = _event.sender;
      const sendProgress = (phase, detail) => {
        if (!sender.isDestroyed()) {
          sender.send("install-progress", { installationId, phase, ...detail });
        }
      };
      const sendOutput = (text) => {
        if (!sender.isDestroyed()) {
          sender.send("comfy-output", { installationId, text });
        }
      };

      const abort = new AbortController();
      _operationAborts.set(installationId, abort);

      try {
        // Set up combined step layout for the entire operation
        sendProgress("steps", { steps: [
          { phase: "copy", label: i18n.t("actions.copyingFiles") },
          { phase: "prepare", label: i18n.t("standalone.updatePrepare") },
          { phase: "run", label: i18n.t("standalone.updateRun") },
          { phase: "deps", label: i18n.t("standalone.updateDeps") },
        ] });

        // Phase 1: Copy the installation
        const { entry } = await performCopy(inst, name, sendProgress, abort.signal);

        // Phase 2: Run update on the copy
        // Filter out "steps" events from the update handler — steps are already defined
        const updateSendProgress = (phase, detail) => {
          if (phase !== "steps") sendProgress(phase, detail);
        };
        try {
          const source = resolveSource(inst.sourceId);
          const newInst = await installations.get(entry.id);
          const newUpdate = (data) => installations.update(entry.id, data);
          const updateResult = await source.handleAction("update-comfyui", newInst, {}, {
            update: newUpdate,
            sendProgress: updateSendProgress,
            sendOutput,
            signal: abort.signal,
          });
          if (updateResult && !updateResult.ok) {
            sendOutput(`\n⚠ Update: ${updateResult.message}\n`);
            sendOutput("The copy was created successfully. You can retry the update from the new installation.\n");
          }
        } catch (updateErr) {
          sendOutput(`\n⚠ Update failed: ${updateErr.message}\n`);
          sendOutput("The copy was created successfully. You can retry the update from the new installation.\n");
        }

        _operationAborts.delete(installationId);
        return { ok: true, navigate: "list" };
      } catch (err) {
        _operationAborts.delete(installationId);
        if (abort.signal.aborted) return { ok: true, navigate: "detail" };
        return { ok: false, message: err.message };
      }
    }
    if (actionId === "release-update") {
      const name = actionData?.name;
      const releaseSelection = actionData?.releaseSelection;
      const variantSelection = actionData?.variantSelection;
      if (!name || !releaseSelection || !variantSelection) {
        return { ok: false, message: "Missing required selections." };
      }
      if (!inst.installPath || !fs.existsSync(inst.installPath)) {
        return { ok: false, message: i18n.t("errors.dirNotExist", { path: inst.installPath || "" }) };
      }
      if (_operationAborts.has(installationId)) {
        return { ok: false, message: "Another operation is already running for this installation." };
      }

      const source = resolveSource(inst.sourceId);
      const installData = source.buildInstallation({
        release: releaseSelection,
        variant: variantSelection,
      });

      // Resolve install path next to the source installation
      const parentDir = path.dirname(inst.installPath);
      const dirName = name.replace(/[<>:"/\\|?*]+/g, "_").trim() || "ComfyUI";
      let destPath = path.join(parentDir, dirName);
      let suffix = 1;
      while (fs.existsSync(destPath)) {
        destPath = path.join(parentDir, `${dirName} (${suffix})`);
        suffix++;
      }

      const duplicate = await findDuplicatePath(destPath);
      if (duplicate) {
        return { ok: false, message: `That directory is already used by "${duplicate.name}".` };
      }

      const sender = _event.sender;
      const sendProgress = (phase, detail) => {
        if (!sender.isDestroyed()) {
          sender.send("install-progress", { installationId, phase, ...detail });
        }
      };
      const sendOutput = (text) => {
        if (!sender.isDestroyed()) {
          sender.send("comfy-output", { installationId, text });
        }
      };

      const abort = new AbortController();
      _operationAborts.set(installationId, abort);

      sendProgress("steps", { steps: [
        { phase: "download", label: i18n.t("common.download") },
        { phase: "extract", label: i18n.t("common.extract") },
        { phase: "setup", label: i18n.t("standalone.setupEnv") },
        { phase: "migrate", label: i18n.t("migrate.filePhase") },
        { phase: "deps", label: i18n.t("migrate.depsPhase") },
      ] });

      let entry = null;
      let installComplete = false;
      try {
        // Phase 1: Download and extract
        fs.mkdirSync(destPath, { recursive: true });
        const installRecord = { ...installData, installPath: destPath };
        const cache = createCache(settings.get("cacheDir"), settings.get("maxCachedFiles"));
        await source.install(installRecord, { sendProgress, download, cache, extract, signal: abort.signal });

        // Phase 2: Create default Python environment
        entry = await installations.add({
          sourceId: inst.sourceId,
          sourceLabel: source.label,
          ...installData,
          name,
          installPath: destPath,
          status: "installed",
          seen: false,
        });
        try { fs.writeFileSync(path.join(destPath, MARKER_FILE), entry.id); } catch {}

        const newUpdate = (data) => installations.update(entry.id, data);
        await source.postInstall(installRecord, { sendProgress, update: newUpdate });
        installComplete = true;

        // Phase 3: Migration from source installation
        const newInst = await installations.get(entry.id);
        const migrateSendProgress = (phase, detail) => {
          if (phase !== "steps" && phase !== "done") sendProgress(phase, detail);
        };
        const migrateData = {
          sourceInstallationId: inst.id,
          customNodes: true,
          allUserData: true,
          models: true,
          input: true,
          output: true,
        };
        let migrateError = null;
        try {
          const migrateResult = await source.handleAction("migrate-from", newInst, migrateData, {
            update: newUpdate,
            sendProgress: migrateSendProgress,
            sendOutput,
            signal: abort.signal,
          });
          if (migrateResult && !migrateResult.ok) {
            migrateError = migrateResult.message || "Unknown migration error";
          }
        } catch (migrateErr) {
          migrateError = migrateErr.message;
        }

        _operationAborts.delete(installationId);
        if (migrateError) {
          sendOutput(`\n⚠ ${migrateError}\n`);
          sendProgress("migrate", { percent: -1, status: i18n.t("standalone.releaseUpdateCleaningUp") });
          try { await installations.remove(entry.id); } catch {}
          try {
            await deleteDir(destPath, (p) => {
              const elapsed = formatTime(p.elapsedSecs);
              const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : "—";
              sendProgress("migrate", {
                percent: p.percent,
                status: `${i18n.t("standalone.releaseUpdateCleaningUp")}  ${p.deleted} / ${p.total}  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
              });
            });
          } catch {}
          return { ok: false, message: migrateError };
        }
        sendProgress("done", { percent: 100, status: "Complete" });
        return { ok: true, navigate: "list" };
      } catch (err) {
        _operationAborts.delete(installationId);
        if (!installComplete) {
          if (entry) try { await installations.remove(entry.id); } catch {}
          try { await fs.promises.rm(destPath, { recursive: true, force: true }); } catch {}
        }
        if (abort.signal.aborted) return { ok: true, navigate: installComplete ? "list" : "detail" };
        return { ok: false, message: err.message };
      }
    }
    if (actionId === "launch") {
      if (_runningSessions.has(installationId)) {
        return { ok: false, message: i18n.t("errors.alreadyRunning") };
      }
      if (_operationAborts.has(installationId)) {
        return { ok: false, message: "Another operation is already running for this installation." };
      }
      const source = resolveSource(inst.sourceId);
      if (!source.skipInstall && isEffectivelyEmptyInstallDir(inst.installPath)) {
        return { ok: false, message: i18n.t("errors.installDirEmpty") };
      }
      const launchCmd = source.getLaunchCommand ? source.getLaunchCommand(inst) : null;
      if (!launchCmd) {
        return { ok: false, message: source.getLaunchCommand
          ? i18n.t("errors.noEnvFound")
          : i18n.t("errors.noLaunchSupport") };
      }
      // Inject shared paths if this installation uses them
      if (inst.useSharedPaths !== false && launchCmd.args) {
        const modelsDirs = settings.get("modelsDirs");
        const modelPathsConfig = ensureModelPathsConfig(modelsDirs);
        if (modelPathsConfig) {
          launchCmd.args.push("--extra-model-paths-config", modelPathsConfig);
        }
        const inputDir = settings.get("inputDir") || settings.defaults.inputDir;
        const outputDir = settings.get("outputDir") || settings.defaults.outputDir;
        // Ensure directories exist before passing to ComfyUI
        fs.mkdirSync(inputDir, { recursive: true });
        fs.mkdirSync(outputDir, { recursive: true });
        launchCmd.args.push("--input-directory", inputDir);
        launchCmd.args.push("--output-directory", outputDir);
      }

      const sender = _event.sender;
      const sendProgress = (phase, detail) => {
        if (!sender.isDestroyed()) {
          sender.send("install-progress", { installationId, phase, ...detail });
        }
      };

      const abort = new AbortController();
      _operationAborts.set(installationId, abort);

      // Remote connection — no process to spawn, just verify connectivity
      if (launchCmd.remote) {
        sendProgress("launch", { percent: -1, status: i18n.t("launch.connecting", { url: launchCmd.url }) });
        try {
          await waitForUrl(launchCmd.url, {
            timeoutMs: 15000,
            signal: abort.signal,
            onPoll: ({ elapsedMs }) => {
              const secs = Math.round(elapsedMs / 1000);
              sendProgress("launch", { percent: -1, status: i18n.t("launch.connectingTime", { url: launchCmd.url, secs }) });
            },
          });
        } catch (err) {
          _operationAborts.delete(installationId);
          if (abort.signal.aborted) return { ok: false, message: i18n.t("errors.launchCancelled") };
          return { ok: false, message: i18n.t("errors.cannotConnect", { url: launchCmd.url }) };
        }

        _operationAborts.delete(installationId);
        const mode = inst.launchMode || "window";
        _addSession(installationId, { proc: null, port: launchCmd.port, url: launchCmd.url, mode, installationName: inst.name });
        if (_onLaunch) {
          _onLaunch({ port: launchCmd.port, url: launchCmd.url, process: null, installation: inst, mode });
        }
        return { ok: true, mode, port: launchCmd.port, url: launchCmd.url };
      }

      // Local process launch
      if (!fs.existsSync(launchCmd.cmd)) {
        _operationAborts.delete(installationId);
        return { ok: false, message: `Executable not found: ${launchCmd.cmd}` };
      }

      // Allow renderer to re-launch with a specific port override
      if (actionData && actionData.portOverride) {
        setPortArg(launchCmd, actionData.portOverride);
      }

      // Check if something is already listening on the target port
      const existingPids = await findPidsByPort(launchCmd.port);
      if (existingPids.length > 0) {
        const defaults = source.getDefaults ? source.getDefaults() : {};
        const portConflictMode = inst.portConflict || defaults.portConflict || "auto";
        const userArgs = (inst.launchArgs || "").trim();
        const portIsExplicit = /(?:^|\s)--port\b/.test(userArgs);

        // Find the next available port for both modes
        let nextPort = null;
        try {
          nextPort = await findAvailablePort("127.0.0.1", launchCmd.port + 1, launchCmd.port + 1000);
        } catch {}

        // Auto mode: use the next available port — but if the user explicitly
        // set --port in startup args, fall through to ask since the choice was deliberate
        if (portConflictMode === "auto" && nextPort && !portIsExplicit) {
          sendProgress("launch", { percent: -1, status: i18n.t("launch.portBusyUsing", { old: launchCmd.port, new: nextPort }) });
          setPortArg(launchCmd, nextPort);
        } else {
          // Ask mode: return conflict info for the renderer to handle
          const lock = readPortLock(launchCmd.port);
          let message;
          let isComfy;
          if (lock) {
            message = i18n.t("errors.portConflictLauncher", { port: launchCmd.port, name: lock.installationName });
            isComfy = true;
          } else {
            const info = await getProcessInfo(existingPids[0]);
            isComfy = looksLikeComfyUI(info);
            const processDesc = info ? info.name : `PID ${existingPids[0]}`;
            message = isComfy
              ? i18n.t("errors.portConflictComfy", { port: launchCmd.port, process: processDesc })
              : i18n.t("errors.portConflictOther", { port: launchCmd.port, process: processDesc });
          }
          _operationAborts.delete(installationId);
          return { ok: false, message, portConflict: { port: launchCmd.port, pids: existingPids, isComfy, nextPort } };
        }
      }

      const sessionPath = createSessionPath();
      const launchEnv = { ...process.env, __COMFY_CLI_SESSION__: sessionPath };
      const sendOutput = (text) => {
        if (!sender.isDestroyed()) {
          sender.send("comfy-output", { installationId, text });
        }
      };

      function spawnComfy() {
        const proc = spawnProcess(launchCmd.cmd, launchCmd.args, launchCmd.cwd, launchEnv);
        let stderrBuf = "";
        proc.stdout.on("data", (chunk) => sendOutput(chunk.toString("utf-8")));
        proc.stderr.on("data", (chunk) => {
          const text = chunk.toString("utf-8");
          stderrBuf += text;
          if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
          sendOutput(text);
        });
        return { proc, getStderr: () => stderrBuf };
      }

      const cmdLine = [launchCmd.cmd, ...launchCmd.args].map((a) => /\s/.test(a) ? `"${a}"` : a).join(" ");
      sendProgress("launch", { percent: -1, status: i18n.t("launch.starting") });
      if (!sender.isDestroyed()) {
        sender.send("comfy-output", { installationId, text: `> ${cmdLine}\n\n` });
      }
      let { proc, getStderr } = spawnComfy();

      // Capture early exit / error before port is ready
      let earlyExit = null;
      const earlyExitPromise = new Promise((_, reject) => {
        proc.on("error", (err) => {
          const code = err.code ? ` (${err.code})` : "";
          earlyExit = err.message;
          reject(new Error(`Failed to start${code}: ${launchCmd.cmd}`));
        });
        proc.on("exit", (code) => {
          if (!earlyExit) {
            const detail = getStderr().trim() ? `\n\n${getStderr().trim()}` : "";
            earlyExit = `Process exited with code ${code}${detail}`;
            reject(new Error(earlyExit));
          }
        });
      });

      sendProgress("launch", { percent: -1, status: i18n.t("launch.waiting") });
      try {
        await Promise.race([
          waitForPort(launchCmd.port, "127.0.0.1", {
            timeoutMs: 120000,
            signal: abort.signal,
            onPoll: ({ elapsedMs }) => {
              const secs = Math.round(elapsedMs / 1000);
              sendProgress("launch", { percent: -1, status: i18n.t("launch.waitingTime", { secs }) });
            },
          }),
          earlyExitPromise,
        ]);
      } catch (err) {
        _operationAborts.delete(installationId);
        killProcessTree(proc);
        return { ok: false, message: err.message };
      }

      _operationAborts.delete(installationId);
      const mode = inst.launchMode || "window";
      _addSession(installationId, { proc, port: launchCmd.port, mode, installationName: inst.name });
      writePortLock(launchCmd.port, { pid: proc.pid, installationName: inst.name });

      function attachExitHandler(p) {
        p.on("exit", (code) => {
          if (checkRebootMarker(sessionPath)) {
            // ComfyUI-Manager requested a restart — respawn the process
            sendOutput("\n--- ComfyUI restarting ---\n\n");
            const spawned = spawnComfy();
            proc = spawned.proc;
            getStderr = spawned.getStderr;
            const session = _runningSessions.get(installationId);
            if (session) session.proc = proc;
            writePortLock(launchCmd.port, { pid: proc.pid, installationName: inst.name });
            attachExitHandler(proc);
            if (_onComfyRestarted) _onComfyRestarted({ installationId, process: proc });
            return;
          }
          // If session is still in the map, the exit was NOT user-initiated (crash)
          const crashed = _runningSessions.has(installationId);
          _removeSession(installationId);
          if (!sender.isDestroyed()) {
            sender.send("comfy-exited", { installationId, crashed, exitCode: code, installationName: inst.name });
          }
          if (_onComfyExited) _onComfyExited({ installationId });
        });
      }
      attachExitHandler(proc);

      if (_onLaunch) {
        _onLaunch({ port: launchCmd.port, process: proc, installation: inst, mode });
      }
      return { ok: true, mode, port: launchCmd.port };
    }
    const sender = _event.sender;
    const sendProgress = (phase, detail) => {
      if (!sender.isDestroyed()) {
        sender.send("install-progress", { installationId, phase, ...detail });
      }
    };
    const sendOutput = (text) => {
      if (!sender.isDestroyed()) {
        sender.send("comfy-output", { installationId, text });
      }
    };
    const update = (data) => installations.update(installationId, data);
    try {
      return await resolveSource(inst.sourceId).handleAction(actionId, inst, actionData, { update, sendProgress, sendOutput });
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });
}

async function stopRunning(installationId) {
  if (installationId) {
    const session = _runningSessions.get(installationId);
    if (!session) return;
    _removeSession(installationId);
    if (session.proc && !session.proc.killed) {
      killProcessTree(session.proc);
    }
  } else {
    // Stop all running instances
    for (const [id, session] of _runningSessions) {
      if (session.proc && !session.proc.killed) {
        killProcessTree(session.proc);
      }
      if (session.port) removePortLock(session.port);
    }
    _runningSessions.clear();
  }
}

function hasRunningSessions() {
  return _runningSessions.size > 0;
}

function hasActiveOperations() {
  return _runningSessions.size > 0 || _operationAborts.size > 0;
}

function cancelAll() {
  for (const [id, abort] of _operationAborts) {
    abort.abort();
  }
  _operationAborts.clear();
  stopRunning();
}

module.exports = { register, stopRunning, hasRunningSessions, hasActiveOperations, cancelAll };
