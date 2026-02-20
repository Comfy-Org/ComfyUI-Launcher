import * as path from "path";
import * as fs from "fs";
import * as paths from "./lib/paths";
import { MODEL_FOLDER_TYPES } from "./lib/models";

const dataPath: string = path.join(paths.configDir(), "settings.json");

const SHARED_ROOT: string = path.join(paths.homeDir(), "ComfyUI-Shared");

interface SettingsDefaults {
  cacheDir: string;
  maxCachedFiles: number;
  onLauncherClose: "tray" | "quit";
  modelsDirs: string[];
  inputDir: string;
  outputDir: string;
}

interface Settings extends Record<string, unknown> {
  cacheDir: string;
  maxCachedFiles: number;
  onLauncherClose: "tray" | "quit";
  modelsDirs: string[];
  inputDir: string;
  outputDir: string;
  language?: string;
  theme?: "system" | "dark" | "light";
  autoUpdate?: boolean;
}

const defaults: SettingsDefaults = {
  cacheDir: path.join(paths.cacheDir(), "download-cache"),
  maxCachedFiles: 5,
  onLauncherClose: "tray",
  modelsDirs: [path.join(SHARED_ROOT, "models")],
  inputDir: path.join(SHARED_ROOT, "input"),
  outputDir: path.join(SHARED_ROOT, "output"),
};

function load(): Settings {
  let result: Settings;
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
  } catch {
    // Ignore filesystem errors during directory creation
  }
  // Create shared input/output directories
  try {
    for (const key of ["inputDir", "outputDir"] as const) {
      fs.mkdirSync((result[key] as string) || defaults[key], { recursive: true });
    }
  } catch {
    // Ignore filesystem errors during directory creation
  }
  return result;
}

function save(settings: Settings): void {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(settings, null, 2));
}

function get(key: string): unknown {
  return load()[key];
}

function set(key: string, value: unknown): void {
  const settings = load();
  settings[key] = value;
  save(settings);
}

function getAll(): Settings {
  return load();
}

module.exports = { get, set, getAll, defaults };
