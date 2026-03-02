# Electron Window Parity

Tracking feature parity between the Launcher's ComfyUI windows and the Desktop app / browser experience.

## Completed

- [x] **External links → system browser** — `setWindowOpenHandler` opens external URLs via `shell.openExternal` instead of navigating the ComfyUI window away.
- [x] **Auth/checkout popup windows** — Firebase auth (`dreamboothy.firebaseapp.com`) and checkout (`checkout.comfy.org`) open as Electron child windows so OAuth flows work correctly.
- [x] **Right-click context menu** — Native context menu on right-click restoring browser-default behavior: Cut/Copy/Paste/Select All in editable fields, Copy/Select All on text selection, Open Link in Browser + Copy Link Address on links. Labels are localized via `i18n.t()`.

- [x] **Single instance lock** — `app.requestSingleInstanceLock()` prevents multiple Launcher instances (which would conflict on shared settings, window state, and download temp files). Second launch focuses the existing window. Disabled in dev mode via `app.isPackaged` check.
- [x] **Window state persistence** — Saves size/position/maximized per installation ID to `window-state.json`. Uses in-memory cache with debounced flush (500ms). Multi-monitor aware via `screen.getDisplayMatching()`.
- [x] **Background color** — `backgroundColor: '#171717'` prevents white flash while ComfyUI loads.

## TODO

- [ ] **Context menu review** — Review the browser right-click context menu against a standard browser's behavior and the desktop app's behavior. Identify any additional actions to include (e.g. image handling, undo/redo) to match the experience of using a normal browser, while ensuring parity with what the desktop app supports.
- [ ] **Download management** — Handle `will-download` session events so model downloads work. Desktop app has a full `DownloadManager` with progress reporting, pause/resume, and path validation. The Launcher needs to replicate downloading to a specific directory based on the download link/HTML element on the page (e.g. model download buttons that encode the target subdirectory).
- [ ] **Delete model** — Desktop exposes a `deleteModel` IPC handler that removes downloaded model files. The Launcher's download manager does not yet support deletion.
- [ ] **Open folders** — Desktop exposes IPC helpers (`openModelsFolder`, `openOutputsFolder`, `openLogsFolder`, etc.) that open directories via `shell.openPath`. The Launcher could surface these for ComfyUI installations.
- [ ] **Network connectivity check** — Desktop has a `canAccessUrl` IPC handler to test URL reachability (useful for proxy/firewall diagnostics).
- [ ] **Theme/titlebar overlay** — Desktop supports custom titlebar styling on Windows/Linux via `CHANGE_THEME` IPC, syncing the Window Controls Overlay colors with ComfyUI's theme. Lower priority cosmetic feature.

## Development Mode

- [ ] **Dev-mode popup prefixes** — Add a development mode toggle (e.g., env var or settings flag) that includes dev/staging URLs in the popup allow-list (e.g., `dreamboothy-dev.firebaseapp.com`). Currently only production URLs are whitelisted.
- [ ] **Dev tools / debug helpers** — Consider a general dev-mode flag that enables: dev popup prefixes, DevTools auto-open, verbose logging, etc.
