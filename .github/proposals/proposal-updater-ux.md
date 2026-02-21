# Proposal 14: electron-updater UX Improvements

## Summary

Improve the auto-update experience in ComfyUI-Launcher by adding update channel support (stable/beta), rich download progress UI with speed and ETA, release notes display, and laying groundwork for differential updates and rollback capability.

## Current State

### Update Flow (Today)

```
┌──────────────────────────────────────────────────────────┐
│  App Startup                                             │
│  └─ settings.autoUpdate !== false?                       │
│     └─ setTimeout(checkForUpdate, 5000)                  │
│        └─ fetch GitHub API /releases/latest              │
│           └─ isNewer(remote, local)?                     │
│              └─ broadcast("update-available", {version}) │
│                 └─ Banner: "Update v{x} available"       │
│                    ├─ [Download] → electron-updater       │
│                    │   └─ download-progress → banner %    │
│                    │   └─ update-downloaded → banner      │
│                    │      └─ [Restart & Update]           │
│                    │         └─ quitAndInstall()          │
│                    └─ [Dismiss] → hide banner             │
└──────────────────────────────────────────────────────────┘
```

### Files Involved

| File | Role |
|------|------|
| `lib/updater.js` (127 lines) | Main-process update logic: GitHub API check, electron-updater lazy-load, IPC handlers, download-progress broadcast |
| `renderer/update-banner.js` (97 lines) | Renderer UI: state machine (`available` → `downloading` → `ready` → `error`), DOM manipulation for banner |
| `preload.js` (lines 83–106) | IPC bridge: `checkForUpdate`, `downloadUpdate`, `installUpdate`, `getPendingUpdate`, 4 event listeners |
| `package.json` (line 32–35) | publish config: `provider: "github"`, `owner: "Kosinkadink"`, `repo: "ComfyUI-Launcher"` |
| `locales/en.json` (lines 153–165) | 10 update-related i18n keys |
| `renderer/styles.css` (lines 733–746) | `.update-banner` flex layout styling |
| `index.html` (line 94) | `<div id="update-banner">` placement at bottom of list view |

### Current Limitations

1. **No differential updates** — Users re-download the full binary (~80–120 MB) on every update. electron-builder *does* generate `.blockmap` files that enable differential downloads, but the current code uses a manual GitHub API check (`lib/updater.js:38`) before lazily loading `electron-updater` (`lib/updater.js:56–83`). The electron-updater is only used for the actual download, meaning differential support may already partially work if blockmap files are published alongside releases.

2. **No rollback** — `quitAndInstall(false, true)` at line 115 replaces the current version. If the update is broken, users must manually download an older release from GitHub.

3. **Minimal progress UI** — The banner shows `transferred / total MB (percent%)` (`update-banner.js:64`) but no download speed, no ETA, no progress bar.

4. **No update channels** — The updater hardcodes `/releases/latest` (`updater.js:6`), so there's no way for users to opt into beta releases. Pre-release versions tagged with `-beta` on GitHub are invisible.

5. **No release notes** — The update banner shows only the version number. The GitHub release body (changelog) is fetched but discarded — only `tag_name` and `html_url` are kept (`updater.js:39–47`).

6. **No version comparison** — Users see "Update available: v{x}" but not what version they're currently on, making the upgrade delta unclear.

