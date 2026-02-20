# Proposal #11: electron-log + electron-store

## Summary

Replace `console.log`/`console.error` with **electron-log** (structured log levels, automatic file rotation, unified main/renderer logging, crash-report-ready) and replace the hand-rolled JSON persistence in `installations.js` (79 lines) and `settings.js` (67 lines) with **electron-store** (atomic writes, JSON Schema validation, version-gated migrations, optional encryption).

## Motivation

### Current State

**Logging:**
- The codebase has **no structured logging**. Only two `console.error` calls exist in `lib/paths.js` (lines 74, 129).
- No log files are written to disk — if the app crashes, there is no persistent record for debugging.
- No log levels, no scopes, no rotation.

**Data persistence:**
- `settings.js` (67 lines) — synchronous `fs.readFileSync`/`fs.writeFileSync` to `configDir()/settings.json` (line 6, 22, 51). Defaults are merged on every `load()` call (line 22). Side effects: creates model subdirectories and input/output directories on every load (lines 34–45).
- `installations.js` (79 lines) — async `fs.promises.readFile`/`fs.promises.writeFile` to `dataDir()/installations.json` (lines 5, 9, 17). Provides CRUD + reorder + seedDefaults.
- Both use `JSON.stringify(data, null, 2)` for serialization.
- `lib/paths.js` (137 lines) provides XDG-compliant directory helpers and a `migrateXdgPaths()` function called at startup in `main.js` (line 252).

### Problems

1. **No crash diagnostics** — When users report issues, there are no log files to attach. Developers must ask users to reproduce in DevTools.

2. **No atomic writes** — `settings.js` line 51: `fs.writeFileSync(dataPath, JSON.stringify(settings, null, 2))`. If the process is killed mid-write, the JSON file is corrupted. `installations.js` has the same issue with `fs.promises.writeFile` (line 17). Note: `lib/models.js` (lines 71–74) already demonstrates atomic writes via write-to-tmp + rename — proving the pattern is known but inconsistently applied.

3. **No schema validation** — If a user manually edits `settings.json` or a future version changes the settings shape, there's no validation. Invalid values pass silently. For example, `settings.get("onLauncherClose")` (line 33 of `main.js`) falls back to `"tray"` only by coincidence of the `||` operator, not by schema enforcement.

4. **No migration framework** — The existing `migrateXdgPaths()` in `lib/paths.js` handles file-location migration but there's no mechanism for schema/shape migration between app versions. If a new version renames a setting key, old user data breaks silently.

5. **No encryption capability** — If the app ever stores API keys or tokens (e.g., for CivitAI model downloads), they'd be plaintext JSON.

## Proposed Solution

### Tools

