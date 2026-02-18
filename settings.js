const path = require("path");
const fs = require("fs");
const paths = require("./lib/paths");

const dataPath = path.join(paths.configDir(), "settings.json");

const defaults = {
  cacheDir: path.join(paths.cacheDir(), "download-cache"),
  maxCachedFiles: 8,
  onLauncherClose: "tray",
  modelsDirs: [path.join(paths.homeDir(), "ComfyUI-Models")],
};

function load() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(dataPath, "utf-8")) };
  } catch {
    return { ...defaults };
  }
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