## Proposed Changes

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  App Startup                                                 │
│  └─ settings.autoUpdate !== false?                           │
│     └─ setTimeout(checkForUpdate, 5000)                      │
│        └─ settings.updateChannel → "stable" | "beta"         │
│           ├─ stable: fetch /releases/latest                  │
│           └─ beta:   fetch /releases (find first incl. pre)  │
│              └─ isNewer(remote, local)?                       │
│                 └─ broadcast("update-available", {            │
│                      version, currentVersion,                │
│                      releaseNotes, releaseDate, channel       │
│                    })                                         │
│                    └─ Enhanced Banner:                        │
│                       ├─ "v{current} → v{new} (beta)"        │
│                       ├─ [View Release Notes] → modal        │
│                       ├─ [Download] → progress bar + speed   │
│                       │   └─ download-progress:              │
│                       │      { percent, transferred, total,  │
│                       │        bytesPerSecond, eta }          │
│                       └─ [Dismiss]                            │
└──────────────────────────────────────────────────────────────┘
```

### 1. Update Channel Support (Stable/Beta)

**What changes:**
- `lib/updater.js`: Add `settings.get("updateChannel")` check; when `"beta"`, fetch `/releases` (all releases) and pick the first that includes pre-releases.
- `lib/ipc.js` (settings sections): Add an `updateChannel` select field with `stable` / `beta` options.
- `locales/en.json`: Add `settings.updateChannel`, `settings.channelStable`, `settings.channelBeta` keys.
- Configure `autoUpdater.channel` and `autoUpdater.allowPrerelease` when `loadAutoUpdater()` is called.

**electron-updater native support:**
```js
autoUpdater.channel = "beta";      // Reads beta.yml instead of latest.yml
autoUpdater.allowPrerelease = true; // Accept pre-release versions
```

**Build-side requirement:** Add `"generateUpdatesFilesForAllChannels": true` to `build` config in `package.json` so electron-builder produces both `latest.yml` and `beta.yml`.

**Tradeoffs:**
- ✅ Zero new dependencies
- ✅ Users can opt-in/out at any time via Settings
- ⚠️ Requires the release workflow to tag beta versions with `-beta` suffix
- ⚠️ GitHub Releases must mark betas as "pre-release" for the API filter to work

### 2. Enhanced Update Banner with Progress

**What changes:**
- `renderer/update-banner.js`: Enhance `_showAvailable` to show `v{current} → v{new}`, add "Release Notes" button. Enhance `_showDownloading` with a `<progress>` bar, speed display, and ETA.
- `lib/updater.js`: Include `bytesPerSecond` in download-progress broadcast (already available from electron-updater's `ProgressInfo`). Include `releaseNotes` and `releaseDate` in `_updateInfo`. Compute and broadcast ETA.
- `renderer/styles.css`: Add styles for progress bar and release notes display.
- `locales/en.json`: Add keys for speed, ETA, release notes, version comparison.

**Tradeoffs:**
- ✅ Better user experience during long downloads
- ✅ Minimal code change (~30 lines renderer, ~10 lines main)
- ⚠️ ETA accuracy depends on download speed stability

### 3. Release Notes Display

**What changes:**
- `lib/updater.js`: Capture `release.body` (markdown) from GitHub API response and include in `_updateInfo`.
- `renderer/update-banner.js`: Add "Release Notes" button that opens a modal with the changelog.
- Use existing `window.Launcher.modal.alert()` for display.

**Tradeoffs:**
- ✅ Users can make informed update decisions
- ✅ Uses existing modal infrastructure
- ⚠️ GitHub release body is raw markdown; rendering as plain text with basic formatting is sufficient for PoC

### 4. Differential Updates (Analysis Only)

**Current status:** electron-builder already generates `.blockmap` files during the build. electron-updater automatically uses these for differential downloads when both the old and new version blockmap files are available.

**What's needed for this to work:**
1. The `.blockmap` files must be published alongside the release binaries on GitHub Releases
2. The `updaterCacheDirName` should be configured so electron-updater can cache the current installer for future diffs
3. The current `checkForUpdate()` manual GitHub API call needs to be reconciled with electron-updater's own check (currently `loadAutoUpdater()` calls `updater.checkForUpdates()` *again* at line 105)

**Assessment:** Differential updates likely *already partially work* on Windows (NSIS target) if blockmap files are published. The double-check (manual API + electron-updater's own check) is redundant but not harmful. Full verification requires a test release cycle.

**This proposal does NOT change the differential update mechanism** — it only documents the current state and recommends ensuring blockmap files are published.

### 5. Rollback Capability (Future)

**Approach options:**

| Approach | Effort | UX | Risk |
|----------|--------|-----|------|
| A. Keep previous installer in cache dir | Low | User runs cached installer manually | Low |
| B. NSIS `/ROLLBACK` custom page | Medium | Integrated rollback UI | Medium — NSIS customization |
| C. Side-by-side versioned installs | High | Version picker in launcher | High — significant arch change |

**Recommendation:** Option A for v1. Before `quitAndInstall()`, copy the current app binary to a `previous-versions/` directory. Add a "Rollback" button in Settings that opens this directory.

**This proposal includes:** A setting and documentation placeholder. Actual rollback implementation is deferred to a follow-up.

## PoC Scope

The proof-of-concept in this PR demonstrates:

1. ✅ **Update channel setting** — `updateChannel` select in Settings (stable/beta)
2. ✅ **Channel-aware update check** — respects `updateChannel` when fetching releases
3. ✅ **Enhanced banner** — version comparison (`v{current} → v{new}`), progress bar with speed/ETA
4. ✅ **Release notes** — captured from GitHub API, viewable via modal
5. ✅ **`generateUpdatesFilesForAllChannels`** — build config for multi-channel support
6. ❌ **Differential updates** — no code changes (already supported by electron-builder)
7. ❌ **Rollback** — documented approach only, deferred

## Files Changed

| File | Change |
|------|--------|
| `lib/updater.js` | Channel-aware check, enriched update info, enhanced progress data |
| `renderer/update-banner.js` | Progress bar, speed/ETA, release notes button, version comparison |
| `renderer/styles.css` | Progress bar and release notes styling |
| `locales/en.json` | New i18n keys for channels, release notes, speed, ETA |
| `package.json` | `generateUpdatesFilesForAllChannels: true` in build config |
| `lib/ipc.js` | `updateChannel` setting field in settings sections |
| `.github/proposals/proposal-updater-ux.md` | This document |

## Risks & Open Questions

1. **GitHub API rate limiting** — Fetching `/releases` (all releases) for beta channel returns more data than `/releases/latest`. The `User-Agent` header is already set. Rate limit is 60 req/hour for unauthenticated requests; update checks happen at most once per app launch.

2. **Blockmap reliability** — Stack Overflow reports suggest blockmap differential updates can still download significant portions (50–70%) due to how NSIS executables embed version metadata. The `shortVersion`/`shortVersionWindows` config can help.

3. **Beta channel UX** — Users who switch from beta to stable may have a newer version than latest stable. `allowDowngrade` (auto-set when `generateUpdatesFilesForAllChannels` is true) handles this, but the UX of "downgrading" needs thought.

4. **Release workflow dependency** — Update channels require the CI/CD workflow to properly tag versions with `-beta` suffix and mark them as pre-releases on GitHub.

## References

- [electron-builder Auto Update docs](https://www.electron.build/auto-update.html)
- [Release Using Channels tutorial](https://www.electron.build/tutorials/release-using-channels.html)
- [electron-builder blockmap issue #2851](https://github.com/electron-userland/electron-builder/issues/2851)
- [electron-builder differential updates #9498](https://github.com/electron-userland/electron-builder/issues/9498)
- [Staged rollouts docs](https://www.electron.build/auto-update.html#staged-rollouts)
