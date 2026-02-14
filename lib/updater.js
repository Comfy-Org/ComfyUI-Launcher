const { app, ipcMain, BrowserWindow, shell } = require("electron");
const { fetchJSON } = require("./fetch");
const settings = require("../settings");

const REPO = "Kosinkadink/ComfyUI-Launcher";
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

let _updateInfo = null;
let _autoUpdater = null;

function broadcast(channel, data) {
  BrowserWindow.getAllWindows().forEach((win) => {
    try {
      if (!win.isDestroyed()) win.webContents.send(channel, data);
    } catch {}
  });
}

function currentVersion() {
  return app.isPackaged ? app.getVersion() : require("../package.json").version;
}

function isNewer(remote, local) {
  // Strip v prefix and pre-release suffix (e.g. "1.0.0-beta.1" → "1.0.0")
  const parse = (v) => v.replace(/^v/, "").replace(/-.+$/, "").split(".").map(Number);
  const r = parse(remote);
  const l = parse(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

async function checkForUpdate() {
  const release = await fetchJSON(RELEASES_URL);
  const remoteVersion = release.tag_name.replace(/^v/, "");
  const localVersion = currentVersion();

  if (isNewer(remoteVersion, localVersion)) {
    _updateInfo = {
      version: remoteVersion,
      tag: release.tag_name,
      url: release.html_url,
    };
    broadcast("update-available", _updateInfo);
    return { available: true, version: remoteVersion };
  }

  _updateInfo = null;
  return { available: false };
}

function loadAutoUpdater() {
  if (_autoUpdater) return _autoUpdater;
  try {
    _autoUpdater = require("electron-updater").autoUpdater;
    _autoUpdater.autoDownload = false;
    _autoUpdater.autoInstallOnAppQuit = false;

    _autoUpdater.on("download-progress", (progress) => {
      broadcast("update-download-progress", {
        percent: Math.round(progress.percent),
        transferred: (progress.transferred / 1048576).toFixed(1),
        total: (progress.total / 1048576).toFixed(1),
      });
    });

    _autoUpdater.on("update-downloaded", () => {
      broadcast("update-downloaded", _updateInfo);
    });

    _autoUpdater.on("error", (err) => {
      broadcast("update-error", { message: err.message });
    });

    return _autoUpdater;
  } catch {
    return null;
  }
}

function register() {
  ipcMain.handle("check-for-update", async () => {
    try {
      return await checkForUpdate();
    } catch (err) {
      return { available: false, error: err.message };
    }
  });

  ipcMain.handle("download-update", async () => {
    if (!_updateInfo) {
      broadcast("update-error", { message: "No update available. Try checking for updates first." });
      return;
    }
    if (!app.isPackaged) {
      shell.openExternal(_updateInfo.url);
      return;
    }
    const updater = loadAutoUpdater();
    if (updater) {
      await updater.checkForUpdates();
      await updater.downloadUpdate();
    } else {
      shell.openExternal(_updateInfo.url);
    }
  });

  ipcMain.handle("install-update", () => {
    const updater = loadAutoUpdater();
    if (updater) {
      updater.quitAndInstall(false, true);
    }
  });

  ipcMain.handle("get-pending-update", () => _updateInfo);

  // Check on startup if auto-update is enabled
  if (settings.get("autoUpdate") !== false) {
    setTimeout(() => checkForUpdate().catch(() => {}), 5000);
  }
}

module.exports = { register };
