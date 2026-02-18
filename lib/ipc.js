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
const i18n = require("./i18n");
const { ensureModelPathsConfig } = require("./models");

const MARKER_FILE = ".comfyui-launcher";

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
let _launchAbort = null;
let _detectedGPU = undefined;

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
  }
  if (changed) {
    for (const inst of all) await installations.update(inst.id, inst);
  }
}

function resolveTheme() {
  const theme = settings.get("theme") || "system";
  return theme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : theme;
}

function register({ onLaunch, onStop, onComfyExited, onComfyRestarted } = {}) {
  _onLaunch = onLaunch;
  _onStop = onStop;
  _onComfyExited = onComfyExited;
  _onComfyRestarted = onComfyRestarted;

  migrateDefaults();

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
      const statusTag = inst.status === "failed"
        ? { label: "Install Failed", style: "danger" }
        : (source.getStatusTag ? source.getStatusTag(inst) : undefined);
      return { ...inst, sourceLabel: source.label, ...(listPreview != null ? { listPreview } : {}), ...(statusTag ? { statusTag } : {}) };
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
      const cache = createCache(settings.get("cacheDir"), settings.get("maxCachedFiles"));
      try {
        await source.install(inst, { sendProgress, download, cache, extract });
        if (source.postInstall) {
          const update = (data) => installations.update(installationId, data);
          await source.postInstall(inst, { sendProgress, update });
        }
        sendProgress("done", { percent: 100, status: "Complete" });
      } catch (err) {
        await installations.update(installationId, { status: "failed" });
        return { ok: false, message: err.message };
      }
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
    await installations.update(installationId, filtered);
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
    return [
      {
        title: i18n.t("models.directories"),
        fields: [
          { id: "modelsDirs", label: i18n.t("models.directoriesDesc"), type: "pathList", value: s.modelsDirs || [] },
        ],
      },
    ];
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
    if (_launchAbort) {
      _launchAbort.abort();
      _launchAbort = null;
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
      sendProgress("delete", { percent: 0, status: "Counting files…" });
      await deleteDir(inst.installPath, (p) => {
        const elapsed = formatTime(p.elapsedSecs);
        const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : "—";
        sendProgress("delete", {
          percent: p.percent,
          status: `Deleting… ${p.deleted} / ${p.total} items  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
        });
      });
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
    if (actionId === "launch") {
      if (_runningSessions.has(installationId)) {
        return { ok: false, message: i18n.t("errors.alreadyRunning") };
      }
      const source = resolveSource(inst.sourceId);
      const launchCmd = source.getLaunchCommand ? source.getLaunchCommand(inst) : null;
      if (!launchCmd) {
        return { ok: false, message: source.getLaunchCommand
          ? i18n.t("errors.noEnvFound")
          : i18n.t("errors.noLaunchSupport") };
      }
      // Inject shared model paths config if configured
      const modelsDirs = settings.get("modelsDirs");
      const modelPathsConfig = ensureModelPathsConfig(modelsDirs);
      if (modelPathsConfig && launchCmd.args) {
        launchCmd.args.push("--extra-model-paths-config", modelPathsConfig);
      }

      const sender = _event.sender;
      const sendProgress = (phase, detail) => {
        if (!sender.isDestroyed()) {
          sender.send("install-progress", { installationId, phase, ...detail });
        }
      };

      const abort = new AbortController();
      _launchAbort = abort;

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
          _launchAbort = null;
          if (abort.signal.aborted) return { ok: false, message: i18n.t("errors.launchCancelled") };
          return { ok: false, message: i18n.t("errors.cannotConnect", { url: launchCmd.url }) };
        }

        _launchAbort = null;
        const mode = inst.launchMode || "window";
        _addSession(installationId, { proc: null, port: launchCmd.port, url: launchCmd.url, mode, installationName: inst.name });
        if (_onLaunch) {
          _onLaunch({ port: launchCmd.port, url: launchCmd.url, process: null, installation: inst, mode });
        }
        return { ok: true, mode, port: launchCmd.port, url: launchCmd.url };
      }

      // Local process launch
      if (!fs.existsSync(launchCmd.cmd)) {
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
        _launchAbort = null;
        killProcessTree(proc);
        return { ok: false, message: err.message };
      }

      _launchAbort = null;
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
  return _runningSessions.size > 0 || _launchAbort !== null;
}

function cancelAll() {
  if (_launchAbort) {
    _launchAbort.abort();
    _launchAbort = null;
  }
  stopRunning();
}

module.exports = { register, stopRunning, hasRunningSessions, hasActiveOperations, cancelAll };
