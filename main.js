const { app, BrowserWindow, Tray, Menu, ipcMain } = require("electron");
const path = require("path");
const ipc = require("./lib/ipc");
const updater = require("./lib/updater");
const settings = require("./settings");

const i18n = require("./lib/i18n");

const APP_ICON = path.join(__dirname, "assets", "Comfy_Logo_x256.png");

let launcherWindow = null;
let tray = null;
const comfyWindows = new Map(); // installationId -> BrowserWindow

function createLauncherWindow() {
  launcherWindow = new BrowserWindow({
    width: 1050,
    height: 700,
    minWidth: 650,
    minHeight: 500,
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  launcherWindow.setMenuBarVisibility(false);
  launcherWindow.loadFile("index.html");

  launcherWindow.on("close", (e) => {
    const onClose = settings.get("onLauncherClose") || "tray";
    if (onClose === "tray") {
      e.preventDefault();
      launcherWindow.hide();
      createTray();
      return;
    }
    // Quit mode — confirm if anything is active
    if (ipc.hasActiveOperations()) {
      e.preventDefault();
      if (!launcherWindow.isDestroyed()) {
        launcherWindow.webContents.send("confirm-quit");
      }
      return;
    }
    quitApp();
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: i18n.t("tray.showLauncher"), click: () => showLauncher() },
    { type: "separator" },
    { label: i18n.t("tray.quit"), click: () => quitApp() },
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  if (tray) return;

  tray = new Tray(path.join(__dirname, "assets", "Comfy_Logo_x32.png"));
  tray.setToolTip("ComfyUI Launcher");
  updateTrayMenu();
  tray.on("double-click", () => showLauncher());
}

function showLauncher() {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.show();
    launcherWindow.focus();
  }
}

function quitApp() {
  ipc.cancelAll();
  for (const [id, win] of comfyWindows) {
    if (!win.isDestroyed()) win.destroy();
  }
  comfyWindows.clear();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.exit(0);
}

function onComfyExited({ installationId } = {}) {
  if (installationId) {
    const win = comfyWindows.get(installationId);
    if (win && !win.isDestroyed()) win.destroy();
    comfyWindows.delete(installationId);
  }
}

function onComfyRestarted({ installationId, process: proc } = {}) {
  // Reload the ComfyUI window after the server is back up
  if (!installationId) return;
  const win = comfyWindows.get(installationId);
  if (!win || win.isDestroyed()) return;

  // Find the URL from the window's current URL or stored data
  const currentUrl = win.webContents.getURL();
  if (!currentUrl) return;

  const { waitForPort } = require("./lib/process");
  const url = new URL(currentUrl);
  const port = parseInt(url.port, 10);
  if (!port) return;

  waitForPort(port, "127.0.0.1", { timeoutMs: 120000 })
    .then(() => {
      if (!win.isDestroyed()) {
        win.webContents.stop();
        win.loadURL(currentUrl);
      }
    })
    .catch(() => {});
}

function onStop({ installationId } = {}) {
  if (installationId) {
    const win = comfyWindows.get(installationId);
    if (win && !win.isDestroyed()) win.destroy();
    comfyWindows.delete(installationId);
  } else {
    // Stop all
    for (const [id, win] of comfyWindows) {
      if (!win.isDestroyed()) win.destroy();
    }
    comfyWindows.clear();
  }
}

function onLaunch({ port, url, process: proc, installation, mode }) {
  const comfyUrl = url || `http://127.0.0.1:${port}`;
  const installationId = installation.id;

  if (mode === "console") {
    // Console mode: launcher stays visible, renderer switches to console view
    if (proc) {
      proc.on("exit", () => {
        // Session registry handles state; just clean up window map
        comfyWindows.delete(installationId);
      });
    }
    return;
  }

  // App window mode: launcher stays visible, open ComfyUI in its own window
  const comfyWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: APP_ICON,
    title: installation.name,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: installation.browserPartition === "unique"
        ? `persist:${installation.id}`
        : "persist:shared",
    },
  });
  comfyWindow.setMenuBarVisibility(false);
  comfyWindow.webContents.on("did-create-window", (childWindow) => {
    childWindow.setIcon(APP_ICON);
  });
  comfyWindow.webContents.on("page-title-updated", (e, title) => {
    e.preventDefault();
    comfyWindow.setTitle(`${title} — ${installation.name}`);
  });
  comfyWindow.loadURL(comfyUrl);

  // Reload ComfyUI — stop any in-flight loads first to avoid ERR_ABORTED loops.
  const reloadComfy = () => {
    if (comfyWindow.isDestroyed()) return;
    comfyWindow.webContents.stop();
    comfyWindow.loadURL(comfyUrl);
  };

  // ComfyUI sets a beforeunload handler that silently blocks navigation in
  // Electron. Always allow unload — we manage the process lifecycle.
  comfyWindow.webContents.on("will-prevent-unload", (e) => {
    e.preventDefault();
  });

  // F5 / Ctrl+R refresh
  comfyWindow.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F5" || (input.key === "r" && (input.control || input.meta))) {
      e.preventDefault();
      reloadComfy();
    }
  });

  // When main frame navigation fails (server restarting), retry after a delay.
  let failRetryTimer = null;
  comfyWindow.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || failRetryTimer) return;
    failRetryTimer = setTimeout(() => {
      failRetryTimer = null;
      if (!comfyWindow.isDestroyed()) {
        comfyWindow.loadURL(comfyUrl);
      }
    }, 2000);
  });

  // Recover from renderer crashes
  comfyWindow.webContents.on("render-process-gone", () => {
    reloadComfy();
  });

  // Closing a ComfyUI window stops that instance
  comfyWindow.on("close", (e) => {
    e.preventDefault();
    ipc.stopRunning(installationId);
    comfyWindow.destroy();
  });

  comfyWindow.on("closed", () => {
    comfyWindows.delete(installationId);
  });

  comfyWindows.set(installationId, comfyWindow);

  if (proc) {
    proc.on("exit", () => {
      // Session registry handles state cleanup
    });
  }
}

ipcMain.handle("quit-app", () => quitApp());

ipcMain.handle("focus-comfy-window", (_event, installationId) => {
  const win = comfyWindows.get(installationId);
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return true;
  }
  return false;
});

app.whenReady().then(() => {
  const { migrateXdgPaths } = require("./lib/paths");
  migrateXdgPaths();

  const locale = settings.get("language") || app.getLocale().split("-")[0];
  i18n.init(locale);
  ipc.register({ onLaunch, onStop, onComfyExited, onComfyRestarted, onLocaleChanged: updateTrayMenu });
  updater.register();
  createTray();
  createLauncherWindow();
});

app.on("window-all-closed", () => {
  if (!tray && !ipc.hasRunningSessions()) {
    app.quit();
  }
});
