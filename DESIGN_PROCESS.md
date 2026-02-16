# ComfyUI-Launcher Design Process

## Architecture

The codebase is organized into four layers, each with a clear responsibility:

- **Main process entry** — Window lifecycle only. Delegates all IPC to a separate module.
- **`lib/`** — Shared main-process utilities (IPC registration, HTTP helpers, etc.). Houses logic that multiple modules depend on.
- **`sources/`** — One module per install method, plus a registry. Each source is self-contained: it defines its install form, detail view, actions, and data shape.
- **`renderer/`** — One file per view, plus shared UI utilities (helpers, modals, styles). Views are generic and data-driven — they render whatever sources describe.

Supporting files (data store, preload bridge) sit at the root and remain thin pass-throughs with no business logic.

## Design Principles

### 1. Sources own their data and behavior

Each source module (`sources/<name>.js`) defines:
- `id`, `label` — identity (used by ipc.js to inject `sourceId`/`sourceLabel` automatically; sources should not repeat these in `buildInstallation`)
- `fields` — what the new-install form renders
- `getFieldOptions(fieldId, selections)` — populates each field
- `buildInstallation(selections)` — returns source-specific data to persist
- `getListActions(installation)` — defines which action buttons appear on the list card (same schema as detail actions: `id`, `label`, `style`, `enabled`)
- `getDetailSections(installation)` — defines what the detail view shows (info fields, actions)
- `probeInstallation(dirPath)` *(optional)* — examines a directory and returns source-specific metadata if it recognizes the contents (e.g., portable checks for `python_embeded`, git checks for `.git`). Returns `null` if unrecognized. Used by "Track Existing" to auto-detect source type.
- `getSettingsSections(settings)` *(optional)* — defines settings fields for this source. Fields declare `type` (`path`, `number`), `id` (settings key), and current `value`. The renderer builds the form generically.
- `handleAction(actionId, installation)` — executes source-specific actions
- `getLaunchCommand(installation)` — returns `{ cmd, args, cwd, port }` describing how to start this ComfyUI installation, or `null` if launch is not supported. The launcher uses this to spawn the process, poll the port, then open an app window.
- `install(installation, tools)` *(optional)* — performs the actual installation (download, extract, etc.). Receives shared tools `{ sendProgress, download, cache, extract }` from ipc.js rather than importing lib modules directly, keeping sources decoupled from infrastructure.

The renderer never contains source-specific knowledge. If it needs to behave differently per source, that behavior must be declared in the source's data (see principle 3).

Fields support multiple types, each handled generically by the renderer:
- `type: "select"` — dropdown, auto-cascades to load the next field on change.
- `type: "text"` — text input with optional `defaultValue`. Does not auto-cascade. Can declare `action: { label }` to render a button that triggers downstream field loading when clicked. Errors from downstream API calls display beneath the text field.

### 2. One concern per file

- `main.js` does not register IPC handlers — `lib/ipc.js` does.
- `lib/ipc.js` handles IPC only. It may reference `BrowserWindow` when an IPC handler requires a parent window (e.g., native dialogs), but does not manage window lifecycle.
- Each renderer view is its own file.
- Shared utilities (`fetch.js`, `util.js`, `modal.js`) are extracted, not duplicated.

### 3. Behavior through data, not conditionals

The renderer should not hardcode `if (actionId === "remove")` or similar checks. Instead, sources declare behavior via metadata:
- Actions declare `confirm: { title, message }` to trigger a confirmation modal.
- Actions declare `style` (`primary`, `danger`, `default`) for visual treatment.
- Actions declare `enabled` to control availability.
- Actions declare `showProgress: true` and `progressTitle` to route through the progress view for long-running operations.

Detail section fields support `editable: true` with an `id` — the renderer shows an input and auto-saves changes to the installation data via `update-installation` IPC.

Any new behavioral hint should follow this pattern: add a property to the action/section schema, handle it generically in the renderer.

### 4. Use in-app modals, not native dialogs, for messages

Never use `alert()` or other native OS dialogs for user-facing messages. Use `modal.alert()` and `modal.confirm()` from `renderer/modal.js` so the experience stays consistent and themed.

