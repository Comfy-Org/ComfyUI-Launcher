const path = require("path");
const fs = require("fs");
const paths = require("./lib/paths");
const { MODEL_FOLDER_TYPES } = require("./lib/models");

const dataPath = path.join(paths.configDir(), "settings.json");

const defaults = {
  cacheDir: path.join(paths.cacheDir(), "download-cache"),
  maxCachedFiles: 5,
  onLauncherClose: "tray",
  modelsDirs: [path.join(paths.homeDir(), "ComfyUI-Models")],
};

function load() {
  let result;
  try {
    result = { ...defaults, ...JSON.parse(fs.readFileSync(dataPath, "utf-8")) };
  } catch {
    result = { ...defaults };
  }
  // Ensure system default directory is always present in modelsDirs
  const systemDefault = defaults.modelsDirs[0];
  if (!Array.isArray(result.modelsDirs)) {
    result.modelsDirs = [systemDefault];
  } else if (!result.modelsDirs.some((d) => path.resolve(d) === path.resolve(systemDefault))) {
    result.modelsDirs.unshift(systemDefault);
  }
  // Create the system default directory and model subdirectories on disk
  try {
    fs.mkdirSync(systemDefault, { recursive: true });
    for (const folder of MODEL_FOLDER_TYPES) {
      fs.mkdirSync(path.join(systemDefault, folder), { recursive: true });
    }
  } catch {}
  return result;
}

function save(settings) {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(settings, null, 2));
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  const settings = load();
  settings[key] = value;
  save(settings);
}

function getAll() {
  return load();
}

module.exports = { get, set, getAll, defaults };
