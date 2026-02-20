/**
 * electron-store schema definition for settings.
 *
 * PoC for Proposal #11 — demonstrates electron-store schema + migrations
 * alongside the existing settings.js. This file is NOT wired into the app.
 *
 * The schema mirrors the defaults from settings.js (lines 10–17) with
 * added type validation and a migration example.
 *
 * Usage (when fully integrated):
 *   const Store = require('electron-store');
 *   const { schema, defaults, migrations } = require('./lib/settings-schema');
 *   const store = new Store({ schema, defaults, migrations, name: 'settings', cwd: configDir() });
 */

const path = require("path");

// These match the defaults in settings.js lines 8–17.
// In the full migration, these would be imported from a shared location.
function buildDefaults() {
  // Lazy-require to avoid importing Electron at module load time in tests
  const paths = require("./paths");
  const SHARED_ROOT = path.join(paths.homeDir(), "ComfyUI-Shared");

  return {
    cacheDir: path.join(paths.cacheDir(), "download-cache"),
    maxCachedFiles: 5,
    onLauncherClose: "tray",
    modelsDirs: [path.join(SHARED_ROOT, "models")],
    inputDir: path.join(SHARED_ROOT, "input"),
    outputDir: path.join(SHARED_ROOT, "output"),
  };
}

/**
 * JSON Schema (draft-07, compatible with electron-store v8 / ajv).
 *
 * Each top-level key corresponds to a setting. electron-store validates
 * on every .set() call and throws on violations.
 */
const schema = {
  cacheDir: {
    type: "string",
    description: "Directory for cached downloads",
  },
  maxCachedFiles: {
    type: "number",
    minimum: 0,
    maximum: 100,
    description: "Maximum number of cached download files to keep",
  },
  onLauncherClose: {
    type: "string",
    enum: ["tray", "quit"],
    description: "Behavior when the launcher window is closed",
  },
  modelsDirs: {
    type: "array",
    items: { type: "string" },
    minItems: 1,
    description: "Directories to scan for shared models",
  },
  inputDir: {
    type: "string",
    description: "Shared input directory for ComfyUI instances",
  },
  outputDir: {
    type: "string",
    description: "Shared output directory for ComfyUI instances",
  },
  language: {
    type: "string",
    description: "UI locale override (e.g. 'en', 'ja', 'zh')",
  },
};

/**
 * Semver-gated migrations.
 *
 * These run once when the app version crosses the specified threshold.
 * Example: renaming a setting key between versions.
 *
 * Note: electron-store's migration support is explicitly "unsupported" by the
 * maintainer. Keep migrations simple and well-tested.
 */
const migrations = {
  // Example migration — not needed today, but demonstrates the pattern:
  // '0.2.0': (store) => {
  //   // Rename 'cacheDir' -> 'downloadCacheDir' if the old key exists
  //   if (store.has('cacheDir')) {
  //     store.set('downloadCacheDir', store.get('cacheDir'));
  //     store.delete('cacheDir');
  //   }
  // },
};

module.exports = { schema, buildDefaults, migrations };
