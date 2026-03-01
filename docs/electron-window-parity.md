# Electron Window Parity

Tracking feature parity between the Launcher's ComfyUI windows and the Desktop app / browser experience.

## Completed

- [x] **External links → system browser** — `setWindowOpenHandler` opens external URLs via `shell.openExternal` instead of navigating the ComfyUI window away.
- [x] **Auth/checkout popup windows** — Firebase auth (`dreamboothy.firebaseapp.com`, `dreamboothy-dev.firebaseapp.com`) and checkout (`checkout.comfy.org`) open as Electron child windows so OAuth flows work correctly.
- [x] **Right-click context menu** — Native context menu on right-click restoring browser-default behavior: Cut/Copy/Paste/Select All in editable fields, Copy/Select All on text selection, Open Link in Browser + Copy Link Address on links. Labels are localized via `i18n.t()`.

## TODO

- [ ] **Context menu review** — Review the browser right-click context menu against a standard browser's behavior and the desktop app's behavior. Identify any additional actions to include (e.g. image handling, undo/redo) to match the experience of using a normal browser, while ensuring parity with what the desktop app supports.
- [ ] **Window state persistence** — Remember window size/position between launches using `electron-store`. Desktop app saves bounds on resize/move and restores on next open.
- [ ] **Background color** — Set `backgroundColor: '#171717'` on the BrowserWindow to prevent white flash while ComfyUI loads.

- [ ] **Download management** — Handle `will-download` session events so model downloads work. Desktop app has a full `DownloadManager` with progress reporting, pause/resume, and path validation. The Launcher needs to replicate downloading to a specific directory based on the download link/HTML element on the page (e.g. model download buttons that encode the target subdirectory).

## Out of Scope (for now)

- **Terminal integration** — Desktop app exposes a terminal via IPC. Not applicable to the Launcher's architecture.
- **Theme/titlebar overlay** — Desktop app supports custom titlebar styling on Windows/Linux. Lower priority cosmetic feature.
