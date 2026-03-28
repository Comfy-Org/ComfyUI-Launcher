# ComfyUI-Manager Restart Handling

ComfyUI-Manager can restart ComfyUI after installing custom node packs. This document describes how the launcher handles that.

## Background

ComfyUI-Manager's restart logic (`rebootAPI()` in `js/common.js`) has three code paths:

1. **`electronAPI` present** — calls `window.electronAPI.restartApp()` immediately, bypassing the user confirmation dialog. The Electron host is responsible for restarting the process.

2. **`__COMFY_CLI_SESSION__` env var set** — the `/manager/reboot` endpoint (after user confirmation) creates a marker file at `$__COMFY_CLI_SESSION__.reboot`, then calls `exit(0)`. The launcher detects the marker and respawns.

3. **Neither present (legacy)** — calls `os.execv()` to replace the current process in-place. This creates an orphaned process that the launcher cannot track. **This path must be avoided.**

## How the Launcher Handles It

### Preventing orphans

When spawning ComfyUI, `src/main/lib/ipc/shared.ts` sets `__COMFY_CLI_SESSION__` in the child process environment (line 365), pointing to a unique temp path. The `.reboot` marker check is at line 371. This ensures Manager never falls through to the `os.execv()` legacy path.

### Why we do NOT inject `electronAPI`

We deliberately do not inject `window.electronAPI` into the ComfyUI BrowserWindow. If we did, Manager would skip its confirmation dialog and call `restartApp()` immediately with no user feedback. Instead, we let Manager use its normal server-side `/manager/reboot` flow:

1. User clicks Restart → Manager shows its confirmation dialog
2. User confirms → Manager calls `/manager/reboot`
3. Server creates `.reboot` marker file and calls `exit(0)`
4. Our exit handler detects the marker and respawns

This preserves Manager's own UX while the launcher handles the process lifecycle correctly.

### Exit handler respawn

`attachExitHandler` in `src/main/lib/ipc/sessionActions/launch.ts` (line 416) runs on every process exit:

1. Checks for the `.reboot` marker file at the session path
2. If found: deletes the marker, respawns ComfyUI with the same command/args/env, reattaches stdout/stderr forwarding, updates `_runningProc`, and calls `onComfyRestarted` with the new process handle
3. If not found: declares the process stopped (`comfy-exited`)

In app window mode, `onComfyRestarted` in `src/main/index.ts` polls `waitForPort` until the new server is ready, then reloads the ComfyUI BrowserWindow URL. The window stays open throughout.

In console mode, the restart message (`"--- ComfyUI restarting ---"`) is written to the terminal via `sendOutput` (the same comfy-output channel as stdout/stderr), so it appears inline in the console view.

### Process cleanup

`stopRunning()` in `src/main/lib/ipc/shared.ts` (line 598) handles both cases — if a tracked process exists, it uses `killProcessTree`; it also calls `killByPort` to catch any process listening on the port. The running state is cleared so the exit handler does not respawn.

## Reference

- ComfyUI-Manager restart logic: `Comfy-Org/ComfyUI-Manager` → `js/common.js` (`rebootAPI`), `glob/manager_server.py` (`/manager/reboot`)
- Comfy-Org/desktop approach: injects `electronAPI` and uses `RESTART_CORE` IPC channel. We chose not to follow this pattern to preserve Manager's confirmation dialog.
