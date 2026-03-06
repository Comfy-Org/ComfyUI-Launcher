# Model Management & Downloads Panel Plan

## Goal

Bring the desktop/ComfyUI_frontend model management experience into the
Launcher's **Models** view, and add a global **Downloads sidebar panel** — a
toggleable drawer docked to the left sidebar (like browser download drawers, or
the existing `comfyContentScript.ts` floating toast in the ComfyUI windows).

---

## Current State

### What the Launcher already has
- **`ModelsView.vue`** — shows configured model directories with DirCard
  widgets (browse, add, remove, reorder). No model file listing, no browsing,
  no search.
- **`DownloadsPanel.vue`** — renders active & finished downloads as inline
  cards. Currently embedded *inside* ModelsView at the bottom.
- **`downloadStore.ts`** — Pinia store that subscribes to
  `model-download-progress` IPC events from the main process and tracks them
  in a reactive `Map<url, ModelDownloadProgress>`.
- **`comfyDownloadManager.ts`** (main process) — handles Electron
  `will-download`, temp files, managed model downloads and general
  browser-like downloads. Broadcasts progress to both the originating
  ComfyUI window and the Launcher window.
- **`comfyContentScript.ts`** — injected into ComfyUI webview pages; creates a
  floating download toast panel with a collapsible tab, drag-to-undock, and
  inline pause/resume/cancel buttons. Theme-aware.

### What the desktop app / frontend has
- **`DownloadManager.ts`** (desktop) — singleton managing `.safetensors`
  downloads via Electron `session.downloadURL`. IPC handlers for start / pause
  / resume / cancel / getAllDownloads / deleteModel.
- **`AssetBrowserModal.vue`** — full model browser with search, left nav by
  category, filter bar (architecture, ownership), asset grid, right info panel.
  Uses `useAssetBrowser`, `useModelTypes`, `useModelUpload` composables.
- **`UploadModelDialog.vue`** — 3-step wizard: enter URL → confirm metadata →
  upload progress.
- **`ModelImportProgressDialog.vue`** — uses `HoneyToast` (expandable toast)
  with `ProgressToastItem` cards, filter popover (all/completed/failed).
- **`modelStore.ts`** — `ComfyModelDef` class (metadata from safetensors),
  `ModelFolder` (lazy-load per directory). Loaded from ComfyUI API.

---

## Design

### 1. Downloads Sidebar Panel (global, always accessible)

Replace the current approach of embedding `DownloadsPanel` inside `ModelsView`
with a **sidebar-attached drawer** that is accessible from any view.

**Behaviour:**
- A persistent **download indicator** appears in the sidebar when there are
  active or recent downloads — a small icon/badge next to the Models tab (this
  already exists as `sidebar-count`).
- Clicking the indicator (or a dedicated button) toggles a **drawer panel**
  that slides out from the left sidebar, overlaying the content area.
- The drawer stays open across view switches. Clicking outside or pressing
  Escape closes it.
- The drawer shows the same content currently in `DownloadsPanel.vue`: active
  downloads with progress bars, pause/resume/cancel, and finished downloads
  with dismiss/show-in-folder.

**Implementation:**

| Layer | File | Change |
|-------|------|--------|
| Component | `src/renderer/src/components/DownloadsDrawer.vue` | **New.** Renders a slide-out drawer panel anchored to the sidebar. Reuses all the formatting logic from `DownloadsPanel.vue` (move or import). Add a close button and "clear completed" button in the header. |
| App shell | `src/renderer/src/App.vue` | Add `<DownloadsDrawer>` alongside the sidebar. Add `downloadsDrawerOpen` ref. Wire sidebar indicator click to toggle it. Remove `<DownloadsPanel>` from ModelsView embedding. |
| View | `src/renderer/src/views/ModelsView.vue` | Remove the `<DownloadsPanel />` include (downloads move to the global drawer). |
| Style | `src/renderer/src/assets/main.css` | Add `.downloads-drawer` styles: fixed position left of content, slide transition, backdrop, z-index layering. |
| Store | `downloadStore.ts` | No changes needed — already provides the reactive data. |

