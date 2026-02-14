const { app, BrowserWindow, Tray, Menu } = require("electron");
const path = require("path");
const ipc = require("./lib/ipc");
const updater = require("./lib/updater");
const settings = require("./settings");
const { killProcessTree } = require("./lib/process");

const APP_ICON = path.join(__dirname, "assets", "Comfy_Logo_x256.png");

let launcherWindow = null;
let comfyWindow = null;
let tray = null;
let comfyProcess = null;

function createLauncherWindow() {
  launcherWindow = new BrowserWindow({
    width: 750,
    height: 500,
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
    if (comfyProcess) {
      killProcessTree(comfyProcess);
      comfyProcess = null;
    }
  });
}

function createTray(installationName) {
  if (tray) return;

  tray = new Tray(path.join(__dirname, "assets", "Comfy_Logo_x32.png"));
  tray.setToolTip(`ComfyUI — ${installationName}`);

  const contextMenu = Menu.buildFromTemplate([
    { label: "Show ComfyUI", click: () => showComfyWindow() },
    { type: "separator" },
    { label: "Stop and Return to Launcher", click: () => stopComfyUI() },
    { label: "Quit", click: () => quitApp() },
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

function stopComfyUI() {
  ipc.notifyStopped();
  if (comfyProcess) {
    killProcessTree(comfyProcess);
    comfyProcess = null;
  }
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
  if (comfyProcess) {
    killProcessTree(comfyProcess);
    comfyProcess = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.exit(0);
}

function onLaunch({ port, url, process: proc, installation, mode }) {
  comfyProcess = proc;
  const comfyUrl = url || `http://127.0.0.1:${port}`;

  if (mode === "console") {
    // Console mode: launcher stays visible, renderer switches to console view
    if (proc) {
      proc.on("exit", () => {
        if (comfyProcess === proc) {
          comfyProcess = null;
        }
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

  comfyWindow.on("close", (e) => {
    if (!proc && !comfyWindow) return;
    e.preventDefault();
    const behavior = proc ? (settings.get("onComfyClose") || "tray") : "launcher";
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

  if (proc && (settings.get("onComfyClose") || "tray") === "tray") {
    createTray(installation.name);
  }

  if (proc) {
    proc.on("exit", () => {
      if (comfyProcess === proc) {
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
    });
  }
}

app.whenReady().then(() => {
  ipc.register({ onLaunch, onStop: stopComfyUI });
  updater.register();
  createLauncherWindow();
});

app.on("window-all-closed", () => {
  // Don't quit if ComfyUI is still running (tray mode or console mode)
  if (!tray && !comfyProcess) {
    app.quit();
  }
});