| Tool | Version | Purpose |
|------|---------|---------|
| [electron-log](https://github.com/megahertz/electron-log) | `^5.4.3` | Structured logging with file transport, rotation, scopes, and error catching. Requires Electron 13+. |
| [electron-store](https://github.com/sindresorhus/electron-store) | `^8.2.0` | Type-safe config persistence with atomic writes, JSON Schema validation, migrations, optional encryption. **Last CJS-compatible version.** |

**Why electron-log over alternatives:**
- Zero dependencies, 95 kB unpacked
- Built-in file transport with automatic rotation (default: 1 MB x 1 archive)
- Unified main + renderer logging via IPC (call `log.initialize()` in main, logs from renderer are forwarded automatically)
- Electron event logger (`render-process-gone`, `did-fail-load`, etc.) built in
- Scoped loggers for module-level tagging
- 477k weekly downloads, actively maintained

**Why electron-store over alternatives:**
- Atomic writes out of the box (write to temp file, then rename — the same pattern already used manually in `lib/models.js` lines 71–74)
- JSON Schema validation via ajv
- Semver-based migrations
- Optional `encryptionKey` for sensitive values
- `cwd` option allows pointing to custom directories (works with our XDG paths)
- 509k weekly downloads, 5k stars

**Why electron-store v8 (not v9+):**
- v9+ is **ESM-only** and requires Electron 30+
- This project uses **CommonJS** throughout (`require()` in every file)
- v8.2.0 is the last CJS-compatible version and has all the features we need
- When the project migrates to ESM (a separate proposal), electron-store can be upgraded to v11

### Architecture Changes

**Before:**
```
main.js                        -> console.error only (via lib/paths.js)
settings.js                    -> hand-rolled JSON read/write to configDir()
installations.js               -> hand-rolled JSON read/write to dataDir()
lib/paths.js                   -> XDG dirs, migrateXdgPaths()
```

**After (full migration — not this PoC):**
```
lib/log.js                     -> electron-log configuration (NEW)
lib/settings-store.js          -> electron-store for settings (NEW, replaces settings.js)
lib/installations-store.js     -> electron-store for installations (NEW, replaces installations.js)
settings.js                    -> thin wrapper delegating to settings-store (backward-compatible)
installations.js               -> thin wrapper delegating to installations-store (backward-compatible)
```

Log files would be written to:
- **Linux:** `~/.local/state/comfyui-launcher/logs/main.log` (XDG_STATE_HOME)
- **macOS:** `~/Library/Logs/comfyui-launcher/main.log`
- **Windows:** `%APPDATA%/comfyui-launcher/logs/main.log`

### Migration Path

| Step | Description | Effort |
|------|-------------|--------|
| 1 | Install `electron-log@^5.4.3` and `electron-store@^8.2.0` | 5 min |
| 2 | Create `lib/log.js` — configure electron-log with file transport, scopes, error handler | 30 min |
| 3 | Replace `console.error` in `lib/paths.js` (2 call sites) with scoped logger | 5 min |
| 4 | Add `log.initialize()` to `main.js` startup, add `log.eventLogger.startLogging()` | 10 min |
| 5 | Create `lib/settings-store.js` — electron-store with schema matching `settings.js` defaults, `cwd` pointing to `configDir()` | 1 hr |
| 6 | Create migration to import existing `settings.json` into electron-store format | 30 min |
| 7 | Update `settings.js` to delegate to the new store (keep API identical) | 30 min |
| 8 | Create `lib/installations-store.js` — electron-store for installations array | 1 hr |
| 9 | Update `installations.js` to delegate | 30 min |
| 10 | Add logging throughout `lib/ipc.js`, `lib/installer.js`, `lib/process.js` | 1 hr |
| 11 | Test all platforms, verify log rotation, verify atomic writes | 1 hr |
| **Total** | | **~6 hours** |

## Tradeoffs

### Benefits

- **Crash diagnostics** — Persistent log files users can attach to bug reports
- **Data safety** — Atomic writes prevent JSON corruption on crash
- **Schema validation** — Invalid settings rejected at write time with clear errors
- **Version migrations** — Structured way to evolve settings shape across releases
- **Future encryption** — API keys/tokens can be stored encrypted when needed
- **Consistent logging** — Scoped loggers (`log.scope('installer')`) give context to every message
- **Electron event capture** — `render-process-gone`, `did-fail-load` logged automatically

### Costs

- **+2 dependencies** — `electron-log` (0 transitive deps, 95 kB) + `electron-store` (depends on `conf` -> `ajv`, total ~500 kB unpacked)
- **electron-store v8 is pinned** — The last CJS version. Won't receive new features. Upgrade path requires ESM migration first.
- **electron-store migrations are "unsupported"** — The maintainer explicitly states: *"I cannot provide support for this feature. It has some known bugs."* We should keep migrations simple and test them thoroughly.
- **Log file disk usage** — Default rotation is 1 MB x 1 archive = max 2 MB. Configurable but needs monitoring.
- **Learning curve** — Developers need to learn electron-log scopes and electron-store schema format

### Risks

1. **electron-store v8 end-of-life** — No active maintenance. If a critical bug is found, we'd need to fork or migrate to ESM earlier. **Mitigation:** v8 is simple, stable, and widely used. The underlying `conf` package does the heavy lifting.

2. **XDG path mismatch** — electron-store defaults to `app.getPath('userData')`. On Linux, this is `~/.config/comfyui-launcher`, which is our `configDir()`. But `installations.json` lives in `dataDir()` (`~/.local/share/comfyui-launcher`). We must use the `cwd` option to match existing paths. **Mitigation:** electron-store's `cwd` option handles this cleanly.

3. **Settings side effects** — `settings.js` `load()` creates directories on disk (lines 34–45). electron-store doesn't do this — we'd need to keep that logic in a wrapper or a migration hook. **Mitigation:** Keep `settings.js` as a thin wrapper that calls `ensureDirectories()` after loading from the store.

4. **installations.js is array-shaped** — electron-store expects an object at the root. The installations data is an array. **Mitigation:** Store as `{ items: [...] }` and expose the same array API via a wrapper.

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| **winston** | Heavier (30+ deps), not Electron-aware, no built-in renderer->main IPC |
| **pino** | Fast but no built-in file rotation, no Electron IPC transport |
| **conf** (standalone) | electron-store is a thin wrapper around conf with Electron-specific defaults (paths, IPC for renderer). Using conf directly means reimplementing those. |
| **lowdb** | No schema validation, no migrations, no encryption. Basically what we already have but fancier. |
| **Keep hand-rolled + add atomic writes** | Possible (copy the pattern from `lib/models.js` lines 71–74), but doesn't solve schema validation, migrations, or encryption. |
| **electron-store v9+** | ESM-only, requires project-wide ESM migration first. Defer to after ESM proposal lands. |

## Dependencies

**None** — This proposal can be implemented independently. It does not require bundler, TypeScript, or ESM migration.

However, upgrading electron-store from v8 -> v11 **will** depend on the ESM migration proposal.

## PoC Scope

The PoC in this PR demonstrates both tools working **alongside** the existing code without replacing anything:

1. **`lib/log.js`** — electron-log configuration with:
   - File transport (log rotation at 1 MB)
   - Custom resolve path pointing to `stateDir()/logs/main.log` on Linux (XDG-compliant)
   - Error handler for uncaught exceptions
   - Electron event logger
   - Scoped logger factory

2. **`lib/settings-schema.js`** — electron-store schema definition for settings that matches the existing defaults in `settings.js` (lines 10–17), with a migration example

3. Both files are importable but **not wired into the main app** — existing `settings.js` and `installations.js` are untouched.