**Drawer visual spec:**
```
┌──────────┬──────────────────┬──────────────────────┐
│ Sidebar  │ Downloads Drawer │ Content area (dimmed) │
│          │ ┌──────────────┐ │                       │
│ ● Dash   │ │ Downloads    │ │                       │
│   Inst   │ │              │ │                       │
│   Run    │ │ [card]       │ │                       │
│ ● Models │ │ [card]       │ │                       │
│   Media  │ │ [card]       │ │                       │
│   Sett   │ └──────────────┘ │                       │
└──────────┴──────────────────┴──────────────────────┘
```

Width: ~340px. Background: `var(--surface)`. Border-right: `var(--border)`.

### 2. Model Browser in ModelsView

Replace the current directory-card-only Models view with a tabbed layout:

**Tab 1: "Directories"** (current content) — model directory configuration.

**Tab 2: "Browse Models"** — a file browser that lists model files in the
configured directories, grouped by folder type.

**Implementation:**

| Layer | File | Change |
|-------|------|--------|
| IPC type | `src/types/ipc.ts` | Add `ModelFileInfo` type (`name`, `directory`, `sizeBytes`, `modified`). Add `getModelFiles(directory: string): Promise<ModelFileInfo[]>` to `ElectronApi`. |
| Main | `src/main/lib/models.ts` | Add `listModelFiles(baseDir, directory)` function that scans a model subdirectory and returns file info. |
| Main IPC | `src/main/lib/ipc.ts` | Register `get-model-files` handler. |
| Preload | `src/preload/index.ts` | Expose `getModelFiles`. |
| Component | `src/renderer/src/components/ModelBrowser.vue` | **New.** Left sidebar listing model folder types (`checkpoints`, `loras`, etc. from `MODEL_FOLDER_TYPES`). Main area shows a file list/grid for the selected folder. Search bar at top. File cards show name, size, date. |
| Component | `src/renderer/src/components/ModelFileCard.vue` | **New.** Single model file card — name, size, modified date, "Show in Folder" button, optional delete button. |
| View | `src/renderer/src/views/ModelsView.vue` | Add tab switcher (Directories / Browse). Conditionally render `ModelBrowser` or the existing dir-card content. |

### 3. Download from URL (stretch)

Add the ability to initiate a model download from the Launcher's Models view
(similar to the frontend's `UploadModelDialog` wizard).

| Layer | File | Change |
|-------|------|--------|
| Component | `src/renderer/src/components/DownloadModelDialog.vue` | **New.** Simple dialog: URL input, destination folder dropdown (from `MODEL_FOLDER_TYPES`), optional filename override, Download button. |
| Main | `src/main/lib/comfyDownloadManager.ts` | Add a `startLauncherDownload(url, filename, directory)` variant that works from the Launcher window directly (not from a ComfyUI webview). The infrastructure is already there — we just need an IPC handler that calls `startModelDownload` with the launcher window. |
| Preload | `src/preload/index.ts` | Expose `startModelDownload(url, filename, directory)`. |
| IPC type | `src/types/ipc.ts` | Add `startModelDownload` to `ElectronApi`. |

---

## Implementation Order

1. **Phase 1: Downloads Drawer** — Extract `DownloadsPanel` into
   `DownloadsDrawer`, wire it into the App shell sidebar. This is the most
   impactful UX improvement and is self-contained.

2. **Phase 2: Model Browser** — Add the file-listing backend IPC + the
   `ModelBrowser` component in `ModelsView`.

3. **Phase 3: Download from URL** — Add the download dialog and
   launcher-initiated download path.

---

## Notes

- The Launcher already uses `lucide-vue-next` for sidebar icons — use the same
  for the drawer's close/clear/folder icons.
- The existing CSS design system (`--surface`, `--border`, `--accent`, etc.)
  should be used throughout — no new design tokens needed.
- The drawer should work with all existing themes (dark, light, nord, etc.).
- The `comfyContentScript.ts` floating toast in ComfyUI windows is independent
  and should NOT be changed — it serves a different context (inside the
  webview).
- General (non-model) downloads already flow through the same pipeline via the
  `will-download` fallback in `comfyDownloadManager.ts`, so the drawer will
  automatically show those too.
