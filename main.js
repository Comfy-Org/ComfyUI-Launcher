const { app, BrowserWindow, Tray, Menu } = require("electron");
const path = require("path");
const ipc = require("./lib/ipc");
const updater = require("./lib/updater");
const settings = require("./settings");

const i18n = require("./lib/i18n");

const APP_ICON = path.join(__dirname, "assets", "Comfy_Logo_x256.png");

let launcherWindow = null;
let comfyWindow = null;
let tray = null;
let comfyProcess = null;

function createLauncherWindow() {
  launcherWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 550,
    minHeight: 400,
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  launcherWindow.setMenuBarVisibility(false);
  launcherWindow.loadFile("index.html");

  launcherWindow.on("close", () => {
    comfyProcess = null;
    ipc.stopRunning();
  });
}

function createTray(installationName) {
  if (tray) return;

  tray = new Tray(path.join(__dirname, "assets", "Comfy_Logo_x32.png"));
  tray.setToolTip(`ComfyUI — ${installationName}`);

  const contextMenu = Menu.buildFromTemplate([
    { label: i18n.t("tray.showComfyUI"), click: () => showComfyWindow() },
    { type: "separator" },
    { label: i18n.t("tray.stopReturn"), click: () => stopComfyUI() },
    { label: i18n.t("tray.quit"), click: () => quitApp() },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => showComfyWindow());
}

function showComfyWindow() {
  if (comfyWindow && !comfyWindow.isDestroyed()) {
    comfyWindow.show();
    comfyWindow.focus();
  }
}

async function stopComfyUI() {
  comfyProcess = null;
  await ipc.stopRunning();
  if (comfyWindow && !comfyWindow.isDestroyed()) {
    comfyWindow.destroy();
    comfyWindow = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.show();
    launcherWindow.focus();
  }
}

function quitApp() {
  comfyProcess = null;
  ipc.stopRunning();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.exit(0);
}

function onComfyExited() {
  comfyProcess = null;
  if (comfyWindow && !comfyWindow.isDestroyed()) {
    comfyWindow.destroy();
    comfyWindow = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.show();
    launcherWindow.focus();
  }
}

let _comfyUrl = null;
let _comfyPort = null;

function onComfyRestarted({ process: proc } = {}) {
  comfyProcess = proc || null;
  // Reload the ComfyUI window after the server is back up
  if (comfyWindow && !comfyWindow.isDestroyed() && _comfyPort) {
    const { waitForPort } = require("./lib/process");
    waitForPort(_comfyPort, "127.0.0.1", { timeoutMs: 120000 })
      .then(() => {
        if (!comfyWindow || comfyWindow.isDestroyed()) return;
        comfyWindow.webContents.stop();
        comfyWindow.loadURL(_comfyUrl);
      })
      .catch(() => {});
  }
}

function onLaunch({ port, url, process: proc, installation, mode }) {
  comfyProcess = proc;
  const comfyUrl = url || `http://127.0.0.1:${port}`;
  _comfyUrl = comfyUrl;
  _comfyPort = port;

  if (mode === "console") {
    // Console mode: launcher stays visible, renderer switches to console view
    if (proc) {
      proc.on("exit", () => {
        if (comfyProcess === proc) comfyProcess = null;
      });
    }
    return;
  }

  // App window mode: hide launcher, open ComfyUI in an embedded window
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.hide();
  }

  comfyWindow = new BrowserWindow({
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
    if (!comfyWindow || comfyWindow.isDestroyed()) return;
    comfyWindow.webContents.stop();
    comfyWindow.loadURL(comfyUrl);
  };

  // ComfyUI sets a beforeunload handler that silently blocks navigation in
  // Electron. Always allow unload — we manage the process lifecycle.
  comfyWindow.webContents.on("will-prevent-unload", (e) => {
    e.preventDefault();
  });

  // F5 / Ctrl+R refresh — handled at the webContents level so it only
  // fires when this window is focused (unlike globalShortcut).
  comfyWindow.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F5" || (input.key === "r" && (input.control || input.meta))) {
      e.preventDefault();
      reloadComfy();
    }
  });

  // When main frame navigation fails (server restarting), retry after a delay.
  // Ignore ERR_ABORTED (-3) which fires when a navigation is superseded.
  let failRetryTimer = null;
  comfyWindow.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || failRetryTimer) return;
    failRetryTimer = setTimeout(() => {
      failRetryTimer = null;
      if (comfyWindow && !comfyWindow.isDestroyed()) {
        comfyWindow.loadURL(comfyUrl);
      }
    }, 2000);
  });

  // Recover from renderer crashes
  comfyWindow.webContents.on("render-process-gone", () => {
    reloadComfy();
  });

  comfyWindow.on("close", (e) => {
    e.preventDefault();
    const behavior = settings.get("onComfyClose") || "tray";
    if (behavior === "tray") {
      comfyWindow.hide();
    } else if (behavior === "launcher") {
      stopComfyUI();
    } else if (behavior === "quit") {
      quitApp();
    }
  });

  comfyWindow.on("closed", () => {
    comfyWindow = null;
  });

  if ((settings.get("onComfyClose") || "tray") === "tray") {
    createTray(installation.name);
  }

  if (proc) {
    proc.on("exit", () => {
      if (comfyProcess === proc) comfyProcess = null;
    });
  }
}

app.whenReady().then(() => {
  const { migrateXdgPaths } = require("./lib/paths");
  migrateXdgPaths();

  const locale = settings.get("language") || app.getLocale().split("-")[0];
  i18n.init(locale);
  ipc.register({ onLaunch, onStop: stopComfyUI, onComfyExited: onComfyExited, onComfyRestarted: onComfyRestarted });
  updater.register();
  createLauncherWindow();
});

app.on("window-all-closed", () => {
  // Don't quit if ComfyUI is still running (tray mode or console mode)
  if (!tray && !comfyProcess && !ipc.getRunningPort()) {
    app.quit();
  }
});
