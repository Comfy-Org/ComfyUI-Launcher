const path = require("path");
const fs = require("fs");
const { ipcMain, dialog, shell, BrowserWindow, nativeTheme } = require("electron");
const sources = require("../sources");
const installations = require("../installations");
const settings = require("../settings");
const { defaultInstallDir } = require("./paths");
const { download } = require("./download");
const { createCache } = require("./cache");
const { extract } = require("./extract");
const { deleteDir } = require("./delete");
const { spawnProcess, waitForPort, killProcessTree } = require("./process");
const { detectGPU } = require("./gpu");

const MARKER_FILE = ".comfyui-launcher";
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

let _onLaunch = null;
let _onStop = null;
let _isRunning = false;
let _detectedGPU = undefined;

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
  }
  if (changed) {
    for (const inst of all) await installations.update(inst.id, inst);
  }
}

function resolveTheme() {
  const theme = settings.get("theme") || "system";
  return theme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : theme;
}

function register({ onLaunch, onStop } = {}) {
  _onLaunch = onLaunch;
  _onStop = onStop;

  migrateDefaults();

  // Sources
  ipcMain.handle("get-sources", () =>
    sources.map((s) => ({ id: s.id, label: s.label, fields: s.fields }))
  );

  ipcMain.handle("get-field-options", async (_event, sourceId, fieldId, selections) => {
    const gpu = _detectedGPU === undefined ? null : _detectedGPU;
    const options = await resolveSource(sourceId).getFieldOptions(fieldId, selections, { gpu });
    return options;
  });

  ipcMain.handle("detect-gpu", () => {
    if (_detectedGPU === undefined) _detectedGPU = detectGPU();
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

  ipcMain.handle("open-path", (_event, targetPath) => shell.openPath(targetPath));

  // Installations
  ipcMain.handle("get-installations", async () => {
    const list = await installations.list();
    return list.map((inst) => {
      const source = sourceMap[inst.sourceId];
      return source ? { ...inst, sourceLabel: source.label } : inst;
    });
  });

  ipcMain.handle("add-installation", async (_event, data) => {
    const duplicate = await findDuplicatePath(data.installPath);
    if (duplicate) {
      return { ok: false, message: `That directory is already used by "${duplicate.name}".` };
    }
    return { ok: true, entry: await installations.add(data) };
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
    const entry = await installations.add({ ...data, status: "installed" });
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
      const cache = createCache(settings.get("cacheDir"), settings.get("maxCachedFiles"));
      try {
        await source.install(inst, { sendProgress, download, cache, extract });
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
    const allowedIds = new Set(["name"]);
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
        title: "General",
        fields: [
          { id: "theme", label: "Theme", type: "select", value: s.theme || "system",
            options: [
              { value: "system", label: "Match system" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ] },
          { id: "onComfyClose", label: "When ComfyUI window is closed", type: "select", value: s.onComfyClose || "tray",
            options: [
              { value: "tray", label: "Minimize to system tray" },
              { value: "launcher", label: "Stop and return to launcher" },
              { value: "quit", label: "Quit the app" },
            ] },
        ],
      },
    ];
    const sourceSections = sources.flatMap((src) =>
      src.getSettingsSections ? src.getSettingsSections(s) : []
    );
    return [...appSections, ...sourceSections];
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

  ipcMain.handle("get-resolved-theme", () => resolveTheme());

  nativeTheme.on("updated", () => {
    if ((settings.get("theme") || "system") !== "system") return;
    const resolved = resolveTheme();
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send("theme-changed", resolved);
    });
  });

  ipcMain.handle("stop-comfyui", () => {
    _isRunning = false;
    if (_onStop) _onStop();
  });

  ipcMain.handle("run-action", async (_event, installationId, actionId) => {
    const inst = await resolveInstallation(installationId);
    if (actionId === "remove") {
      await installations.remove(installationId);
      return { ok: true, navigate: "list" };
    }
    if (actionId === "delete") {
      const markerPath = path.join(inst.installPath, MARKER_FILE);
      if (!fs.existsSync(markerPath)) {
        return { ok: false, message: "Safety check failed: this directory was not created by ComfyUI Launcher. Use Untrack to remove it from the list, then delete the files manually." };
      }
      const sender = _event.sender;
      const sendProgress = (phase, detail) => {
        if (!sender.isDestroyed()) {
          sender.send("install-progress", { installationId, phase, ...detail });
        }
      };
      sendProgress("delete", { percent: 0, status: "Counting files…" });
      await deleteDir(inst.installPath, (p) => {
        sendProgress("delete", {
          percent: p.percent,
          status: `Deleting… ${p.deleted} / ${p.total} items`,
        });
      });
      await installations.remove(installationId);
      return { ok: true, navigate: "list" };
    }
    if (actionId === "launch") {
      if (_isRunning) {
        return { ok: false, message: "ComfyUI is already running. Stop it before launching again." };
      }
      const source = resolveSource(inst.sourceId);
      const launchCmd = source.getLaunchCommand ? source.getLaunchCommand(inst) : null;
      if (!launchCmd) {
        return { ok: false, message: "This source does not support launching yet." };
      }
      const sender = _event.sender;
      const sendProgress = (phase, detail) => {
        if (!sender.isDestroyed()) {
          sender.send("install-progress", { installationId, phase, ...detail });
        }
      };

      if (!fs.existsSync(launchCmd.cmd)) {
        return { ok: false, message: `Executable not found: ${launchCmd.cmd}` };
      }

      sendProgress("launch", { percent: -1, status: "Starting ComfyUI process…" });
      const proc = spawnProcess(launchCmd.cmd, launchCmd.args, launchCmd.cwd);

      // Forward stdout/stderr to renderer and capture stderr for error reporting
      let stderrBuf = "";
      let outputActive = true;
      const sendOutput = (text) => {
        if (outputActive && !sender.isDestroyed()) {
          sender.send("comfy-output", { installationId, text });
        }
      };
      proc.stdout.on("data", (chunk) => sendOutput(chunk.toString("utf-8")));
      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf-8");
        stderrBuf += text;
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
        sendOutput(text);
      });

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
            const detail = stderrBuf.trim() ? `\n\n${stderrBuf.trim()}` : "";
            earlyExit = `Process exited with code ${code}${detail}`;
            reject(new Error(earlyExit));
          }
        });
      });

      sendProgress("launch", { percent: -1, status: "Waiting for ComfyUI to be ready…" });
      try {
        await Promise.race([
          waitForPort(launchCmd.port, "127.0.0.1", {
            timeoutMs: 120000,
            onPoll: ({ elapsedMs }) => {
              const secs = Math.round(elapsedMs / 1000);
              sendProgress("launch", { percent: -1, status: `Waiting for ComfyUI to be ready… (${secs}s)` });
            },
          }),
          earlyExitPromise,
        ]);
      } catch (err) {
        killProcessTree(proc);
        return { ok: false, message: err.message };
      }

      _isRunning = true;
      proc.on("exit", () => {
        _isRunning = false;
        if (!sender.isDestroyed()) {
          sender.send("comfy-exited", { installationId });
        }
      });

      const mode = inst.launchMode || "browser";
      // In browser mode, stop forwarding output since nobody is listening
      if (mode === "browser") outputActive = false;

      if (_onLaunch) {
        _onLaunch({ port: launchCmd.port, process: proc, installation: inst, mode });
      }
      return { ok: true, mode, port: launchCmd.port };
    }
    return resolveSource(inst.sourceId).handleAction(actionId, inst);
  });
}

module.exports = { register };