### 5. Common logic lives in lib/ or ipc.js

- `sourceId`/`sourceLabel` injection is done by `ipc.js`, not by each source.
- The `remove` action is handled centrally in `ipc.js` since it's a generic CRUD operation.
- HTTP fetching is in `lib/fetch.js`, not in individual sources.

## Reference: Comfy-Org/desktop

This project aims to eventually replace [Comfy-Org/desktop](https://github.com/Comfy-Org/desktop). Refer to that repo for prior art on features, conventions, and assets. Icons/logos in `assets/` are sourced from `desktop/assets/UI/`.

## Install Methods

Three source modules provide different installation strategies, each targeting different user needs.

### 1. Portable (`sources/portable.js`) — Windows only

Downloads Comfy-Org's official `.7z` portable release, which bundles Python embedded + pre-installed wheels + ComfyUI source in a single archive. Download → extract → run.

- **Platforms:** Windows (NVIDIA, AMD)
- **Pros:** Zero network dependency after initial download; uses official builds
- **Cons:** Windows only; monolithic archive means re-downloading everything for updates
- **Status:** Implemented

### 2. Standalone (`sources/standalone.js`) — Cross-platform

Our own pre-built environment archives. Each archive contains a relocatable Python runtime (from [python-build-standalone](https://github.com/indygreg/python-build-standalone)) with all GPU-specific wheels (PyTorch, etc.) pre-installed. ComfyUI source is cloned via git separately. The result is a single download + extract for the environment, plus a git clone — no pip/uv/network-dependent package installation at install time.

- **Platforms:** Windows (NVIDIA, AMD, Intel), macOS (Apple Silicon), Linux (NVIDIA, AMD, Intel)
- **Pros:** Cross-platform portable install; no pip failures; environment and source are independent; source can be updated via git without re-downloading the environment
- **Cons:** Requires us to build and host environment archives; larger hosting footprint

#### Architecture

```
standalone-install/
├── python/                    # Relocatable Python from python-build-standalone
│   ├── bin/ or python.exe     # Platform-specific Python binary
│   └── lib/site-packages/     # Pre-installed wheels (torch, etc.)
├── ComfyUI/                   # Cloned from GitHub
│   ├── main.py
│   └── ...
└── .comfyui-launcher          # Marker file
```

#### Environment Archive Build Pipeline (CI)

Each archive is built per platform+GPU combination and hosted on GitHub Releases or a CDN.

Build steps (to be implemented as GitHub Actions):
1. Download python-build-standalone release for the target platform
2. Create a virtual environment or install directly into the standalone Python's site-packages
3. `pip install` (or `uv pip install`) the correct GPU-specific PyTorch wheels + ComfyUI requirements
4. Strip unnecessary files to reduce size (e.g., `torch/lib/dnnl.lib`, test directories, `__pycache__`)
5. Package as `.tar.zst` (Linux/macOS) or `.7z` (Windows) for best compression
6. Upload as release artifacts

#### Target Archive Matrix

| Archive ID | OS | GPU | Python | PyTorch Index |
|---|---|---|---|---|
| `win-nvidia-cu130` | Windows x64 | NVIDIA (CUDA 13.0) | 3.12 | `cu130` |
| `win-nvidia-cu128` | Windows x64 | NVIDIA (CUDA 12.8) | 3.12 | `cu128` |
| `win-nvidia-cu126` | Windows x64 | NVIDIA (CUDA 12.6) | 3.12 | `cu126` |
| `win-intel-xpu` | Windows x64 | Intel Arc (XPU) | 3.12 | `xpu` |
| `win-amd` | Windows x64 | AMD (CPU baseline) | 3.12 | `cpu` |
| `win-cpu` | Windows x64 | CPU fallback | 3.12 | `cpu` |
| `mac-mps` | macOS arm64 | Apple Silicon (MPS) | 3.12 | default (MPS built-in) |
| `linux-nvidia-cu130` | Linux x64 | NVIDIA (CUDA 13.0) | 3.12 | `cu130` |
| `linux-nvidia-cu128` | Linux x64 | NVIDIA (CUDA 12.8) | 3.12 | `cu128` |
| `linux-nvidia-cu126` | Linux x64 | NVIDIA (CUDA 12.6) | 3.12 | `cu126` |
| `linux-intel-xpu` | Linux x64 | Intel Arc (XPU) | 3.12 | `xpu` |
| `linux-amd` | Linux x64 | AMD (ROCm 6.2.4) | 3.12 | `rocm6.2.4` |
| `linux-cpu` | Linux x64 | CPU fallback | 3.12 | `cpu` |

#### Launcher-Side Install Flow

1. `detectGPU()` + `process.platform` → select the correct archive ID
2. Download the environment archive (with progress reporting)
3. Extract to install directory
4. `git clone --depth 1` ComfyUI into the `ComfyUI/` subdirectory
5. Write `.comfyui-launcher` marker file

#### Launch Command

```
python/bin/python -s ComfyUI/main.py [launchArgs]
```

The `-s` flag prevents system site-packages from interfering. The standalone Python's own site-packages contain all dependencies.

#### Resolved Decisions

- **Hosting:** GitHub Releases on the ComfyUI-Launcher repo (2GB per asset limit; archives should fit)
- **Archive format:** `.7z` on Windows (best compression for executables via LZMA2), `.tar.gz` on Linux/macOS
- **Python-build-standalone variant:** `install_only` (smaller, includes pip via ensurepip, no build tools)
- **Git requirement:** `pygit2` is included in the environment; the launcher can use it for cloning without requiring system git
- **Size optimization:** Strip `__pycache__`, test directories, and large unused torch libs (dnnl.lib, libprotoc.lib, libprotobuf.lib). Do NOT strip `.dist-info` — these are needed by `importlib.metadata` for package dependency checks at runtime.
- **CI workflow:** `.github/workflows/build-standalone-env.yml` — manually dispatched, builds all 7 platform+GPU variants in parallel, uploads to a tagged GitHub Release

#### Open Questions

- **Versioning:** How to version/tag archives so the launcher knows which version is installed and when updates are available
- **Archive sizes:** Need to verify that CUDA-heavy archives (win-nvidia, linux-nvidia) fit within the 2GB GitHub Release asset limit after compression. If not, split into environment + wheels, or use a CDN.
- **Windows AMD:** ROCm on Windows is experimental. Currently building with CPU wheels; users can upgrade to ROCm nightly post-install. Revisit when official ROCm Windows wheels stabilize.

### 3. Git (`sources/git.js`) — Cross-platform, network-dependent

Clones ComfyUI from a Git repository and uses `uv` to install a Python environment + dependencies from the network. Intended for users with reliable network connections who want fine-grained control over branches, commits, and dependencies.

- **Platforms:** All (wherever Python + git are available, or where `uv` can manage them)
- **Pros:** Always up-to-date; user picks exact branch/commit; lightweight initial download for the launcher itself
- **Cons:** Network-dependent for both install and updates; pip/uv failures possible in restricted network environments
- **Status:** Partial (form fields + GitHub API polling implemented; `install()` and `getLaunchCommand()` not yet implemented)

#### Planned Install Flow

1. Bundle `uv` binary per platform in `assets/uv/`
2. `uv venv --python 3.12 --python-preference only-managed` — downloads Python and creates venv
3. `uv pip install -r requirements.compiled` — installs GPU-specific pre-compiled requirements
4. `git clone` the selected repo/branch/commit
5. Write `.comfyui-launcher` marker file

## Known Debt

(None currently tracked.)

## Modularity Review Checklist

When reviewing code for modularity, check:

1. **Is any source-specific logic in the renderer?** Move it to the source module's data/metadata.
2. **Is any file doing two unrelated things?** Split it.
3. **Is the same value defined in two places?** Derive it from a single source of truth.
4. **Is a utility duplicated across modules?** Extract to `lib/`.
5. **Does a renderer view contain hardcoded conditionals for specific action/source IDs?** Replace with a data-driven pattern (add a property to the schema).
6. **Does a source repeat information already available from its own definition?** Have the framework (ipc.js) inject it.
7. **Can a new source be added by only creating a file in `sources/` and registering it in `sources/index.js`?** If not, something is coupled.
