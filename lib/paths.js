const { app } = require("electron");
const path = require("path");
const fs = require("fs");

const isLinux = process.platform === "linux";

const APP_NAME = "comfyui-launcher";

/**
 * XDG-compliant directory helpers for Linux.
 * On other platforms, falls back to Electron's userData path.
 *
 * XDG Base Directory Specification:
 *   XDG_CONFIG_HOME → ~/.config       (config files like settings.json)
 *   XDG_CACHE_HOME  → ~/.cache        (non-essential cached data like download-cache)
 *   XDG_DATA_HOME   → ~/.local/share  (persistent data like installations.json)
 *   XDG_STATE_HOME  → ~/.local/state  (runtime state like port-locks)
 */

function configDir() {
  if (isLinux) {
    const base = process.env.XDG_CONFIG_HOME || path.join(app.getPath("home"), ".config");
    return path.join(base, APP_NAME);
  }
  return app.getPath("userData");
}

function cacheDir() {
  if (isLinux) {
    const base = process.env.XDG_CACHE_HOME || path.join(app.getPath("home"), ".cache");
    return path.join(base, APP_NAME);
  }
  return app.getPath("userData");
}

function dataDir() {
  if (isLinux) {
    const base = process.env.XDG_DATA_HOME || path.join(app.getPath("home"), ".local", "share");
    return path.join(base, APP_NAME);
  }
  return app.getPath("userData");
}

function stateDir() {
  if (isLinux) {
    const base = process.env.XDG_STATE_HOME || path.join(app.getPath("home"), ".local", "state");
    return path.join(base, APP_NAME);
  }
  return app.getPath("userData");
}

function defaultInstallDir() {
  return path.join(app.getPath("home"), "ComfyUI-Installs");
}

/**
 * Migrate a file or directory from an old location to a new one.
 * Only migrates if the old path exists and the new path does not.
 * Uses copy+delete instead of rename to handle cross-filesystem moves.
 */
function migrateIfNeeded(oldPath, newPath) {
  try {
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      const stat = fs.statSync(oldPath);
      if (stat.isDirectory()) {
        fs.cpSync(oldPath, newPath, { recursive: true });
      } else {
        fs.copyFileSync(oldPath, newPath);
      }
      fs.rmSync(oldPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`XDG migration failed: ${oldPath} → ${newPath}:`, err.message);
  }
}

/**
 * Run all XDG migrations on Linux. Call once at startup.
 * Moves files from the old ~/.config/comfyui-launcher location to proper XDG dirs.
 */
function migrateXdgPaths() {
  if (!isLinux) return;
  const oldBase = app.getPath("userData"); // ~/.config/comfyui-launcher

  // Cache: download-cache → XDG_CACHE_HOME
  migrateIfNeeded(
    path.join(oldBase, "download-cache"),
    path.join(cacheDir(), "download-cache")
  );

  // Data: installations.json → XDG_DATA_HOME
  migrateIfNeeded(
    path.join(oldBase, "installations.json"),
    path.join(dataDir(), "installations.json")
  );

  // Data: shared_model_paths.yaml → XDG_DATA_HOME
  migrateIfNeeded(
    path.join(oldBase, "shared_model_paths.yaml"),
    path.join(dataDir(), "shared_model_paths.yaml")
  );

  // State: port-locks → XDG_STATE_HOME
  migrateIfNeeded(
    path.join(oldBase, "port-locks"),
    path.join(stateDir(), "port-locks")
  );

  // Fix stale cacheDir in settings.json if it still points to the old default
  migrateCacheDirSetting(oldBase);
}

/**
 * If settings.json has a cacheDir pointing to the old default location,
 * remove it so the new XDG default takes effect.
 */
function migrateCacheDirSetting(oldBase) {
  const settingsPath = path.join(configDir(), "settings.json");
  try {
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const oldDefault = path.join(oldBase, "download-cache");
    if (settings.cacheDir && path.resolve(settings.cacheDir) === path.resolve(oldDefault)) {
      delete settings.cacheDir;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  } catch (err) {
    console.error("Failed to migrate cacheDir setting:", err.message);
  }
}

function homeDir() {
  return app.getPath("home");
}

module.exports = { configDir, cacheDir, dataDir, stateDir, defaultInstallDir, homeDir, migrateXdgPaths };
