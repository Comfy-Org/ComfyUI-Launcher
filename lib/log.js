/**
 * Structured logging via electron-log.
 *
 * PoC for Proposal #11 — demonstrates electron-log configuration
 * alongside the existing console.log/console.error usage.
 *
 * Usage (main process):
 *   const log = require('./lib/log');
 *   log.info('App started');
 *
 *   const installerLog = log.scope('installer');
 *   installerLog.info('Installing to %s', dir);
 *
 * Usage (startup — call once in main.js):
 *   const log = require('./lib/log');
 *   log.initialize();                    // enables renderer → main IPC
 *   log.errorHandler.startCatching();    // catch uncaught exceptions
 *   log.eventLogger.startLogging();      // log Electron crash events
 */

const log = require("electron-log/main");
const path = require("path");

// On Linux, write logs to XDG_STATE_HOME (or ~/.local/state) instead of
// ~/.config, matching the convention in lib/paths.js stateDir().
// On macOS/Windows, electron-log's defaults are already correct:
//   macOS:   ~/Library/Logs/{app name}/main.log
//   Windows: %APPDATA%/{app name}/logs/main.log
if (process.platform === "linux") {
  const APP_NAME = "comfyui-launcher";
  log.transports.file.resolvePathFn = () => {
    const base =
      process.env.XDG_STATE_HOME ||
      path.join(require("os").homedir(), ".local", "state");
    return path.join(base, APP_NAME, "logs", "main.log");
  };
}

// File transport: rotate at 1 MB, keep 1 archive
log.transports.file.maxSize = 1024 * 1024; // 1 MB

// Format: [2025-02-19 14:30:00.123] [info] (scope) › message
log.transports.file.format =
  "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope}{text}";

// Console transport: same format for consistency
log.transports.console.format =
  "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope}{text}";

module.exports = log;
