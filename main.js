const { app, BrowserWindow, Tray, Menu } = require("electron");
const path = require("path");
const ipc = require("./lib/ipc");
const settings = require("./settings");
const { killProcessTree } = require("./lib/process");

const APP_ICON = path.join(__dirname, "assets", "Comfy_Logo_x256.png");

let launcherWindow = null;
let comfyWindow = null;
let tray = null;
let comfyProcess = null;

function createLauncherWindow() {
  launcherWindow = new BrowserWindow({
    width: 600,
    height: 500,
    minWidth: 500,
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

function onLaunch({ port, process: proc, installation, mode }) {
  comfyProcess = proc;

  if (mode === "console") {
    // Console mode: launcher stays visible, renderer switches to console view
    // Process exit is handled by the console view via stop-comfyui IPC
    proc.on("exit", () => {
      if (comfyProcess === proc) {
        comfyProcess = null;
      }
    });
    return;
  }

  // Browser mode: hide launcher, open ComfyUI window
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.hide();
  }

  comfyWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: APP_ICON,
    title: `ComfyUI — ${installation.name}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  comfyWindow.setMenuBarVisibility(false);
  comfyWindow.loadURL(`http://127.0.0.1:${port}`);

  comfyWindow.on("close", (e) => {
    if (!comfyProcess) return;
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

app.whenReady().then(() => {
  ipc.register({ onLaunch, onStop: stopComfyUI });
  createLauncherWindow();
});

app.on("window-all-closed", () => {
  // Don't quit if ComfyUI is still running (tray mode or console mode)
  if (!tray && !comfyProcess) {
    app.quit();
  }
});
