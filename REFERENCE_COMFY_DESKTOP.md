# Reference: Legacy Desktop (Comfy-Org/desktop) Architecture

> **This document is a reference analysis of [Comfy-Org/desktop](https://github.com/Comfy-Org/desktop), the Legacy Desktop app.**
> It does NOT describe how ComfyUI Desktop 2.0 works. It exists solely as prior art for design decisions.
> For ComfyUI Desktop 2.0's own architecture, see [DESIGN_PROCESS.md](./DESIGN_PROCESS.md).

## Auto-Update System

Legacy Desktop uses **ToDesktop** (a commercial Electron distribution service) instead of electron-updater or direct GitHub Releases.

### Initialization (`src/main-process/comfyDesktopApp.ts`)

```typescript
todesktop.init({
  autoCheckInterval: 60 * 60 * 1000, // every hour
  customLogger: log,
  updateReadyAction: { showInstallAndRestartPrompt: 'always', showNotification: 'always' },
  autoUpdater: useComfySettings().get('Comfy-Desktop.AutoUpdate'),
});
```

- Checks for updates every 60 minutes
- User can disable via `Comfy-Desktop.AutoUpdate` setting (default: `true`)
- Update server: `updater.comfy.org` (configured in `todesktop.json`)

### IPC Handlers (`src/handlers/AppHandlers.ts`)

- `CHECK_FOR_UPDATES` — calls `todesktop.autoUpdater.checkForUpdates()`, returns `{ isUpdateAvailable, version }`
- `RESTART_AND_INSTALL` — calls `todesktop.autoUpdater.restartAndInstall()`

### Package Updates (separate from app updates)

During startup validation, the app also checks if installed Python packages need updates:

```typescript
if (installation.needsRequirementsUpdate) await this.updatePackages(installation);
```

This loads a dedicated `desktop-update` page while packages install — separate from the app binary update flow.

### Dependencies

```json
{
  "@todesktop/runtime": "^1.6.4",
  "@todesktop/cli": "^1.15.2",
  "electron-log": "^5.2.0",
  "electron-store": "8.2.0"
}
```

## Comparison with Desktop 2.0

| Feature | Legacy Desktop | Desktop 2.0 |
|---|---|---|
| Update source | `updater.comfy.org` (proprietary) | GitHub Releases API |
| Check frequency | Auto every 60 min | On startup + manual |
| UI/notifications | ToDesktop SDK handles it | Custom update banner |
| Download + install | ToDesktop manages everything | electron-updater + browser fallback |
| Cost | Requires ToDesktop subscription | Free (GitHub Releases) |
| Control | Limited to ToDesktop's API | Full control over update logic |

## Installation Architecture

Legacy Desktop uses `uv` for Python/venv management:

```typescript
// src/install/installationManager.ts
await this.virtualEnvironment.create();  // uv venv
await this.virtualEnvironment.install(); // uv pip install
```

- Python is managed by `uv` (downloaded and cached)
- ComfyUI is cloned via git
- Requirements installed from `requirements.txt`
- Separate from the Electron app update — handles ComfyUI core + manager packages

## Key Takeaways for Desktop 2.0

1. **Separating app updates from ComfyUI updates** — Legacy Desktop treats these as independent concerns. Desktop 2.0 should do the same (app update via GitHub Releases, ComfyUI source update via git pull or re-download).
2. **User control over auto-update** — Both apps let users disable auto-update checks.
3. **Package update UI** — Legacy Desktop shows a dedicated page during package updates, keeping the user informed. Worth considering for Desktop 2.0's install/update progress views.
